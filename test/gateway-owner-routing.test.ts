import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, realpath, mkdir, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
import { Gateway, type SendblueProvider, type GatewayFiles, type GatewaySession } from "../src/gateway.js";
import { createGatewayServer, listenGateway, closeGatewayServer } from "../src/gateway-server.js";
import { GatewayFilePlane } from "../src/gateway-files.js";
import { GatewayStore } from "../src/gateway-state.js";
import { RouterError } from "../src/errors.js";
import type { TurnOutcome } from "../src/turn-state.js";

class OwnerSession implements GatewaySession {
  backend: "desktop" | "proxy" | "stdio" = "desktop";
  capabilities = { steer: true };
  serverInfo = { codexHome: "/tmp/owner-home", platformFamily: "unix", platformOs: "darwin" };
  artifactBaseline: string[] = [];
  busy = false;
  admissions: Array<{ input: unknown; intent: Record<string, unknown> }> = [];
  restores: unknown[][] = [];
  closed = false;
  turnId = "accepted-turn";
  beforeAdmission?: () => void | Promise<void>;
  admissionError?: RouterError;
  private finishObservation!: (value: TurnOutcome) => void;
  private outcome = new Promise<TurnOutcome>((resolve) => { this.finishObservation = resolve; });
  async filesystem() { return {}; }
  async resume() {
    const activeTurn = { id: "external-turn", status: "inProgress", items: [] };
    return { thread: { status: { type: this.busy ? "active" : "idle" }, turns: this.busy ? [activeTurn] : [] }, ...(this.busy ? { activeTurn } : {}) };
  }
  async admit(input: unknown, intent: unknown) {
    await this.beforeAdmission?.();
    this.admissions.push({ input, intent: intent as Record<string, unknown> });
    if (this.admissionError) throw this.admissionError;
    return this.turnId;
  }
  async restore(...args: unknown[]) { this.restores.push(args); return this.turnId; }
  observe() { return this.outcome; }
  complete(text = "eligible answer") { this.finishObservation({ turnId: this.turnId, status: "completed", finalText: text, imageGenerations: [] }); }
  async close() { this.closed = true; this.finishObservation({ turnId: this.turnId, status: "interrupted", imageGenerations: [] }); }
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "gateway-owner-routing-")));
  const config = parseConfig(`
[[agents]]
id="agent"
label="Agent"
cwd="/tmp"
thread_id="thread"
model="test"
[gateway]
listen_port=8787
public_url="https://example.com"
state_dir=${JSON.stringify(directory)}
[[gateway.sendblue]]
mode="webhook"
id="account"
api_key_id_env="KEY"
api_secret_key_env="SECRET"
webhook_secret_env="SIGNING"
[[gateway.routes]]
id="route"
sendblue="account"
sender="+15125550100"
sendblue_number="+15125550200"
agent="agent"
`).gateway!;
  let store = await GatewayStore.open(directory);
  let next = new OwnerSession();
  let connectError: RouterError | undefined;
  let now = Date.now();
  let opens = 0;
  let unresolvedSend = false;
  let releaseFinished = false;
  let retryDelayMs = 60_000;
  const sends: string[] = [];
  const deliveries: TurnOutcome[] = [];
  const connector: SendblueProvider = {
    signingSecret: "fixture",
    inbound() { return undefined; },
    callback() { return { status: "SENT" }; },
    async send(_route, part) {
      sends.push(part.id);
      return unresolvedSend ? { status: "uncertain", retryable: false } : { status: "accepted", providerHandle: part.id };
    },
    async upload() { return "https://example.com/file"; },
    async typing() {},
  };
  const files: GatewayFiles = {
    async cleanup() {}, async reconcile() {},
    async prepareBatch(_route, batch) { return batch; },
    async publication() { return "/tmp/owner-publication"; },
    async delivery(_route, _work, outcome) {
      deliveries.push(outcome);
      return [{ id: `part-${deliveries.length}`, status: "ready", payload: { kind: "text", text: outcome.finalText ?? "empty" } }];
    },
    async release(_route, work, session) {
      if (work.kind === "codex") {
        assert.equal((session as OwnerSession).closed, false, "host cleanup needs the execution session");
        releaseFinished = true;
      }
    },
  };
  const gateways: Gateway[] = [];
  function create() {
    const gateway = new Gateway(config, store, {
      connector: () => connector, files, now: () => now, retryDelayMs: () => retryDelayMs,
      openSession: async () => { opens++; if (connectError) throw connectError; return next; },
    });
    gateways.push(gateway);
    return gateway;
  }
  const gateway = create();
  return {
    directory, get store() { return store; }, gateway, create, files, connector, sends, deliveries,
    async reopenStore() { await store.close(); store = await GatewayStore.open(directory); },
    get session() { return next; }, set session(value: OwnerSession) { next = value; },
    get opens() { return opens; },
    get connectError() { return connectError; }, set connectError(value: RouterError | undefined) { connectError = value; },
    set unresolvedSend(value: boolean) { unresolvedSend = value; },
    get releaseFinished() { return releaseFinished; },
    set retryDelayMs(value: number) { retryDelayMs = value; },
    async receive(handle: string, target = gateway) {
      await target.receive("account", { messageHandle: handle, sender: "+15125550100", sendblueNumber: "+15125550200", providerTimeMs: now, text: handle });
      now += 5001; target.wake("route"); await target.idle();
    },
    async close() { for (const item of gateways) await item.close(); await store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), message);
}
function workRecord(store: GatewayStore): Record<string, unknown> {
  const work = store.snapshot().routes.route!.active;
  assert.equal(work?.kind, "codex");
  return work as unknown as Record<string, unknown>;
}

