import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, mkdir, lstat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
import { Gateway, type SendblueProvider, type GatewayFiles, type GatewaySession } from "../src/gateway.js";
import { GatewayStore, validateState, resolveEffect, type Receipt } from "../src/gateway-state.js";
import { createGatewayServer, listenGateway, closeGatewayServer } from "../src/gateway-server.js";
import { GatewayFilePlane } from "../src/gateway-files.js";
import { RouterError } from "../src/errors.js";
import type { AdmissionIntent, TurnInput } from "../src/turn-session.js";
import type { SemanticMessage, TurnOutcome } from "../src/turn-state.js";

class Session implements GatewaySession {
  readonly backend = "stdio" as const;
  readonly capabilities = { steer: true };
  readonly serverInfo = { codexHome: "/private/tmp/https-test-home", platformFamily: "unix", platformOs: "darwin" };
  readonly artifactBaseline: string[] = [];
  turnId: string = randomUUID();
  busy = false;
  closed = false;
  readonly admissions: Array<{ input: readonly TurnInput[]; intent: AdmissionIntent }> = [];
  emit?: (message: SemanticMessage) => void;
  done!: (outcome: TurnOutcome) => void;
  outcome = new Promise<TurnOutcome>(resolve => { this.done = resolve; });
  async filesystem(method: string, params: unknown) {
    const p = params as { path: string; recursive?: boolean; force?: boolean };
    if (method === "fs/createDirectory") { await mkdir(p.path, { recursive: p.recursive ?? false }); return {}; }
    if (method === "fs/remove") { await rm(p.path, { recursive: p.recursive ?? false, force: p.force ?? false }); return {}; }
    if (method === "fs/readDirectory") return { entries: (await readdir(p.path, { withFileTypes: true })).map(entry => ({ fileName: entry.name, isFile: entry.isFile() })) };
    const metadata = await lstat(p.path);
    return { isFile: metadata.isFile(), isDirectory: metadata.isDirectory(), isSymlink: metadata.isSymbolicLink(), modifiedAtMs: metadata.mtimeMs };
  }
  async resume() {
    const activeTurn = { id: "external-active-turn", status: "inProgress", items: [] };
    return { thread: { status: { type: this.busy ? "active" : "idle" }, turns: this.busy ? [activeTurn] : [] },
      ...(this.busy ? { activeTurn } : {}) };
  }
  async admit(input: readonly TurnInput[], intent: AdmissionIntent) { this.admissions.push({ input, intent }); this.turnId = intent.expectedTurnId ?? this.turnId; return this.turnId; }
  async restore(turnId?: string) { this.turnId = turnId ?? this.turnId; return this.turnId; }
  observe(_turnId: string, emit?: (message: SemanticMessage) => void) { if (emit) this.emit = emit; return this.outcome; }
  complete(text: string, status: TurnOutcome["status"] = "completed") { this.done({ turnId: this.turnId, status, finalText: text, imageGenerations: [] }); }
  async interrupt(expectedTurnId: string) { assert.equal(expectedTurnId, this.turnId); this.complete("", "interrupted"); }
  async close() { this.closed = true; this.complete("", "interrupted"); }
}
async function until(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), label);
}
async function fixture(mixed = false, realFiles = false, extraAgent = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "gateway-https-")));
  const config = parseConfig(`
[[agents]]
id="agent"
label="Agent"
cwd="/private/tmp"
thread_id="thread"
model="test"
${extraAgent ? '[[agents]]\nid="second"\nlabel="Second"\ncwd="/private/tmp"\nthread_id="second-thread"\nmodel="test"' : ""}
[gateway]
${mixed ? "retained_bytes=16777216" : ""}
state_dir=${JSON.stringify(directory)}
[gateway.http]
${mixed ? '[[gateway.sendblue]]\nid="phone"\napi_key_id_env="UNUSED_KEY"\napi_secret_key_env="UNUSED_SECRET"\n[[gateway.sendblue.conversations]]\nagent="agent"\nsender="+15125550100"\nsendblue_number="+15125550200"' : ""}
`).gateway!;
  let now = Date.now(); let failWrites = false; let connectionError: RouterError | undefined;
  let externalBusy = false; let retryDelayMs = 60_000;
  const beforeWrite = async () => { if (failWrites) throw new RouterError("storage_failed", "injected durable write failure"); };
  let store = await GatewayStore.open(directory, beforeWrite);
  const sessions: Session[] = []; const sent: string[] = []; const uploaded: string[] = [];
  const home = join(directory, "codex-home");
  if (realFiles) await mkdir(home);
  const connector: SendblueProvider = {
    signingSecret: "fixture", inbound() { return undefined; }, callback() { return { status: "SENT" }; },
    async send(_route, part) { if (part.payload.kind === "media") assert.ok(realFiles); sent.push(part.payload.kind === "text" ? part.payload.text : `media:${part.payload.name}`); return { status: "accepted", providerHandle: part.id }; },
    async upload(_path, name) { assert.ok(realFiles, "unexpected upload"); uploaded.push(name); return "https://example.com/media"; }, async typing() {},
  };
  const files: GatewayFiles = realFiles ? new GatewayFilePlane(directory) : {
    async cleanup() {}, async reconcile() {}, async release() {},
    async prepareBatch(_route, batch) { assert.ok(mixed, "HTTPS must not prepare Sendblue input"); return batch; },
    async publication() { assert.ok(mixed, "HTTPS must not create a Sendblue publication"); return "/private/tmp/publication"; },
    async stage(_target, _work, outcome) { return { result: { status: outcome.status, text: outcome.finalText ?? "", notices: [] }, artifacts: [] }; },
  };
  const create = () => new Gateway(config, store, { connector: () => { assert.ok(mixed, "HTTPS must not construct a fake outbound connector"); return connector; }, files, now: () => now, retryDelayMs: () => retryDelayMs,
    openSession: async () => { if (connectionError) throw connectionError; const session = new Session(); if (realFiles) session.serverInfo.codexHome = home; session.busy = externalBusy; sessions.push(session); return session; } });
  let gateway = create(); let server = createGatewayServer(gateway);
  async function start() { await gateway.start(); await listenGateway(server, 0); }
  async function stop() { if (server.listening) await closeGatewayServer(server); await gateway.close(); }
  await start();
  return {
    config, sessions, sent, uploaded, publicationRoot: join(home, "codex-router-gateway", "outbox"), get gateway() { return gateway; }, get store() { return store; },
    get base() { return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/agents/agent/requests`; },
    set externalBusy(value: boolean) { externalBusy = value; }, set retryDelayMs(value: number) { retryDelayMs = value; },
    set failWrites(value: boolean) { failWrites = value; }, set connectionError(value: RouterError | undefined) { connectionError = value; }, advance(ms: number) { now += ms; gateway.wake("agent"); },
    async post(id: string, text = "hello") {
      return fetch(this.base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: id, text }) });
    },
    async get(id: string) { return fetch(`${this.base}/${id}`); },
    async phone(handle: string, text: string) { await gateway.receive("phone", { messageHandle: handle, sender: "+15125550100", sendblueNumber: "+15125550200", text, providerTimeMs: now }); },
    async restart() { await stop(); await store.close(); store = await GatewayStore.open(directory, beforeWrite); gateway = create(); server = createGatewayServer(gateway); await start(); await gateway.idle(); },
    async close() { failWrites = false; await stop(); await store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("HTTP-only requests retain exact results across restart without outbound calls", async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    assert.equal((await f.post(id)).status, 202);
    await f.gateway.idle(); assert.equal(f.sessions.length, 1);
    assert.equal(f.sessions[0]!.admissions[0]!.intent.expectedTurnId, undefined);
    f.sessions[0]!.complete("");
    await until(() => !!f.gateway.request("agent", "http", id)?.result, "terminal result should persist");
    await f.gateway.idle();
    assert.deepEqual((await (await f.get(id)).json()).result, { status: "completed", text: "", notices: [] });
    const reservation = f.store.snapshot().routes.agent!.receipts!.find(r => r.externalId === id)!.reservedBytes!;
    assert.ok(reservation < 4096);
    await f.restart();
    assert.equal((await f.get(id)).status, 200);
    assert.equal((await f.post(id)).status, 202);
    await f.gateway.idle(); assert.equal(f.sessions.length, 1);
  } finally { await f.close(); }
});

test("concurrent duplicates admit once and conflicts or unknown agents do not mutate work", async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    const responses = await Promise.all(Array.from({ length: 12 }, () => f.post(id, "same payload")));
    assert.ok(responses.every(r => r.status === 202)); await f.gateway.idle();
    assert.equal(f.sessions.length, 1); assert.equal(f.sessions[0]!.admissions.length, 1);
    assert.equal((await f.post(id, "different payload")).status, 409);
    assert.equal((await fetch(f.base.replace("/agent/", "/missing/") + "/" + id)).status, 404);
    assert.equal(f.store.snapshot().routes.agent!.receipts!.length, 1);
  } finally { await f.close(); }
});

test("Sendblue and HTTPS follow-ups steer the same active turn without waiting or batching", async () => {
  const f = await fixture(true); const id = randomUUID();
  try {
    await f.phone("first", "phone A"); f.advance(5001); await f.gateway.idle();
    assert.equal(f.sessions.length, 1);
    const session = f.sessions[0]!;
    assert.equal((await f.post(id, "HTTP B")).status, 202); await f.gateway.idle();
    await f.phone("third", "phone C"); await f.gateway.idle();
    assert.deepEqual(session.admissions.map(a => (a.input[0] as {text:string}).text), ["phone A", "HTTP B", "phone C"]);
    assert.deepEqual(session.admissions.map(a => a.intent.expectedTurnId), [undefined, session.turnId, session.turnId]);
    assert.equal(f.store.snapshot().routes.agent!.queue.length, 0);
    assert.equal(f.store.snapshot().routes.agent!.openBatch, undefined);
    assert.equal(f.sessions.length, 1);
    session.complete("combined answer");
    await until(() => f.sent.length === 1 && !!f.gateway.request("agent", "http", id)?.result, "both sources must receive the shared result");
    assert.equal((await (await f.get(id)).json()).result.text, "combined answer");
    assert.deepEqual(f.sent, ["combined answer"]);
  } finally { await f.close(); }
});

test("byte reservations survive restart, duplicates work at capacity, and expired results release count capacity", async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    f.config.retainedBytes = 2 * 1024 * 1024; await f.restart();
    assert.equal((await f.post(id)).status, 202); await f.gateway.idle();
    assert.equal((await f.post(randomUUID())).status, 429);
    assert.equal((await f.post(id)).status, 202);
    const receipt = f.store.snapshot().routes.agent!.receipts![0]!;
    assert.ok(receipt.reservedBytes! > 1500000);
    await f.restart();
    assert.equal(f.sessions.length, 2); assert.equal(f.sessions[1]!.admissions.length, 0);
    assert.equal(f.store.snapshot().routes.agent!.receipts![0]!.reservedBytes, receipt.reservedBytes);
    assert.equal((await f.post(randomUUID())).status, 429);
    assert.equal((await f.post(id)).status, 202);
    f.sessions[1]!.complete("retained");
    await until(() => !!f.gateway.request("agent", "http", id)?.result, "result should retain"); await f.gateway.idle();
    f.config.maxRequests = 1; await f.restart();
    assert.equal((await f.post(randomUUID())).status, 429);
    assert.equal((await f.post(id)).status, 202);
    f.advance(31 * 24 * 60 * 60 * 1000);
    assert.equal((await f.get(id)).status, 404);
    assert.equal((await f.post(randomUUID())).status, 202);
  } finally { await f.close(); }
});

test("SSE delivers completed commentary and durable final text, including terminal replay after restart", async () => {
  const f = await fixture(); const id = randomUUID(); const abort = new AbortController();
  try {
    await f.post(id); await f.gateway.idle();
    const response = await fetch(`${f.base}/${id}/events`, { headers: { accept: "text/event-stream" }, signal: abort.signal });
    assert.equal(response.status, 200);
    let transcript = "";
    const consume = (async () => { const reader = response.body!.getReader(); const decoder = new TextDecoder(); while (true) { const chunk = await reader.read(); if (chunk.done) return; transcript += decoder.decode(chunk.value, { stream: true }); } })();
    f.sessions[0]!.emit!({ type: "reasoning", text: "backend-published summary" });
    f.sessions[0]!.emit!({ type: "commentary", itemId: "comment", text: "completed commentary" });
    await until(() => transcript.includes("completed commentary"), "commentary should arrive before terminal completion");
    assert.ok(transcript.includes("backend-published summary")); assert.ok(!transcript.includes("event: terminal"));
    f.sessions[0]!.complete("final result"); await consume;
    assert.ok(transcript.includes("event: terminal")); assert.ok(transcript.includes("final result"));
    assert.ok(f.gateway.request("agent", "http", id)?.result);
    await f.restart();
    const replay = await fetch(`${f.base}/${id}/events`, { headers: { "last-event-id": "old-process-cursor" } });
    const replayText = await replay.text();
    assert.ok(replayText.includes("event: reset")); assert.ok(replayText.includes("final result")); assert.equal(f.sessions.length, 1);
  } finally { abort.abort(); await f.close(); }
});


test("failed terminal persistence never emits terminal SSE and restart recovers without admitting again", async () => {
  const f = await fixture(); const id = randomUUID(); const abort = new AbortController();
  let consume: Promise<void> | undefined;
  try {
    await f.post(id); await f.gateway.idle();
    const response = await fetch(`${f.base}/${id}/events`, { signal: abort.signal });
    let transcript = "";
    consume = (async () => {
      try {
        const reader = response.body!.getReader(); const decoder = new TextDecoder();
        while (true) { const chunk = await reader.read(); if (chunk.done) return; transcript += decoder.decode(chunk.value, { stream: true }); }
      } catch (error) { if (!abort.signal.aborted) throw error; }
    })();
    await until(() => transcript.includes("event: status"), "subscriber should receive status");
    f.failWrites = true; f.sessions[0]!.complete("must become durable first");
    await until(() => f.gateway.errors().length === 1, "failed persistence must surface as blocked processing");
    assert.ok(!transcript.includes("event: terminal"));
    assert.equal(f.gateway.request("agent", "http", id)?.result, undefined);
    const blocked = await (await f.get(id)).json();
    assert.equal(blocked.status, "running");
    assert.equal(blocked.processing.state, "blocked"); assert.equal(blocked.processing.code, "storage_failed");
    assert.equal(f.store.snapshot().routes.agent!.active?.kind, "codex");
    abort.abort(); await consume; f.failWrites = false;
    await f.restart(); assert.equal(f.sessions[1]!.admissions.length, 0);
    f.sessions[1]!.complete("must become durable first");
    await until(() => !!f.gateway.request("agent", "http", id)?.result, "recovered result should persist");
    const replay = await fetch(`${f.base}/${id}/events`);
    const recovered = await replay.text(); assert.ok(recovered.includes("event: terminal")); assert.ok(recovered.includes("must become durable first"));
    assert.equal(f.sessions.flatMap(s => s.admissions).length, 1);
  } finally { abort.abort(); await consume; await f.close(); }
});


test("canonical retained receipts cannot lose capacity or bind a result to an unrelated request", async (t) => {
  const f = await fixture(); const id = randomUUID();
  try {
    await f.post(id); await f.gateway.idle();
    const pending = f.store.snapshot();
    const corruptions: Array<[string, (receipt: Receipt) => void]> = [
      ["missing reservation", receipt => { delete receipt.reservedBytes; }],
      ["zero reservation", receipt => { receipt.reservedBytes = 0; }],
      ["unrelated request identity", receipt => { receipt.externalId = randomUUID(); }],
      ["expiration of unfinished work", receipt => { Object.assign(receipt, { expiresAtMs: Date.now() + 1000 }); }],
    ];
    for (const [label, change] of corruptions) await t.test(label, () => {
      const damaged = structuredClone(pending); change(damaged.routes.agent!.receipts![0]!);
      assert.throws(() => validateState(damaged), (error: unknown) => error instanceof RouterError && error.code === "state_invalid");
    });
    await t.test("two retained identities sharing one batch", () => {
      const damaged = structuredClone(pending);
      damaged.routes.agent!.receipts!.push({ ...damaged.routes.agent!.receipts![0]!, externalId: randomUUID() });
      assert.throws(() => validateState(damaged), (error: unknown) => error instanceof RouterError && error.code === "state_invalid");
    });
    f.sessions[0]!.complete("retained");
    await until(() => !!f.gateway.request("agent", "http", id)?.result, "result should persist"); await f.gateway.idle();
    const terminal = f.store.snapshot();
    for (const [label, change] of corruptions.slice(0, 2)) await t.test(`terminal ${label}`, () => {
      const damaged = structuredClone(terminal); change(damaged.routes.agent!.receipts![0]!);
      assert.throws(() => validateState(damaged), (error: unknown) => error instanceof RouterError && error.code === "state_invalid");
    });
  } finally { await f.close(); }
});


test("HTTP request status exposes route retrying and blocked errors without confusing admission ownership", async () => {
  for (const [code, state] of [["app_server_connect_failed", "retrying"], ["codex_unavailable", "blocked"]] as const) {
    const f = await fixture(); const id = randomUUID();
    try {
      f.connectionError = new RouterError(code, "private filesystem details must not leave the gateway");
      assert.equal((await f.post(id)).status, 202); await f.gateway.idle();
      const result = await (await f.get(id)).json();
      assert.equal(result.status, "queued"); assert.equal(result.processing.state, state); assert.equal(result.processing.code, code);
      assert.ok(!JSON.stringify(result).includes("private filesystem")); assert.equal(f.sessions.length, 0);
    } finally { await f.close(); }
  }
});


test("HTTPS steers an externally active turn immediately", async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    f.externalBusy = true;
    assert.equal((await f.post(id)).status, 202); await f.gateway.idle();
    assert.equal(f.sessions.length, 1);
    assert.equal(f.sessions[0]!.admissions[0]!.intent.expectedTurnId, "external-active-turn");
    assert.equal(f.store.snapshot().routes.agent!.queue.length, 0);
    f.sessions[0]!.complete("steered external turn");
    await until(() => !!f.gateway.request("agent", "http", id)?.result, "external turn result retained");
  } finally { await f.close(); }
});

test("committed HTTP duplicate lookups remain read-only when durable writes are unavailable", async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    assert.equal((await f.post(id, "unchanged")).status, 202); await f.gateway.idle();
    const before = f.store.snapshot(); f.failWrites = true;
    assert.equal((await f.post(id, "unchanged")).status, 202);
    assert.equal((await f.post(id, "changed")).status, 409);
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.sessions.flatMap(session => session.admissions).length, 1);
  } finally { await f.close(); }
});

test("HTTPS then Sendblue then HTTPS steers immediately and retains both HTTP results across restart", async () => {
  const f = await fixture(true); const first = randomUUID(); const last = randomUUID();
  try {
    await f.post(first, "first"); await f.gateway.idle();
    const session = f.sessions[0]!;
    await f.phone("middle", "middle"); await f.gateway.idle();
    await f.post(last, "last"); await f.gateway.idle();
    await f.post(last, "last"); await f.gateway.idle();
    assert.equal(session.admissions.length, 3);
    assert.ok(session.admissions.slice(1).every(a=>a.intent.expectedTurnId===session.turnId));
    assert.equal(f.store.snapshot().routes.agent!.queue.length, 0);
    session.complete("shared");
    await until(()=>f.sent.length===1 && !!f.gateway.request("agent","http",last)?.result,"shared completion");
    await f.gateway.idle(); await f.restart();
    for (const id of [first,last]) assert.equal((await (await f.get(id)).json()).result.text,"shared");
    assert.deepEqual(f.sent,["shared"]);
  } finally { await f.close(); }
});


for (const first of ["https", "sendblue"] as const) test(`real file plane keeps only actual publications when ${first} starts a mixed turn`, async () => {
  const f = await fixture(true, true); const id = randomUUID();
  try {
    if (first === "https") { await f.post(id, "HTTP first"); await f.gateway.idle(); await f.phone("phone", "phone next"); }
    else { await f.phone("phone", "phone first"); f.advance(5001); await f.gateway.idle(); await f.post(id, "HTTP next"); }
    await f.gateway.idle();
    const active = f.store.snapshot().routes.agent!.active!;
    assert.equal(active.kind, "codex"); if (active.kind !== "codex") assert.fail();
    assert.equal(active.batches.length, 2); assert.equal(active.publicationIds.length, 1);
    assert.deepEqual(await readdir(f.publicationRoot), active.publicationIds);
    // No agent-instruction formatter is configured; the real publication must still be tracked.
    await writeFile(join(f.publicationRoot, active.publicationIds[0]!, "reply.txt"), "attachment bytes");
    f.sessions[0]!.complete("mixed answer");
    await until(() => f.sent.length === 2, "text and real attachment should both deliver"); await f.gateway.idle();
    assert.deepEqual(f.sent, ["mixed answer", "media:reply.txt"]);
    assert.deepEqual(f.uploaded, ["reply.txt"]);
    assert.equal(f.gateway.request("agent", "http", id)?.result?.text, "mixed answer");
  } finally { await f.close(); }
});

test("real file plane still warns when an actual Sendblue publication disappears", async () => {
  const f = await fixture(true, true);
  try {
    await f.phone("phone", "answer"); f.advance(5001); await f.gateway.idle();
    const active = f.store.snapshot().routes.agent!.active!; if (active.kind !== "codex") assert.fail();
    await rm(join(f.publicationRoot, active.publicationIds[0]!), { recursive: true });
    f.sessions[0]!.complete("answer");
    await until(() => f.sent.length === 1, "missing publication warning should deliver");
    assert.match(f.sent[0]!, /Files omitted: the response directory is unavailable or unsafe/);
  } finally { await f.close(); }
});

test("pending HTTPS admission without publication survives disk restart and manual resolution", async () => {
  const f = await fixture(false, true); const id = randomUUID();
  try {
    await f.post(id); await f.gateway.idle();
    const active = f.store.snapshot().routes.agent!.active!; if (active.kind !== "codex") assert.fail();
    assert.deepEqual(active.publicationIds, []); assert.deepEqual(await readdir(f.publicationRoot), []);
    await f.store.transaction(state => {
      const work = state.routes.agent!.active!; if (work.kind !== "codex") assert.fail();
      work.pendingAdmission = { batchId: work.ownerBatchId, clientUserMessageId: work.clientUserMessageId! };
    });
    const unresolved = f.store.snapshot();
    resolveEffect(unresolved, "agent", active.clientUserMessageId!, "failed");
    assert.doesNotThrow(() => validateState(unresolved));
    await f.restart();
    assert.equal(f.sessions.length, 2); assert.equal(f.sessions[1]!.admissions.length, 0);
    const recovered = f.store.snapshot().routes.agent!.active!; if (recovered.kind !== "codex") assert.fail();
    assert.equal(recovered.pendingAdmission, undefined); assert.deepEqual(recovered.publicationIds, []);
    f.sessions[1]!.complete("recovered");
    await until(() => !!f.gateway.request("agent", "http", id)?.result, "recovered result should persist");
    assert.equal(f.gateway.request("agent", "http", id)?.result?.text, "recovered");
  } finally { await f.close(); }
});

test("legacy mixed-turn publication references survive restart without reinterpreting or replaying admission", async () => {
  const f = await fixture(true, true); const id = randomUUID(); const legacyId = randomUUID();
  try {
    await f.post(id); await f.gateway.idle(); await f.phone("legacy-phone", "follow-up"); await f.gateway.idle();
    await f.store.transaction(state => {
      const work = state.routes.agent!.active!; if (work.kind !== "codex") assert.fail();
      work.publicationIds.unshift(legacyId);
    });
    const before = f.store.snapshot().routes.agent!.active!; if (before.kind !== "codex") assert.fail();
    await f.restart();
    const after = f.store.snapshot().routes.agent!.active!; if (after.kind !== "codex") assert.fail();
    assert.deepEqual(after.publicationIds, before.publicationIds);
    assert.equal(f.sessions[1]!.admissions.length, 0);
    f.sessions[1]!.complete("legacy result");
    await until(() => f.sent.length === 1, "legacy work must complete");
    assert.match(f.sent[0]!, /legacy result/);
    // Existing phantom references remain conservative: an old in-flight turn may warn once.
    assert.match(f.sent[0]!, /Files omitted/);
    assert.equal(f.gateway.request("agent", "http", id)?.result?.text, "legacy result");
  } finally { await f.close(); }
});

test("phone-only participation receives semantic commentary and summaries without backend item IDs", async () => {
  const f = await fixture(true);
  try {
    const key = f.gateway.requestKey("agent", JSON.stringify(["phone", "+15125550200", "+15125550100"]), "phone-progress");
    const progress = f.gateway.progress.watch(key, () => {});
    await f.phone("phone-progress", "hello");
    f.advance(5000);
    await f.gateway.idle();
    const session = f.sessions[0]!;
    session.emit!({ type: "commentary", text: "Checking" });
    session.emit!({ type: "commentary", text: "Checking" });
    session.emit!({ type: "reasoning", text: "Published summary" });
    assert.deepEqual(progress.view.entries.map(entry => entry.message.kind), ["commentary", "commentary", "reasoning"]);
    assert.equal(new Set(progress.view.entries.map(entry => entry.message.id)).size, 3);
    assert.ok(f.store.snapshot().routes.agent!.receipts[0]!.reservedBytes! > 0);
    progress.close();
  } finally { await f.close(); }
});


test("HTTP cancellation requires an exact observed turn and preserves terminal evidence", async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    assert.equal((await f.post(id)).status, 202); await f.gateway.idle();
    const running = await (await f.get(id)).json();
    assert.equal(running.status, "running");
    assert.equal(running.turn_id, f.sessions[0]!.turnId);
    const turnId = running.turn_id;
    const cancel = (expected: string) => fetch(f.base.replace("/requests", "/cancel"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_turn_id: expected }),
    });
    assert.equal((await cancel("stale-turn")).status, 409);
    const response = await cancel(turnId);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { type: "interrupt_requested" });
    await until(() => !!f.gateway.request("agent", "http", id)?.result, "interrupted result must persist");
    assert.equal((await (await f.get(id)).json()).result.status, "interrupted");
    assert.equal((await cancel(turnId)).status, 200);
  } finally { await f.close(); }
});

test("HTTP rejects unsupported cancellation and malformed mutation input", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post(randomUUID())).status, 202); await f.gateway.idle();
    Object.defineProperty(f.sessions[0]!, "interrupt", { value: undefined });
    const url = f.base.replace("/requests", "/cancel");
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_turn_id: f.sessions[0]!.turnId }) });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "interrupt_unsupported" });
    for (const body of [{}, { expected_turn_id: "x", extra: true }, { expected_turn_id: 1 }]) {
      assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal((await fetch(url, { method: "POST", body: "expected_turn_id=x" })).status, 415);
    assert.equal((await fetch(f.base, { method: "OPTIONS" })).status, 405);
  } finally { await f.close(); }
});


test("HTTP discovers and addresses every configured agent without route configuration", async () => {
  const f = await fixture(false, false, true);
  try {
    const catalog = await fetch(new URL("/v1/agents", f.base));
    assert.deepEqual(await catalog.json(), [{ id: "agent", label: "Agent" }, { id: "second", label: "Second" }]);
    const id = randomUUID();
    const response = await fetch(f.base.replace("/agent/", "/second/"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: id, text: "second target" }) });
    assert.equal(response.status, 202); await f.gateway.idle();
    assert.equal(f.sessions.length, 1);
    assert.equal(f.gateway.request("agent", "http", id), undefined);
    assert.equal(f.gateway.request("second", "http", id)?.status, "running");
  } finally { await f.close(); }
});
