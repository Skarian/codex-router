import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestRuntime, type RuntimeTarget, type RequestAdapter } from "../src/request-runtime.js";
import { RpcRequestError } from "../src/json-rpc.js";
import { RouterError } from "../src/errors.js";
import { GatewayStore, resolveEffect, validateState, receiptVisible, bindTargets } from "../src/gateway-state.js";
import type { ExecutionSession } from "../src/execution-session.js";
import type { TurnOutcome } from "../src/turn-state.js";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.ok(check()); }
class Session implements ExecutionSession {
  backend = "stdio" as const; serverInfo = { codexHome: "/tmp/runtime-test", platformFamily: "unix", platformOs: "linux" }; artifactBaseline: string[] = [];
  closed = false; capabilities = { steer: true }; id = randomUUID(); active = false; admissions = 0; interrupts = 0; done = deferred<TurnOutcome>();
  async resume() { return { thread: {}, ...(this.active ? { activeTurn: { id: this.id } } : {}) }; }
  async admit() { this.admissions++; this.active = true; return this.id; }
  async restore() { return this.id; }
  observe() { return this.done.promise; }
  async interrupt() { this.interrupts++; }
  async filesystem() { return {}; }
  finish(text: string) { this.active = false; this.done.resolve({ turnId: this.id, status: "completed", finalText: text, imageGenerations: [] }); }
  async close() { this.closed = true; this.finish(""); }
}
async function fixture(limits: {maxRequests?:number;retainedBytes?:number;outboxJobs?:number;destinationJobs?:number} = {}) {
  let now = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "neutral-runtime-")); const store = await GatewayStore.open(dir);
  const upload = deferred<void>(), preparation = deferred<void>(); const sessions: Session[] = []; const sent: string[] = [];
  const http: RequestAdapter = { binding: { id: "http", namespace: "http" }, policy: { batching: "immediate", duplicateBehavior: "exact" }, async prepare(batch) { return batch; }, async instructions() { return {}; } };
  const phone: RequestAdapter = { ...http, binding: { id: "phone", namespace: "provider", destination: { id: "conversation", namespace: "provider", properties: {} } }, policy: { batching: "immediate", duplicateBehavior: "first" },
    async prepare(batch) { await preparation.promise; return { ...batch, events: batch.events.map(e => ({ ...e, attachment: { state: "omitted" as const, name: "test", reason: "copy_failed" as const } })) }; },
    outbound: { callbackNamespace: "provider", line: "line", maxPerSecond: 10, callbackUrl() { return undefined; },
      async prepare(completion) { await upload.promise; return [{ id: randomUUID(), status: "ready", payload: { kind: "text", text: completion.result.text } }]; },
      async send(part) { sent.push(part.id); return { status: "accepted", providerHandle: part.id }; },
    } };
  const target: RuntimeTarget = { id: "agent", agent: { id: "agent", label: "Agent", cwd: dir, threadId: "chat", model: "test" }, binding: { target: { sshHost: null, threadId: "chat", cwd: dir }, sources: [http.binding, phone.binding] }, adapters: [http, phone] };
  const runtime = new RequestRuntime({ targets: [target], ...limits }, store, { now: () => now, async cleanup() {}, async reconcile() {}, async stage(_target, _work, outcome) { return { result: { status: outcome.status, text: outcome.finalText ?? "", notices: [] }, artifacts: [] }; }, async openSession() { const s = new Session(); sessions.push(s); return s; } });
  await runtime.start();
  async function submit(sourceId: string, attachment = false) { const id = randomUUID(); const text = "hello"; await runtime.submit("agent", { sourceId, externalId: id, input: { text, ...(attachment ? { attachment: { sourceUrl: "https://example.com/file", name: "test" } } : {}) }, ...(sourceId === "http" ? { payloadHash: createHash("sha256").update(JSON.stringify([1, text])).digest("hex") } : {}) }); return id; }
  return { runtime, store, sessions, upload, preparation, sent, submit, advance(ms: number) { now += ms; }, async close() { upload.resolve(); preparation.resolve(); await runtime.close(); await store.close(); await rm(dir, { recursive: true, force: true }); } };
}
test("canonical HTTP result and next execution do not wait for provider upload", async () => {
  const f = await fixture();
  try {
    await f.submit("phone"); await until(() => f.sessions[0]?.admissions === 1);
    const id = await f.submit("http"); await until(() => f.sessions[0]?.admissions === 2);
    f.sessions[0]!.finish("canonical"); await until(() => !!f.runtime.request("agent", "http", id)?.result);
    assert.equal(f.sent.length, 0); assert.equal(f.store.snapshot().routes.agent!.outbox.length, 1);
    await f.submit("http"); await until(() => f.sessions.length === 2 && f.sessions[1]!.admissions === 1);
    f.upload.resolve(); await until(() => f.sent.length === 1);
  } finally { await f.close(); }
});
test("pending attachment preparation does not block ready HTTP steering or guarded cancel", async () => {
  const f = await fixture({retainedBytes:16 * 1024 * 1024});
  try {
    await f.submit("http"); await until(() => f.sessions[0]?.admissions === 1);
    const phone = await f.submit("phone", true); await until(() => f.runtime.request("agent", "phone", phone)?.status === "preparing");
    assert.equal(f.runtime.request("agent", "phone", phone)?.turn_id, undefined);
    await f.submit("http"); await until(() => f.sessions[0]?.admissions === 2);
    assert.deepEqual(await f.runtime.cancel("agent", f.sessions[0]!.id), { type: "interrupt_requested" });
    assert.equal(f.sessions[0]!.interrupts, 1);
    await assert.rejects(f.runtime.cancel("agent", "stale"), { code: "interrupt_conflict" });
  } finally { await f.close(); }
});
test("attachment admitted after old completion does not inherit old result", async () => {
  const f = await fixture();
  try {
    const first = await f.submit("http"); await until(() => f.sessions[0]?.admissions === 1);
    const phone = await f.submit("phone", true); await until(() => f.runtime.request("agent", "phone", phone)?.status === "preparing");
    f.sessions[0]!.finish("old"); await until(() => !!f.runtime.request("agent", "http", first)?.result);
    assert.equal(f.runtime.request("agent", "phone", phone)?.result, undefined);
    f.preparation.resolve(); await until(() => f.sessions[1]?.admissions === 1);
    f.sessions[1]!.finish("new"); await until(() => f.runtime.request("agent", "phone", phone)?.result?.text === "new");
  } finally { await f.close(); }
});

