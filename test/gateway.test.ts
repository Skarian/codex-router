import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { parseConfig, type GatewayConfig } from "../src/config.js";
import { Gateway, type SendblueProvider, type GatewayFiles, type GatewaySession, type SendOutcome } from "../src/gateway.js";
import { GatewayStore, bindRoutes, resolveEffect, unresolved, type Delivery, type GatewayState } from "../src/gateway-state.js";
import { createGatewayServer, listenGateway, closeGatewayServer } from "../src/gateway-server.js";
import type { TurnOutcome } from "../src/turn-state.js";
import { sendblueCredentials, sendblueConnectors } from "../src/sendblue.js";
import { RouterError } from "../src/errors.js";

function configSource(directory: string): string {
  return `
[[agents]]
id="one"
label="One"
cwd="/tmp"
thread_id="thread-one"
model="test"
[gateway]
listen_port=8787
public_url="https://example.exe.xyz"
state_dir=${JSON.stringify(directory)}
[[gateway.sendblue]]
id="account"
mode="webhook"
api_key_id_env="KEY"
api_secret_key_env="SECRET"
webhook_secret_env="SIGNING"
[[gateway.routes]]
id="route"
sendblue="account"
sender="+15125550100"
sendblue_number="+15125550200"
agent="one"
`;
}
function configuration(directory: string): GatewayConfig { return parseConfig(configSource(directory)).gateway!; }