test("Desktop busy input steers its active owner immediately", async () => {
  const f = await fixture();
  try {
    f.session.busy = true; await f.gateway.start(); await f.receive("first");
    assert.equal(f.session.admissions.length, 1);
    assert.equal(f.session.admissions[0]!.intent.expectedTurnId, "external-turn");
    assert.equal(f.store.snapshot().routes.route!.queue.length, 0);
  } finally { await f.close(); }
});

test("Desktop follow-ups preserve the existing turn and response owner", async () => {
  const f = await fixture();
  try {
    f.session.turnId = "external-race-winner";
    await f.gateway.start(); await f.receive("first"); await f.receive("second");
    assert.equal(f.session.admissions.length, 2);
    assert.equal(f.session.admissions[1]!.intent.expectedTurnId, "external-race-winner");
    assert.equal(workRecord(f.store).turnId, "external-race-winner");
    assert.equal(f.store.snapshot().routes.route!.queue.length, 0);
    f.session.complete("combined answer");
    await until(() => f.deliveries.length === 1, "one shared response");
    assert.equal(f.deliveries[0]!.finalText, "combined answer");
  } finally { await f.close(); }
});

test("a connection without steering reports blocked instead of waiting for turn completion", async () => {
  const f = await fixture();
  try {
    f.session.capabilities.steer = false; f.session.busy = true;
    await f.gateway.start(); await f.receive("first");
    assert.equal(f.session.admissions.length, 0);
    assert.equal(f.gateway.processingStatus()[0]!.state, "blocked");
  } finally { await f.close(); }
});

test("execution identity and correlation UUID are durable before the Desktop request can escape", async () => {
  const f = await fixture();
  let inspected = false;
  try {
    f.session.beforeAdmission = async () => {
      const work = workRecord(f.store);
      assert.deepEqual(work.binding, { backend: "desktop", host: "local", codexHome: "/tmp/owner-home", threadId: "thread" });
      const pending = work.pendingAdmission as Record<string, unknown>;
      assert.equal(work.clientUserMessageId, pending.clientUserMessageId);
      assert.ok(work.clientUserMessageId);
      const durable = JSON.parse(await readFile(join(f.directory, "state.json"), "utf8"));
      assert.deepEqual(durable.routes.route.active, work); inspected = true;
    };
    await f.gateway.start(); await f.receive("first"); assert.ok(inspected);
  } finally { await f.close(); }
});