test("provider requests reserve canonical retention capacity before intake and duplicates remain readable", async () => {
  const f = await fixture({maxRequests:1});
  try {
    const id = await f.submit("phone"); await until(() => f.sessions[0]?.admissions === 1);
    f.sessions[0]!.finish("retained"); await until(() => !!f.runtime.request("agent","phone",id)?.result);
    await assert.rejects(f.submit("phone"), {code:"capacity_exceeded"});
    await assert.rejects(f.submit("http"), {code:"capacity_exceeded"});
    const duplicate = await f.runtime.submit("agent",{sourceId:"phone",externalId:id,input:{text:"duplicate"}});
    assert.equal(f.runtime.request("agent","phone",id)?.result?.text,"retained"); assert.equal(f.store.snapshot().routes.agent!.receipts.length,1);
  } finally {await f.close();}
});
test("idle cancellation closes its borrowed session after known and stale turn checks", async () => {
  const f=await fixture();
  try {
    const id=await f.submit("http"); await until(()=>f.sessions[0]?.admissions===1);
    const turn=f.sessions[0]!.id; f.sessions[0]!.finish("done"); await until(()=>!!f.runtime.request("agent","http",id)?.result);
    await f.runtime.idle();
    assert.deepEqual(await f.runtime.cancel("agent",turn),{type:"already_finished"});
    assert.equal(f.sessions.at(-1)!.closed,true);
    await assert.rejects(f.runtime.cancel("agent","wrong"),{code:"interrupt_conflict"});
    assert.equal(f.sessions.at(-1)!.closed,true);
  } finally {await f.close();}
});
test("pending outbox consumes a durable slot and rejects further delivery promises before acknowledgement", async()=>{
  const f=await fixture({destinationJobs:1});
  try {
    const id=await f.submit("phone"); await until(()=>f.sessions[0]?.admissions===1);
    f.sessions[0]!.finish("one"); await until(()=>!!f.runtime.request("agent","phone",id)?.result);
    await assert.rejects(f.submit("phone"),{code:"capacity_exceeded"});
    assert.equal(f.store.snapshot().routes.agent!.receipts.length,1);
    await f.submit("http"); await until(()=>f.sessions[1]?.admissions===1);
    f.upload.resolve(); await until(()=>f.store.snapshot().routes.agent!.outbox.length===0);
    await f.submit("phone"); await until(()=>f.sessions[1]?.admissions===2);
  } finally {await f.close();}
});