class FakeSession implements GatewaySession {
  serverInfo = { codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux" };
  artifactBaseline: string[] = [];
  admissions: unknown[] = [];
  restores: unknown[] = [];
  finish!: (outcome: TurnOutcome) => void;
  private done = new Promise<TurnOutcome>((resolve) => { this.finish = resolve; });
  async filesystem() { return {}; }
  async resume() { return { thread: { status: { type: "idle" }, turns: [] } }; }
  async admit(input: unknown, intent: unknown) { this.admissions.push({ input, intent }); return "owned"; }
  async restore(...args: unknown[]) { this.restores.push(args); return "owned"; }
  observe() { return this.done; }
  async close() { this.finish({ turnId: "owned", status: "interrupted", imageGenerations: [] }); }
}

async function fixture(beforeWrite?: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-test-"));
  const config = configuration(directory);
  const store = await GatewayStore.open(directory, beforeWrite);
  const session = new FakeSession();
  const sends: unknown[] = [];
  const typing: string[] = [];
  const connector: SendblueProvider = {
    signingSecret: "test-signing-secret",
    inbound(value) {
      const record = value as { messageHandle?: string; ignored?: boolean };
      if (record.ignored) return undefined;
      if (!record.messageHandle) throw new Error("invalid");
      return { messageHandle: record.messageHandle, sender: "+15125550100", sendblueNumber: "+15125550200", providerTimeMs: Date.now(), text: "hello" };
    },
    callback(value) { const record = value as { status?: string; providerHandle?: string }; if (!record.status) throw new Error("invalid"); return { status: record.status, ...(record.providerHandle ? { providerHandle: record.providerHandle } : {}) }; },
    async send(_route, part) { sends.push(part); return { status: "accepted", providerHandle: `handle-${sends.length}` }; },
    async upload() { return "https://example.com/file"; },
    async typing(_route, state) { typing.push(state); },
  };
  const files: GatewayFiles = {
    async cleanup() {}, async reconcile() {}, async prepareBatch(_route, batch) { return batch; },
    async publication() { return "/tmp/publication"; },
    async delivery(_route, _work, outcome) { return [{ id: "part", status: "ready", payload: { kind: "text", text: outcome.finalText ?? "empty" } }]; },
  };
  let now = Date.now();
  const gateway = new Gateway(config, store, { connector: () => connector, files, openSession: async () => session, now: () => now });
  return { directory, config, store, session, connector, files, gateway, sends, typing,
    advance(ms: number) { now += ms; gateway.wake("route"); },
    async receive(handle: string) { await gateway.receive("account", { messageHandle: handle, sender: "+15125550100", sendblueNumber: "+15125550200", providerTimeMs: now, text: handle }); },
    async close() { await gateway.close(); await store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function delivery(): Delivery {
  return { kind: "delivery", id: "delivery", sourceId: "sendblue:account", batchIds: ["batch"], parts: [
    { id: "part-one", status: "ready", payload: { kind: "text", text: "first" } },
    { id: "part-two", status: "ready", payload: { kind: "text", text: "second" } },
  ] };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  assert.fail("condition did not become true");
}

test("gateway batches quiet input, deduplicates, and shares one response across steers", async () => {
  const f = await fixture();
  try {
    await f.gateway.start(); await f.receive("first"); await f.receive("first");
    f.advance(4000); await f.receive("second"); await f.gateway.idle();
    assert.equal(f.session.admissions.length, 0);
    assert.equal(f.store.snapshot().routes.route!.openBatch!.events.length, 2);
    f.advance(5000); await f.gateway.idle();
    assert.equal(f.session.admissions.length, 1);
    await f.receive("third"); f.advance(5000); await f.gateway.idle();
    assert.equal(f.session.admissions.length, 2);
    const work = f.store.snapshot().routes.route!.active!;
    assert.equal(work.kind, "codex");
    if (work.kind === "codex") { assert.equal(work.batches.length, 2); assert.equal(work.joinedBatchIds.length, 1); }
    assert.equal(f.sends.length, 0);
    f.session.finish({ turnId: "owned", status: "completed", finalText: "one answer", imageGenerations: [] });
    await until(() => f.sends.length === 1); await f.gateway.idle();
    assert.equal(f.store.snapshot().routes.route!.active, undefined);
    assert.ok(f.typing.includes("start")); assert.ok(f.typing.includes("stop"));
  } finally { await f.close(); }
});

test("maximum batch age closes continuous input after thirty seconds", async () => {
  const f = await fixture();
  try {
    await f.gateway.start();
    for (let i = 0; i < 8; i++) { await f.receive(String(i)); f.advance(4000); await f.gateway.idle(); }
    assert.equal(f.session.admissions.length, 1);
    assert.equal((f.session.admissions[0] as { input: unknown[] }).input.length, 8);
  } finally { await f.close(); }
});

test("concurrent state transactions preserve every update and failed writes do not acknowledge input", async () => {
  let fail = false;
  const f = await fixture(async () => { if (fail) throw new Error("disk full"); });
  try {
    await f.gateway.start();
    await Promise.all(Array.from({ length: 40 }, () => f.store.transaction((state) => { state.routes.route!.nextSequence++; })));
    assert.equal(f.store.snapshot().routes.route!.nextSequence, 40);
    fail = true;
    await assert.rejects(f.receive("not-stored"));
    assert.equal(f.store.snapshot().routes.route!.openBatch, undefined);
    fail = false;
    await f.receive("not-stored");
    assert.equal(f.store.snapshot().routes.route!.openBatch!.events.length, 1);
  } finally { await f.close(); }
});

test("pending route bindings reject every target or recipient change before cleanup", async () => {
  const f = await fixture();
  try {
    await f.gateway.start(); await f.receive("pending");
    const changes = [
      (c: GatewayConfig) => { c.routes[0]!.sender = "+15125550300"; },
      (c: GatewayConfig) => { c.routes[0]!.sendblueNumber = "+15125550400"; },
      (c: GatewayConfig) => { c.routes[0]!.sendblueId = "other"; },
      (c: GatewayConfig) => { c.routes[0]!.agent.threadId = "other"; },
      (c: GatewayConfig) => { c.routes[0]!.agent.cwd = "/other"; },
      (c: GatewayConfig) => { c.routes[0]!.agent.sshHost = "other"; },
      (c: GatewayConfig) => { c.routes = []; },
    ];
    for (const change of changes) {
      const config = structuredClone(f.config); change(config);
      assert.throws(() => bindRoutes(f.store.snapshot(), config), (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
    }
    const config = structuredClone(f.config); config.routes[0]!.agent.model = "another";
    assert.doesNotThrow(() => bindRoutes(f.store.snapshot(), config));
  } finally { await f.close(); }
});

test("an idle route rename preserves connector-wide deduplication", async () => {
  const f = await fixture();
  try {
    await f.gateway.start(); await f.receive("seen");
    await f.store.transaction((state) => { delete state.routes.route!.openBatch; });
    const config = structuredClone(f.config); config.routes[0]!.id = "renamed";
    await f.store.transaction((state) => bindRoutes(state, config));
    const gateway = new Gateway(config, f.store, f.gateway.operations);
    await gateway.start();
    await gateway.receive("account", { messageHandle: "seen", sender: "+15125550100", sendblueNumber: "+15125550200", providerTimeMs: Date.now(), text: "duplicate" });
    assert.equal(f.store.snapshot().routes.renamed!.openBatch, undefined);
    assert.equal(f.store.snapshot().routes.route!.receipts!.length, 1);
    await gateway.close();
  } finally { await f.close(); }
});

test("state lock rejects a live owner and permits reopening after close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-lock-"));
  try {
    const first = await GatewayStore.open(directory);
    await assert.rejects(GatewayStore.open(directory), { code: "gateway_running" });
    await first.close();
    const second = await GatewayStore.open(directory); await second.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("corrupt canonical state stops startup and is not replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-corrupt-"));
  try {
    await writeFile(join(directory, "state.json"), "broken", { mode: 0o600 });
    await assert.rejects(GatewayStore.open(directory));
    assert.equal(await readFile(join(directory, "state.json"), "utf8"), "broken");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("persisted sends never replay and negative restart callbacks cannot settle them", async () => {
  const f = await fixture();
  try {
    await f.store.transaction((state) => {
      bindRoutes(state, f.config); const active = delivery();
      active.parts[0]!.status = "sending"; active.parts[0]!.callbackToken = "token";
      state.routes.route!.active = active;
    });
    await f.gateway.start(); await f.gateway.idle(); assert.equal(f.sends.length, 0);
    assert.equal(await f.gateway.callback("account", "part-one", "wrong", { status: "SENT", providerHandle: "handle" }), false);
    await f.gateway.callback("account", "part-one", "token", { status: "ERROR" });
    assert.equal(unresolved(f.store.snapshot()).unresolved.length, 1);
    await f.gateway.callback("account", "part-one", "token", { status: "DELIVERED", providerHandle: "observed" });
    await f.gateway.idle();
    assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});

test("callback settlement waits for a live retry to drain before the next part", async () => {
  const f = await fixture(); let finishRetry!: (outcome: SendOutcome) => void; let calls = 0; let retrySignal: AbortSignal | undefined;
  f.connector.send = async (_route, _part, _url, signal) => {
    calls++;
    if (calls === 1) return { status: "rejected", retryable: true, retryAfterMs: 0 };
    if (calls === 2) { retrySignal = signal; return new Promise((resolve) => { finishRetry = resolve; }); }
    return { status: "accepted", providerHandle: "next" };
  };
  try {
    await f.store.transaction((state) => { bindRoutes(state, f.config); state.routes.route!.active = delivery(); });
    await f.gateway.start(); await until(() => calls === 2);
    const active = f.store.snapshot().routes.route!.active as Delivery;
    const token = active.parts[0]!.callbackToken!;
    await f.gateway.callback("account", "part-one", token, { status: "ERROR" });
    assert.equal((f.store.snapshot().routes.route!.active as Delivery).parts[0]!.status, "sending");
    await f.gateway.callback("account", "part-one", token, { status: "SENT", providerHandle: "known" });
    assert.equal(retrySignal!.aborted, true); assert.equal(calls, 2);
    finishRetry({ status: "uncertain", retryable: true });
    await f.gateway.idle(); assert.equal(calls, 3);
  } finally { await f.close(); }
});

test("failed settlement persistence retains the accepted handle for a later callback", async () => {
  let fail = false; let calls = 0;
  const f = await fixture(async () => { if (fail) throw new Error("disk full"); });
  f.connector.send = async () => { calls++; fail = true; return { status: "accepted", providerHandle: "original-handle" }; };
  try {
    await f.store.transaction((state) => { bindRoutes(state, f.config); const active = delivery(); active.parts.pop(); state.routes.route!.active = active; });
    await f.gateway.start(); await f.gateway.idle();
    const active = f.store.snapshot().routes.route!.active as Delivery;
    assert.equal(active.parts[0]!.status, "sending");
    fail = false;
    await f.gateway.callback("account", "part-one", active.parts[0]!.callbackToken!, { status: "SENT", providerHandle: "different-handle" });
    await f.gateway.idle(); assert.equal(calls, 1); assert.equal(f.store.snapshot().routes.route!.active, undefined);
  } finally { fail = false; await f.close(); }
});

test("operator resolution releases failed sends without retry and rejects stale effects", async () => {
  const f = await fixture();
  try {
    await f.store.transaction((state) => {
      bindRoutes(state, f.config); const active = delivery(); active.parts[0]!.status = "sending"; active.parts[0]!.callbackToken = "token";
      state.routes.route!.active = active;
    });
    await f.store.transaction((state) => resolveEffect(state, "route", "part-one", "failed"));
    assert.equal((f.store.snapshot().routes.route!.active as Delivery).parts[1]!.status, "skipped");
    await assert.rejects(f.store.transaction((state) => resolveEffect(state, "route", "part-one", "failed")));
    await f.gateway.start(); await f.gateway.idle(); assert.equal(f.sends.length, 0);
  } finally { await f.close(); }
});

test("HTTP authenticates before parsing and provides exact status and health responses", async () => {
  const f = await fixture(); const server = createGatewayServer(f.gateway);
  try {
    await listenGateway(server, 0);
    const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { ok: true });
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
    const post = (path: string, body: string, headers: Record<string, string> = {}) => fetch(`${url}${path}`, { method: "POST", body, headers });
    assert.equal((await post("/webhooks/sendblue/account", "broken")).status, 401);
    const auth = { "sb-signing-secret": f.connector.signingSecret, "content-type": "application/json" };
    assert.equal((await post("/webhooks/sendblue/account", "{}", auth)).status, 503);
    await f.gateway.start();
    assert.equal((await post("/webhooks/sendblue/account", "broken", auth)).status, 400);
    assert.equal((await post("/webhooks/sendblue/account", JSON.stringify({ messageHandle: "one" }), auth)).status, 204);
    assert.equal((await post("/webhooks/sendblue/account", "{}", { ...auth, "content-type": "text/plain" })).status, 415);
    assert.equal((await post("/webhooks/sendblue/missing", "{}", auth)).status, 404);
    assert.equal((await fetch(`${url}/webhooks/sendblue/account`)).status, 405);
    assert.equal((await post("/webhooks/sendblue/account", "x".repeat(256 * 1024 + 1), auth)).status, 413);
    assert.equal((await fetch(`${url}/readyz`)).status, 200);
    assert.equal((await post("/callbacks/sendblue/account/stale/token", "broken", auth)).status, 204);
  } finally { await closeGatewayServer(server); await f.close(); }
});

test("gateway configuration rejects duplicate targets and invalid origins, references, and environment names", () => {
  const source = configSource("/tmp/state");
  for (const invalid of [
    source.replace('listen_port=8787', 'listen_port=0'),
    source.replace('https://example.exe.xyz', 'http://example.exe.xyz'),
    source.replace('https://example.exe.xyz', 'https://example.exe.xyz/path'),
    source.replace('api_key_id_env="KEY"', 'api_key_id_env="a secret"'),
    source.replace('sendblue="account"', 'sendblue="missing"'),
    source.replace('agent="one"', 'agent="missing"'),
    source.replace('sender="+15125550100"', 'sender="5125550100"'),
    `${source}\n[[gateway.routes]]\nid="second"\nsendblue="account"\nsender="+15125550300"\nsendblue_number="+15125550200"\nagent="one"\n`,
    `${source}\n[[agents]]\nid="two"\nlabel="Two"\ncwd="/tmp"\nthread_id="thread-one"\nmodel="test"\n`,
  ]) assert.throws(() => parseConfig(invalid), (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
  assert.doesNotThrow(() => parseConfig(source));
});

test("CLI status and resolution require a stopped gateway and never resolve secrets", async () => {
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
  const exec = promisify(execFile); const f = await fixture();
  const path = join(f.directory, "config.toml"); await writeFile(path, configSource(f.directory));
  const args = ["dist/src/cli.js", "--config", path, "gateway"];
  try {
    await assert.rejects(exec(process.execPath, [...args, "status", "--json"]), (error: unknown) => {
      const result = error as { code: number; stdout: string }; return result.code === 1 && JSON.parse(result.stdout).runtime.state === "unavailable";
    });
    await f.store.transaction((state) => { bindRoutes(state, f.config); const active = delivery(); active.parts[0]!.status = "sending"; active.parts[0]!.callbackToken = "token"; state.routes.route!.active = active; });
    await f.store.close();
    const status = JSON.parse((await exec(process.execPath, [...args, "status", "--json"])).stdout);
    assert.deepEqual(status, { unresolved: [{ routeId: "route", effectId: "part-one", kind: "send" }], runtime: { state: "stopped" } });
    const result = JSON.parse((await exec(process.execPath, [...args, "resolve", "route", "part-one", "accepted", "observed", "--json"])).stdout);
    assert.deepEqual(result, { type: "resolved", routeId: "route", effectId: "part-one", resolution: "accepted", providerHandle: "observed" });
    await assert.rejects(exec(process.execPath, [...args, "resolve", "route", "part-one", "retry", "--json"]), (error: unknown) => (error as { code: number }).code === 2);
  } finally { await f.close(); }
});

test("a crash after Codex acceptance restores the persisted intent without replay", async () => {
  let fail = false; const f = await fixture(async () => { if (fail) throw new Error("disk full"); });
  let receipts = 0; f.connector.readReceipt = async () => { receipts++; };
  const original = f.session.admit.bind(f.session);
  f.session.admit = async (input, intent) => {
    const work = f.store.snapshot().routes.route!.active;
    assert.equal(work?.kind, "codex");
    if (work?.kind === "codex") { assert.ok(work.pendingAdmission); assert.equal(work.batches.length, 1); }
    const turnId = await original(input, intent); fail = true; return turnId;
  };
  let restarted: Gateway | undefined;
  try {
    await f.gateway.start(); await f.receive("one"); f.advance(5000); await f.gateway.idle();
    assert.equal(f.session.admissions.length, 1); assert.equal(unresolved(f.store.snapshot()).unresolved.length, 1);
    assert.equal(receipts, 1);
    await f.gateway.close(); fail = false;
    const restored = new FakeSession();
    restarted = new Gateway(f.config, f.store, { ...f.gateway.operations, openSession: async () => restored });
    await restarted.start(); await restarted.idle();
    assert.equal(restored.admissions.length, 0); assert.equal(restored.restores.length, 1);
    assert.equal(receipts, 1);
    assert.equal(unresolved(f.store.snapshot()).unresolved.length, 0);
    restored.finish({ turnId: "owned", status: "completed", finalText: "restored", imageGenerations: [] });
    await until(() => f.sends.length === 1); await restarted.idle();
    assert.equal(f.sends.length, 1);
  } finally { fail = false; await restarted?.close(); await f.close(); }
});

test("an unavailable host cannot block readiness, durable intake, or a frozen delivery", async () => {
  const f = await fixture(); let gateway: Gateway | undefined;
  try {
    const config = structuredClone(f.config);
    config.routes.push({ ...config.routes[0]!, id: "healthy", sender: "+15125550300", agent: { ...config.routes[0]!.agent, id: "two", threadId: "thread-two" } });
    await f.store.transaction((state) => {
      bindRoutes(state, config);
      state.routes.healthy!.active = delivery();
      const now = Date.now();
      state.routes.route!.queue.push({ id: "queued", sourceId: "sendblue:account", openedAtMs: now, quietDeadlineMs: now, maximumDeadlineMs: now, events: [{ messageHandle: "one", providerTimeMs: now, receiptSequence: 0, text: "hello" }] });
    });
    gateway = new Gateway(config, f.store, { ...f.gateway.operations, openSession: (_route, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    }) });
    await gateway.start(); assert.equal(gateway.ready, true);
    await gateway.receive("account", { messageHandle: "two", sender: "+15125550100", sendblueNumber: "+15125550200", providerTimeMs: Date.now(), text: "queued" });
    await until(() => f.sends.length === 2);
    assert.equal(f.store.snapshot().routes.route!.openBatch!.events[0]!.messageHandle, "two");
    assert.equal(gateway.ready, true);
  } finally { await gateway?.close(); await f.close(); }
});

test("completion cannot erase a later uncertain admission or its prepared file references", async () => {
  const f = await fixture();
  f.files.prepareBatch = async (_route, batch) => ({ ...batch, events: batch.events.map((event) => ({ ...event,
    attachment: { state: "ready", name: "input.txt", mediaType: "text/plain", inputKind: "file", localPath: "/spool/input.txt", hostPath: "/host/input.txt" },
  })) });
  const original = f.session.admit.bind(f.session);
  f.session.admit = async (input, intent) => {
    if (f.session.admissions.length) {
      f.session.finish({ turnId: "owned", status: "completed", finalText: "done", imageGenerations: [] });
      throw new RouterError("app_server_disconnected", "lost acknowledgement", { ambiguous: true });
    }
    return original(input, intent);
  };
  try {
    await f.gateway.start(); await f.receive("one"); f.advance(5000); await f.gateway.idle();
    await f.receive("two"); f.advance(5000); await f.gateway.idle();
    const active = f.store.snapshot().routes.route!.active;
    assert.equal(active?.kind, "codex");
    if (active?.kind !== "codex") assert.fail("missing work");
    assert.equal(active.turnId, "owned"); assert.ok(active.pendingAdmission); assert.equal(active.batches.length, 2);
    assert.equal(active.batches[1]!.events[0]!.attachment?.state, "ready"); assert.equal(f.sends.length, 0);
    await f.store.transaction((state) => resolveEffect(state, "route", active.pendingAdmission!.clientUserMessageId, "failed"));
    const resolved = f.store.snapshot().routes.route!.active;
    if (resolved?.kind !== "codex") assert.fail("work was discarded");
    assert.equal(resolved.batches.length, 2); assert.equal(resolved.admissionFailed, true); assert.equal(resolved.turnId, "owned");
    assert.equal(resolved.pendingAdmission, undefined);
  } finally { await f.close(); }
});

test("a negative callback selects settlement before a delayed snapshot and prevents another attempt", async () => {
  let block = false; let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture(async () => { if (block) { entered(); await new Promise<void>((resolve) => { release = resolve; }); } });
  let calls = 0;
  f.connector.send = async () => { calls++; return { status: "rejected", retryable: true, retryAfterMs: 50 }; };
  try {
    await f.store.transaction((state) => { bindRoutes(state, f.config); state.routes.route!.active = delivery(); });
    await f.gateway.start(); await until(() => calls === 1);
    const active = f.store.snapshot().routes.route!.active as Delivery;
    block = true;
    const callback = f.gateway.callback("account", "part-one", active.parts[0]!.callbackToken!, { status: "ERROR" });
    await waiting;
    await new Promise((resolve) => setTimeout(resolve, 70)); assert.equal(calls, 1);
    block = false; release(); await callback; await f.gateway.idle(); assert.equal(calls, 1);
  } finally { block = false; release?.(); await f.close(); }
});

test("remote cleanup cannot delay a response after its delivery snapshot is durable", async () => {
  const f = await fixture(); let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
  f.files.release = async (_route, active) => { if (active.kind === "codex") await cleanup; };
  try {
    await f.gateway.start(); await f.receive("one"); f.advance(5000); await f.gateway.idle();
    f.session.finish({ turnId: "owned", status: "completed", finalText: "ready", imageGenerations: [] });
    await until(() => f.sends.length === 1); await f.gateway.idle();
    assert.equal(f.store.snapshot().routes.route!.active, undefined);
    assert.equal(f.gateway.ready, true);
  } finally { finishCleanup(); await f.close(); }
});

test("foreground gateway serves health, ignores unmatched traffic, and releases its lock on shutdown", async () => {
  const { runGateway } = await import("../src/gateway-server.js");
  const { createServer } = await import("node:net");
  const directory = await mkdtemp(join(tmpdir(), "gateway-runner-"));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const config = configuration(directory); config.listenPort = port;
  const previous = [process.env.KEY, process.env.SECRET, process.env.SIGNING];
  process.env.KEY = "fixture-key"; process.env.SECRET = "fixture-secret"; process.env.SIGNING = "fixture-signing";
  const abort = new AbortController();
  const running = runGateway(config, abort.signal);
  let failure: unknown;
  void running.catch((error) => { failure = error; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      try { ready = (await fetch(`http://127.0.0.1:${port}/readyz`)).ok; } catch { /* Wait for bind. */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ready, true);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json(), { ok: true });
    await assert.rejects(GatewayStore.open(directory), (error: unknown) => error instanceof RouterError && error.code === "gateway_running");
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/sendblue/account`, { method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": "fixture-signing" }, body: JSON.stringify({ is_outbound: true }) });
    assert.equal(response.status, 204);
  } finally {
    abort.abort(); await running;
    for (const [index, name] of ["KEY", "SECRET", "SIGNING"].entries()) { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }
    const store = await GatewayStore.open(directory); await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutdown during the sending snapshot starts no provider request", async () => {
  let hold = false; let release!: () => void; let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture(async () => { if (hold) { hold = false; entered(); await new Promise<void>((resolve) => { release = resolve; }); } });
  try {
    await f.gateway.start(); await f.gateway.idle();
    await f.store.transaction((state) => { state.routes.route!.active = delivery(); });
    hold = true; f.gateway.wake("route"); await enteredPromise;
    const closing = f.gateway.close(); release(); await closing;
    assert.equal(f.sends.length, 0);
    assert.equal(unresolved(f.store.snapshot()).unresolved.length, 1);
  } finally { await f.close(); }
});

test("a stalled request receives 408 before its socket closes", async () => {
  const { createConnection } = await import("node:net");
  const f = await fixture(); const server = createGatewayServer(f.gateway);
  try {
    await f.gateway.start();
    // Use a short real socket timeout while retaining the production timeout handler.
    server.once("request", (request) => request.setTimeout(20));
    await listenGateway(server, 0);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: (server.address() as { port: number }).port });
      let received = "";
      socket.setEncoding("utf8"); socket.setTimeout(3000, () => socket.destroy(new Error("timeout response missing")));
      socket.on("error", reject); socket.on("data", (chunk) => { received += chunk; }); socket.on("end", () => resolve(received));
      socket.on("connect", () => socket.write(`POST /webhooks/sendblue/account HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nsb-signing-secret: ${f.connector.signingSecret}\r\nContent-Length: 100\r\n\r\n{`));
    });
    assert.match(response, /^HTTP\/1\.1 408 /);
    assert.match(response, /connection: close/i);
    assert.equal(f.store.snapshot().routes.route!.receipts!.length, 0);
  } finally { await closeGatewayServer(server); await f.close(); }
});


test("Sendblue credentials support direct, environment, and mixed configuration", () => {
  const source = configSource("/tmp/state");
  const direct = source.replace('api_key_id_env="KEY"', 'api_key_id="direct-key"')
    .replace('api_secret_key_env="SECRET"', 'api_secret_key="direct-secret"')
    .replace('webhook_secret_env="SIGNING"', 'webhook_secret="direct-signing"');
  const config = parseConfig(direct).gateway!;
  assert.deepEqual(sendblueCredentials(config.sendblue[0]!, {}), {
    apiKeyId: "direct-key", apiSecretKey: "direct-secret", signingSecret: "direct-signing",
  });
  assert.equal(sendblueConnectors(config, {}).get("account")!.signingSecret, "direct-signing");
  const env = { KEY: "env-key", SECRET: "env-secret", SIGNING: "env-signing" };
  assert.deepEqual(sendblueCredentials(parseConfig(source).gateway!.sendblue[0]!, env), {
    apiKeyId: "env-key", apiSecretKey: "env-secret", signingSecret: "env-signing",
  });
  const mixed = parseConfig(direct.replace('api_secret_key="direct-secret"', 'api_secret_key_env="SECRET"')).gateway!;
  assert.equal(sendblueCredentials(mixed.sendblue[0]!, env).apiSecretKey, "env-secret");
  for (const key of ["api_key_id", "api_secret_key", "webhook_secret"]) {
    for (const value of ['""', '42', '"secret\\nvalue"']) {
      const invalid = direct.replace(new RegExp(key + '=\"[^\"]*\"'), key + '=' + value);
      assert.throws(() => parseConfig(invalid), (error: unknown) =>
        error instanceof RouterError && error.code === "config_invalid" && !error.message.includes("secret\nvalue"));
    }
    assert.throws(() => parseConfig(direct.replace(`${key}=`, `${key}_env="KEY"\n${key}=`)));
    assert.throws(() => parseConfig(direct.replace(new RegExp(key + '=\"[^\"]*\"'), '')));
  }
  assert.throws(() => sendblueCredentials(parseConfig(source).gateway!.sendblue[0]!, {}));
  assert.throws(() => sendblueCredentials(parseConfig(source).gateway!.sendblue[0]!, { ...env, SECRET: "private\nvalue" }),
    (error: unknown) => error instanceof RouterError && !error.message.includes("private"));
});


test("gateway adds only connector-provided instructions to new and steered batches", async () => {
  const f = await fixture();
  try {
    await f.gateway.start(); await f.receive("plain"); f.advance(5000); await f.gateway.idle();
    assert.deepEqual((f.session.admissions[0] as { input: unknown[] }).input,
      [{ type: "text", text: "plain", text_elements: [] }]);
    f.connector.agentInstructions = (directory) => `Connector guidance: ${directory}`;
    await f.receive("steered"); f.advance(5000); await f.gateway.idle();
    assert.deepEqual((f.session.admissions[1] as { input: unknown[] }).input, [
      { type: "text", text: "steered", text_elements: [] },
      { type: "text", text: "Connector guidance: /tmp/publication", text_elements: [] },
    ]);
  } finally { await f.close(); }
});


test("read receipts follow durable intake before batching and never hold up replies", async () => {
  for (const failure of ["pending", "reject", "throw"] as const) {
    const f = await fixture();
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    f.connector.readReceipt = () => {
      calls++;
      assert.equal(f.store.snapshot().routes.route!.receipts!.length, calls);
      if (failure === "throw") throw new Error("provider failure");
      return failure === "reject" ? Promise.reject(new Error("provider failure")) : pending;
    };
    try {
      await f.gateway.start(); await f.receive("first"); await f.receive("first");
      await f.gateway.idle(); assert.equal(calls, 1);
      assert.equal(f.session.admissions.length, 0);
      f.advance(5000); await f.gateway.idle(); assert.equal(calls, 1);
      await f.receive("followup"); f.advance(5000); await f.gateway.idle(); assert.equal(calls, 2);
      f.session.finish({ turnId: "owned", status: "completed", finalText: "reply", imageGenerations: [] });
      await until(() => f.sends.length === 1); await f.gateway.idle();
      assert.equal(f.store.snapshot().routes.route!.active, undefined);
      assert.equal(f.gateway.processingStatus()[0]!.state, "idle");
    } finally { release(); await f.close(); }
  }
});

test("read receipts do not wait for Codex availability", async () => {
  const f = await fixture(); let calls = 0;
  f.connector.readReceipt = async () => { calls++; };
  f.session.admit = async () => { throw new RouterError("thread_unavailable", "Unavailable"); };
  try {
    await f.gateway.start(); await f.receive("first"); f.advance(5000); await f.gateway.idle();
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

for (const mode of ["poll", "webhook"] as const) test(`ambiguous ${mode} delivery never automatically sends again`, async () => {
  const f = await fixture(); let calls = 0;
  f.config.sendblue[0]!.mode = mode;
  f.connector.send = async () => { calls++; return { status: "uncertain", retryable: true, retryAfterMs: 0 }; };
  try {
    await f.store.transaction(state => { bindRoutes(state, f.config); state.routes.route!.active = delivery(); });
    await f.gateway.start(); await f.gateway.idle();
    assert.equal(calls, 1);
    assert.equal((f.store.snapshot().routes.route!.active as Delivery).parts[0]!.status, "sending");
    assert.equal(f.gateway.processingStatus()[0]!.state, "unresolved");
  } finally { await f.close(); }
});


test("exhausted definite rejections settle failed instead of remaining uncertain", async () => {
  const f = await fixture(); let calls = 0;
  f.connector.send = async () => { calls++; return { status: "rejected", retryable: true, retryAfterMs: 0 }; };
  try {
    await f.store.transaction(state => { bindRoutes(state, f.config); state.routes.route!.active = delivery(); });
    await f.gateway.start(); await f.gateway.idle();
    assert.equal(calls, 3);
    assert.equal(f.store.snapshot().routes.route!.active, undefined);
    assert.equal(f.gateway.processingStatus()[0]!.state, "idle");
  } finally { await f.close(); }
});

test("CLI polling recovery requires stopped service and retains admission receipts", async () => {
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
  const exec = promisify(execFile); const f = await fixture();
  const path = join(f.directory, "poll.toml"); await writeFile(path, configSource(f.directory).replace('mode="webhook"', 'mode="poll"'));
  const since = new Date(Date.now() - 3600000).toISOString();
  const args = ["dist/src/cli.js", "--config", path, "gateway", "polling-reset", "account", since, "--json"];
  try {
    await assert.rejects(exec(process.execPath, args), (error: unknown) => JSON.parse((error as { stdout: string }).stdout).code === "gateway_running");
    await f.store.transaction(state => { bindRoutes(state, f.config); state.routes.route!.receipts!.push({ sourceId: "sendblue:account", externalId: "already-read", receivedAtMs: Date.now() }); });
    await f.store.close();
    assert.deepEqual(JSON.parse((await exec(process.execPath, args)).stdout), { account: "account", pollingFrom: since });
    const saved = JSON.parse(await readFile(join(f.directory, "state.json"), "utf8"));
    assert.equal(saved.polling.account.completedThroughMs, Date.parse(since));
    assert.equal(saved.routes.route.receipts[0].externalId, "already-read");
    await assert.rejects(exec(process.execPath, [...args.slice(0, -2), "2000-01-01T00:00:00.000Z", "--json"]));
  } finally { await f.close(); }
});


test("Sendblue account latency settings control admission batching", async () => {
  const f = await fixture();
  try {
    f.config.sendblue[0]!.batchQuietMs = 1000;
    const gateway = new Gateway(f.config, f.store, { connector: () => f.connector, files: { async cleanup() {}, async reconcile() {}, async prepareBatch(_r, b) { return b; }, async publication() { return "/tmp"; }, async delivery() { return []; } }, openSession: async () => f.session });
    try {
      await gateway.start();
      await gateway.receive("account", { messageHandle: "fast", sender: "+15125550100", sendblueNumber: "+15125550200", providerTimeMs: Date.now(), text: "fast" });
      const batch = f.store.snapshot().routes.route!.openBatch!;
      assert.equal(batch.quietDeadlineMs - batch.openedAtMs, 1000);
    } finally { await gateway.close(); }
  } finally { await f.close(); }
});

test("Sendblue latency configuration validates bounds", () => {
  const base = configSource("/tmp/config-latency-test");
  const configured = parseConfig(base.replace('mode="webhook"', 'mode="poll"\npoll_interval_ms=1000\nbatch_quiet_ms=1000')).gateway!;
  assert.equal(configured.sendblue[0]!.pollIntervalMs, 1000);
  assert.equal(configured.sendblue[0]!.batchQuietMs, 1000);
  for (const value of [0, -1, 249, 60001, 1.5]) assert.throws(() => parseConfig(base.replace('mode="webhook"', `mode="poll"\npoll_interval_ms=${value}`)));
});

test("failed durable intake does not send a read receipt", async () => {
  let fail = false; const f = await fixture(async () => { if (fail) throw new Error("disk failure"); });
  let calls = 0; f.connector.readReceipt = async () => { calls++; };
  try {
    await f.gateway.start(); fail = true;
    await assert.rejects(f.receive("first"));
    await Promise.resolve(); assert.equal(calls, 0);
  } finally { fail = false; await f.close(); }
});