test("lost Desktop admission acknowledgment survives restart without replaying input", async () => {
  const f = await fixture();
  try {
    f.session.admissionError = new RouterError("timeout", "ack lost", { ambiguous: true });
    await f.gateway.start(); await f.receive("first");
    const uuid = f.session.admissions[0]!.intent.clientUserMessageId;
    await f.gateway.close(); await f.reopenStore(); f.session = new OwnerSession();
    const restarted = f.create(); await restarted.start(); await restarted.idle();
    assert.equal(f.session.admissions.length, 0); assert.equal(f.session.restores.length, 1);
    assert.equal(f.session.restores[0]![3], uuid);
    f.session.complete("recovered response"); await until(() => f.sends.length === 1, "recovered reply should publish"); await restarted.idle();
    await f.receive("first", restarted);
    assert.equal(f.session.admissions.length, 0); assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});

test("recovery cannot restore or reconcile saved work in a different Codex home", async () => {
  const f = await fixture();
  try {
    await f.gateway.start(); await f.receive("first"); await f.gateway.close(); await f.reopenStore();
    f.session = new OwnerSession(); f.session.serverInfo.codexHome = "/tmp/different-owner-home";
    let reconciled = false; f.files.reconcile = async () => { reconciled = true; };
    const restarted = f.create(); await restarted.start(); await restarted.idle();
    assert.equal(f.session.admissions.length, 0); assert.equal(f.session.restores.length, 0); assert.equal(reconciled, false);
    assert.equal(workRecord(f.store).turnId, "accepted-turn"); assert.equal(f.sends.length, 0);
  } finally { await f.close(); }
});

test("pre-admission connection recovery retains input and retries without another webhook", async () => {
  const f = await fixture();
  try {
    f.retryDelayMs = 20;
    f.connectError = new RouterError("app_server_connect_failed", "temporarily unavailable");
    await f.gateway.start(); await f.receive("first");
    assert.equal(f.store.snapshot().routes.route!.queue.length, 1); assert.equal(f.session.admissions.length, 0);
    f.connectError = undefined;
    await until(() => f.session.admissions.length === 1, "connection recovery should retry retained input");
    assert.ok(f.opens >= 2); assert.equal(f.store.snapshot().routes.route!.receipts!.length, 1);
  } finally { await f.close(); }
});

test("prepared response releases execution ownership while provider acceptance stays unresolved", async () => {
  const f = await fixture();
  try {
    f.session.backend = "stdio"; f.unresolvedSend = true;
    await f.gateway.start(); await f.receive("first"); f.session.complete();
    await until(() => f.sends.length === 1, "response should be submitted"); await f.gateway.idle();
    assert.ok(f.releaseFinished); assert.ok(f.session.closed);
    const active = f.store.snapshot().routes.route!.active;
    assert.equal(active?.kind, "delivery");
    if (active?.kind === "delivery") assert.equal(active.parts[0]!.status, "sending");
  } finally { await f.close(); }
});


test("a recovered direct admission uses the restored turn ID for queued follow-up input", async () => {
  const f = await fixture();
  try {
    f.session.backend = "proxy"; f.session.capabilities.steer = true;
    f.session.admissionError = new RouterError("timeout", "ack lost", { ambiguous: true });
    await f.gateway.start(); await f.receive("first"); await f.receive("second"); await f.gateway.close(); await f.reopenStore();
    f.session = new OwnerSession(); f.session.backend = "proxy"; f.session.capabilities.steer = true;
    f.session.turnId = "restored-authoritative-turn";
    const restarted = f.create(); await restarted.start(); await restarted.idle();
    assert.equal(f.session.restores.length, 1);
    assert.equal(f.session.admissions.length, 1);
    assert.equal(f.session.admissions[0]!.intent.expectedTurnId, "restored-authoritative-turn");
    assert.equal(workRecord(f.store).turnId, "restored-authoritative-turn");
  } finally { await f.close(); }
});

test("processing status requires authentication and separates retrying execution from intake readiness", async () => {
  const f = await fixture(); const server = createGatewayServer(f.gateway);
  try {
    f.connectError = new RouterError("app_server_connect_failed", "sensitive host path or message");
    await f.gateway.start(); await f.receive("private message text"); await listenGateway(server, 0);
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${url}/statusz`)).status, 401);
    assert.equal((await fetch(`${url}/statusz`, { headers: { "sb-signing-secret": "wrong" } })).status, 401);
    const response = await fetch(`${url}/statusz`, { headers: { "sb-signing-secret": "fixture" } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ready: true, routes: [{ routeId: "route", state: "retrying", code: "app_server_connect_failed" }] });
    assert.deepEqual(await (await fetch(`${url}/readyz`)).json(), { ready: true });
  } finally { await closeGatewayServer(server); await f.close(); }
});


test("Desktop preflight failure after attachment preparation leaves input queued without an admission intent", async () => {
  const f = await fixture();
  try {
    let prepared = false; let published = false;
    f.files.prepareBatch = async (_route, batch) => { prepared = true; return batch; };
    f.files.publication = async () => { published = true; return "/tmp/publication"; };
    f.session.resume = async () => {
      assert.ok(prepared);
      const saved = JSON.parse(await readFile(join(f.directory, "state.json"), "utf8"));
      assert.equal(saved.routes.route.queue.length, 1);
      assert.equal(saved.routes.route.active, undefined);
      throw new RouterError("app_server_disconnected", "preflight disconnected before input submission");
    };
    await f.gateway.start(); await f.receive("first");
    assert.equal(published, false); assert.equal(f.session.admissions.length, 0);
    assert.equal(f.store.snapshot().routes.route!.active, undefined);
    assert.equal(f.store.snapshot().routes.route!.queue.length, 1);
    assert.equal(f.gateway.processingStatus()[0]!.state, "retrying");
  } finally { await f.close(); }
});

test("a disconnected file-plane reconciliation retries with a healthy session and retained input", async () => {
  const f = await fixture();
  try {
    const home = join(f.directory, "home"); await mkdir(home);
    const plane = new GatewayFilePlane(f.directory);
    f.files.cleanup = plane.cleanup.bind(plane); f.files.reconcile = plane.reconcile.bind(plane);
    f.files.prepareBatch = plane.prepareBatch.bind(plane); f.files.publication = plane.publication.bind(plane);
    f.retryDelayMs = 20; f.session.serverInfo.codexHome = home;
    let failedCalls = 0; let healthyCalls = 0;
    f.session.filesystem = async () => { failedCalls++; throw new RouterError("app_server_disconnected", "initial filesystem request disconnected"); };
    await f.gateway.start(); await f.receive("first");
    assert.equal(failedCalls, 1); assert.equal(f.session.admissions.length, 0);
    assert.equal(f.store.snapshot().routes.route!.queue.length, 1);
    const healthy = new OwnerSession(); healthy.serverInfo.codexHome = home;
    // This adapter performs the real temporary-directory operations requested by
    // GatewayFilePlane. Only the first session's disconnect is injected.
    const session: GatewaySession = healthy;
    session.filesystem = async (method, params) => {
      healthyCalls++;
      const p = params as { path: string; recursive?: boolean; force?: boolean };
      if (method === "fs/createDirectory") { await mkdir(p.path, { recursive: p.recursive ?? false }); return {}; }
      if (method === "fs/remove") { await rm(p.path, { recursive: p.recursive ?? false, force: p.force ?? false }); return {}; }
      if (method === "fs/readDirectory") return { entries: (await readdir(p.path, { withFileTypes: true })).map(entry => ({ fileName: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() })) };
      const stat = await lstat(p.path); return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymlink: stat.isSymbolicLink() };
    };
    f.session = healthy;
    await until(() => healthy.admissions.length === 1, "a fresh session must retry filesystem reconciliation");
    assert.ok(healthyCalls > 1); assert.ok(f.opens >= 2); assert.equal(failedCalls, 1);
    assert.equal(f.store.snapshot().routes.route!.queue.length, 0);
    assert.equal(f.store.snapshot().routes.route!.receipts!.length, 1);
  } finally { await f.close(); }
});

test("authenticated processing status distinguishes an active send from unresolved delivery across restart", async () => {
  const f = await fixture();
  let gateway = f.gateway; let server = createGatewayServer(gateway);
  let finishSend!: () => void;
  let physicalSends = 0;
  f.connector.send = async () => {
    physicalSends++;
    await new Promise<void>(resolve => { finishSend = resolve; });
    return { status: "uncertain", retryable: false };
  };
  async function status() {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/statusz`, { headers: { "sb-signing-secret": "fixture" } });
    assert.equal(response.status, 200);
    return (await response.json() as { routes: Array<{ state: string }> }).routes[0]!.state;
  }
  try {
    await gateway.start(); await listenGateway(server, 0); await f.receive("first"); f.session.complete();
    await until(() => physicalSends === 1, "the provider request should start");
    assert.equal(await status(), "running");
    finishSend(); await gateway.idle();
    assert.equal(await status(), "unresolved");
    await closeGatewayServer(server); await gateway.close(); await f.reopenStore();
    gateway = f.create(); server = createGatewayServer(gateway);
    await gateway.start(); await gateway.idle(); await listenGateway(server, 0);
    assert.equal(await status(), "unresolved"); assert.equal(physicalSends, 1);
    const delivery = f.store.snapshot().routes.route!.active;
    assert.equal(delivery?.kind, "delivery");
    if (delivery?.kind !== "delivery") assert.fail("expected unresolved delivery");
    const part = delivery.parts[0]!;
    await gateway.callback("account", part.id, part.callbackToken!, { status: "DELIVERED", providerHandle: "accepted" });
    await gateway.idle(); assert.equal(await status(), "idle"); assert.equal(physicalSends, 1);
  } finally {
    finishSend?.();
    if (server.listening) await closeGatewayServer(server);
    await f.close();
  }
});

test("an early retry timer reschedules without bypassing the external wake backoff", async (t) => {
  const f = await fixture();
  let wallClock = Date.now();
  t.mock.method(Date, "now", () => wallClock);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    f.retryDelayMs = 10;
    f.connectError = new RouterError("app_server_connect_failed", "temporarily unavailable");
    await f.gateway.start(); await f.receive("first");
    assert.equal(f.opens, 1);
    f.connectError = undefined;
    // Timer time and Date.now() need not reach their deadlines together. Force
    // the first callback to run before the wall-clock admission deadline.
    t.mock.timers.tick(10);
    await f.gateway.idle();
    f.gateway.wake("route"); await f.gateway.idle();
    assert.equal(f.opens, 1, "an early callback or webhook must respect backoff");
    wallClock += 10;
    t.mock.timers.tick(10);
    await f.gateway.idle();
    assert.equal(f.opens, 2, "the early callback must leave a future retry scheduled");
    assert.equal(f.session.admissions.length, 1);
  } finally { await f.close(); t.mock.timers.reset(); }
});