for (const operator of [false,true]) test(`${operator ? "operator-failed" : "rejected"} steer never inherits another input's successful result`,async()=>{
 const f=await fixture({retainedBytes:16 * 1024 * 1024});
 try {
  const first=await f.submit("http"); await until(()=>f.sessions[0]?.admissions===1);
  const admit=f.sessions[0]!.admit.bind(f.sessions[0]);
  f.sessions[0]!.admit=async()=>{ if(operator) f.sessions[0]!.finish("accepted input only"); throw operator ? new RouterError("app_server_disconnected","lost",{ambiguous:true}) : new RpcRequestError({code:-32602,message:"Invalid input"});};
  const rejected=await f.submit("phone"); await f.runtime.idle();
  if(operator){ const intent=f.store.snapshot().routes.agent!.active!.pendingAdmission!; await f.store.transaction(state=>resolveEffect(state,"agent",intent.clientUserMessageId,"failed")); }
  if(!operator) { f.sessions[0]!.admit=admit; await f.submit("http"); await until(()=>f.sessions[0]!.admissions===2); }
  f.sessions[0]!.finish("accepted input only");
  // Operator resolution normally happens while stopped; restart clears the blocked worker.
  if(operator) { await f.runtime.close(); const runtime=new RequestRuntime(f.runtime.settings,f.store,{...f.runtime.lifecycle,openSession:async()=>f.sessions[0]!}); await runtime.start();
   await until(()=>!!runtime.request("agent","phone",rejected)?.result); assert.equal(runtime.request("agent","phone",rejected)?.result?.status,"failed"); f.upload.resolve(); await runtime.close();
  } else await until(()=>!!f.runtime.request("agent","phone",rejected)?.result);
  assert.equal(f.runtime.request("agent","http",first)?.result?.text,"accepted input only");
  assert.equal(f.runtime.request("agent","phone",rejected)?.result?.status,"failed");
  assert.equal(f.runtime.request("agent","phone",rejected)?.result?.text,"");
 }finally{await f.close();}
});


test("only confirmed participants expose the active turn ID and completed IDs survive successor turns", async () => {
  const f = await fixture({retainedBytes:16 * 1024 * 1024});
  try {
    const first = await f.submit("http"); await f.runtime.idle();
    const session = f.sessions[0]!;
    assert.equal(f.runtime.request("agent", "http", first)?.turn_id, session.id);
    const gate = deferred<void>();
    const admit = session.admit.bind(session);
    session.admit = async () => { await gate.promise; throw new RpcRequestError({message: "rejected"}); };
    const rejected = await f.submit("http");
    await until(() => !!f.store.snapshot().routes.agent!.active?.pendingAdmission);
    assert.equal(f.runtime.request("agent", "http", rejected)?.turn_id, undefined);
    assert.equal(f.runtime.request("agent", "http", first)?.turn_id, session.id);
    gate.resolve(); await f.runtime.idle();
    assert.equal(f.runtime.request("agent", "http", rejected)?.turn_id, undefined);
    session.admit = admit;
    const joined = await f.submit("http"); await f.runtime.idle();
    assert.equal(f.runtime.request("agent", "http", joined)?.turn_id, session.id);
    session.finish("done"); await until(() => !!f.runtime.request("agent", "http", first)?.result);
    const next = await f.submit("http"); await f.runtime.idle();
    assert.equal(f.runtime.request("agent", "http", next)?.turn_id, f.sessions[1]!.id);
    assert.equal(f.runtime.request("agent", "http", first)?.turn_id, session.id);
  } finally { await f.close(); }
});


test("completed delivery jobs release transient send tracking", async () => {
  const f = await fixture();
  try {
    f.upload.resolve();
    for (let i = 0; i < 4; i++) {
      const id = await f.submit("phone"); await f.runtime.idle();
      f.sessions.at(-1)!.finish("done");
      await until(() => !!f.runtime.request("agent", "phone", id)?.result);
      await until(() => f.store.snapshot().routes.agent!.outbox.length === 0);
      // The saved outbox changes before the transaction promise resumes cleanup.
      await until(() => (f.runtime as unknown as {live: Map<string, unknown>}).live.size === 0);
    }
    assert.equal(f.sent.length, 4);
  } finally { await f.close(); }
});

test("retention reserves one canonical copy of worst-case escaped output", async () => {
  const small = await fixture({retainedBytes: 1024 * 1024});
  try {
    await assert.rejects(small.submit("http"), {code: "capacity_exceeded"});
    assert.equal(small.store.snapshot().routes.agent!.receipts.length, 0);
  } finally { await small.close(); }
  const budget = 2 * 1024 * 1024;
  const f = await fixture({retainedBytes: budget});
  try {
    const id = await f.submit("http"); await f.runtime.idle();
    await assert.rejects(f.submit("phone"), {code: "capacity_exceeded"});
    const text = "\u0001".repeat(256 * 1024);
    f.sessions[0]!.finish(text);
    await until(() => !!f.runtime.request("agent", "http", id)?.result);
    const route = f.store.snapshot().routes.agent!;
    const retained = route.receipts.reduce((bytes, receipt) => bytes + receipt.reservedBytes!, 0)
      + Buffer.byteLength(JSON.stringify(route.completions));
    assert.ok(retained <= budget);
    assert.equal(f.runtime.request("agent", "http", id)?.result?.text, text);
  } finally { await f.close(); }
});


test("shared canonical completion survives restart without duplicate payloads or expired request resurrection", async () => {
  const f = await fixture(); let restarted: RequestRuntime | undefined;
  try {
    f.upload.resolve();
    f.runtime.settings.targets[0]!.adapters[1]!.outbound!.send = async () => ({status: "uncertain", retryable: false});
    await f.submit("phone"); await f.runtime.idle();
    const id = await f.submit("http"); await f.runtime.idle();
    f.sessions[0]!.finish("shared");
    await until(() => f.runtime.deliveryStatus()[0]?.state === "unresolved");
    const route = f.store.snapshot().routes.agent!;
    assert.equal(Object.keys(route.completions).length, 1);
    assert.ok(route.receipts.every(r => !("result" in r) && !("turnId" in r) && !("expiresAtMs" in r)));
    const completionId = route.receipts[0]!.completionId!;
    assert.ok(route.receipts.every(r => r.completionId === completionId));
    const broken = f.store.snapshot(); delete broken.routes.agent!.completions[completionId];
    assert.throws(() => validateState(broken), {code: "state_invalid"});
    assert.throws(() => receiptVisible(broken.routes.agent!, broken.routes.agent!.receipts[0]!, Date.now()), {code: "state_invalid"});
    await f.runtime.close();
    restarted = new RequestRuntime(f.runtime.settings, f.store, f.runtime.lifecycle); await restarted.start();
    assert.equal(restarted.request("agent", "http", id)?.result?.text, "shared");
    restarted.progress.publish(restarted.requestKey("agent", "http", id), {id, kind: "terminal", text: "shared"});
    f.advance(31 * 86400000);
    assert.equal(restarted.request("agent", "http", id), undefined);
    assert.equal(f.store.snapshot().routes.agent!.completions[completionId]!.result.text, "shared");
    const text = "new input";
    await restarted.submit("agent", {sourceId: "http", externalId: id, input: {text}, payloadHash: createHash("sha256").update(JSON.stringify([1,text])).digest("hex")});
    assert.equal(restarted.request("agent", "http", id)?.result, undefined);
    const replay = restarted.progress.watch(restarted.requestKey("agent", "http", id), () => {});
    assert.equal(replay.view.entries.length, 0); replay.close();
    await restarted.idle(); f.sessions.at(-1)!.finish("new result");
    await until(() => restarted!.request("agent", "http", id)?.result?.text === "new result");
    const pending = f.store.snapshot().routes.agent!.outbox[0]!;
    await restarted.callback("provider", pending.parts[0]!.id, pending.parts[0]!.callbackToken!, {status: "accepted", providerHandle: "old-send"});
    await until(() => f.store.snapshot().routes.agent!.outbox.length === 0);
  } finally { await restarted?.close(); await f.close(); }
});

test("late delivery callback cannot clear a newer execution error", async () => {
  const f = await fixture();
  try {
    f.upload.resolve();
    f.runtime.settings.targets[0]!.adapters[1]!.outbound!.send = async () => ({status: "uncertain", retryable: false});
    await f.submit("phone"); await f.runtime.idle(); f.sessions[0]!.finish("old reply");
    await until(() => f.runtime.deliveryStatus()[0]?.state === "unresolved");
    f.runtime.lifecycle.openSession = async () => { throw new RouterError("thread_unavailable", "backend unavailable"); };
    await f.submit("http"); await f.runtime.idle();
    const before = f.runtime.processingStatus(); assert.equal(before[0]!.state, "blocked");
    const part = f.store.snapshot().routes.agent!.outbox[0]!.parts[0]!;
    await f.runtime.callback("provider", part.id, part.callbackToken!, {status: "accepted", providerHandle: "old-send"});
    assert.deepEqual(f.runtime.processingStatus(), before);
  } finally { await f.close(); }
});

test("shared artifacts release only after the last destination settles", async () => {
  const f = await fixture();
  try {
    const target = f.runtime.settings.targets[0]!;
    const first = target.adapters[1]!;
    const second = {...first, binding: {id: "phone2", namespace: "provider", destination: {id: "conversation2", namespace: "provider", properties: {}}}};
    target.adapters.push(second); target.binding.sources.push(second.binding);
    await f.store.transaction(state => bindTargets(state, [{id: target.id, binding: target.binding}]));
    const artifacts = [{localPath: "/tmp/staged-only-for-test", name: "file", mediaType: "text/plain", size: 4}];
    f.runtime.lifecycle.stage = async () => ({result: {status: "completed", text: "reply", notices: []}, artifacts});
    const released: unknown[] = [];
    f.runtime.lifecycle.release = async (_target, work) => { if (!("kind" in work) && work.length) released.push(work); };
    first.outbound!.send = async () => ({status: "uncertain", retryable: false});
    f.upload.resolve();
    await f.submit("phone"); await f.runtime.idle(); await f.submit("phone2"); await f.runtime.idle();
    f.sessions[0]!.finish("reply");
    await until(() => f.runtime.deliveryStatus().length === 2 && f.runtime.deliveryStatus().every(d => d.state === "unresolved"));
    const jobs = f.store.snapshot().routes.agent!.outbox;
    const settle = async (job: typeof jobs[number]) => { const p = job.parts[0]!; await f.runtime.callback("provider", p.id, p.callbackToken!, {status: "accepted", providerHandle: p.id}); };
    await settle(jobs[0]!); await until(() => f.store.snapshot().routes.agent!.outbox.length === 1);
    assert.equal(released.length, 0);
    assert.equal(f.store.snapshot().routes.agent!.completions[jobs[0]!.completionId]!.artifacts.length, 1);
    await settle(jobs[1]!); await until(() => released.length === 1);
    assert.deepEqual(released, [artifacts]);
    assert.equal(f.store.snapshot().routes.agent!.outbox.length, 0);
  } finally { await f.close(); }
});
