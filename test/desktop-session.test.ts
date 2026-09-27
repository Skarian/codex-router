import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopOutcome, desktopTurns } from "../src/desktop-session.js";

const user = { id: "user", type: "userMessage", clientId: "ours" };
const text = (id: string, value: string) => ({ id, type: "agentMessage", text: value });
test("Desktop joined-turn output excludes preceding replies and items begun before admission", () => {
  const outcome = desktopOutcome({ turnId: "joined", status: "completed", items: [text("old", "OLD"), user, text("started", "PREEXISTING"), { id: "image-old", type: "imageGeneration", status: "completed", savedPath: "/old.png" }, text("new", "NEW"), { id: "image-new", type: "imageGeneration", status: "completed", savedPath: "/new.png" }] }, "ours", ["started", "image-old"]);
  assert.equal(outcome?.finalText, "NEW");
  assert.deepEqual(outcome?.imageGenerations, [{ id: "image-new", savedPath: "/new.png" }]);
});
test("Desktop optimistic turn params do not establish admission or output boundaries", () => {
  assert.throws(() => desktopOutcome({ turnId: "t", status: "completed", params: { clientUserMessageId: "ours" }, items: [text("old", "OLD")] }, "ours", []), /authoritative/);
});
test("Desktop duplicate client IDs and ambiguous item identity withhold output", () => {
  assert.throws(() => desktopOutcome({ turnId: "t", status: "completed", items: [user, { ...user, id: "user2" }] }, "ours", []), /boundary/);
  assert.throws(() => desktopOutcome({ turnId: "t", status: "completed", items: [user, text("user", "BAD")] }, "ours", []), /ordering/);
});
test("Desktop polls active work and selects final response after its boundary", () => {
  assert.equal(desktopOutcome({ turnId: "t", status: "inProgress", items: [user] }, "ours", []), undefined);
  assert.equal(desktopOutcome({ turnId: "t", status: "completed", items: [user, text("a", "first"), { ...text("c", "comment"), phase: "commentary" }, text("b", "final")] }, "ours", [])?.finalText, "final");
});
test("Desktop full history rejects duplicate turns and missing ordered history", () => {
  assert.throws(() => desktopTurns({ turns: [{ turnId: "t", items: [] }, { turnId: "t", items: [] }] }), /duplicate/);
  assert.throws(() => desktopTurns({}), /ordered/);
});
const canonical = (entities: Record<string, unknown>) => ({ turns: [], threadRuntimeStatus: { type: "idle" }, turnHistory: { kind: "canonical", history: { isComplete: true, entitiesByKey: entities, islands: [{ entries: Object.keys(entities).map(key => ({ key, value: key })), olderBoundary: { status: "exhausted" }, newerBoundary: { status: "exhausted" } }] } } });
test("Desktop canonical island order supplies completed history and ignores optimistic drafts", () => {
  const snapshot = canonical({ "turn:a": { turnId: "a", status: "completed", items: [user] }, "tail:optimistic": { turnId: null, status: "inProgress", items: [] }, "turn:b": { turnId: "b", status: "completed", items: [] } });
  assert.deepEqual(desktopTurns(snapshot).map(turn => turn.turnId), ["a", "b"]);
});
test("Desktop canonical incomplete history and missing entity references fail closed", () => {
  const snapshot = canonical({ "turn:a": { turnId: "a", items: [] } });
  snapshot.turnHistory.history.isComplete = false;
  assert.throws(() => desktopTurns(snapshot), /incomplete/);
  snapshot.turnHistory.history.isComplete = true;
  delete snapshot.turnHistory.history.entitiesByKey["turn:a"];
  assert.throws(() => desktopTurns(snapshot), /references/);
});

import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopSession } from "../src/desktop-session.js";
import { DesktopIpc, DesktopResponseError } from "../src/desktop-ipc.js";
import type { AgentConfig } from "../src/config.js";
async function sessionFixture(run: (session: DesktopSession, control: { accepted: boolean; reads: number; starts: number; steers: number; pendingReads: number; runtimeStatus: string; inProgress: boolean; turnStatus: string; commentary: boolean; rolloutPath: string; items?: any[]; onHistory?: () => void }) => Promise<void>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "desktop-history-")));
  await mkdir(join(home, "sessions")); const rolloutPath = join(home, "sessions", "rollout.jsonl"); await writeFile(rolloutPath, "");
  const control: Parameters<Parameters<typeof sessionFixture>[0]>[1] = { accepted: false, reads: 0, starts: 0, steers: 0, pendingReads: 0, runtimeStatus: "idle", inProgress: false, turnStatus: "completed", commentary: false, rolloutPath };
  let listener: (frame: any) => void = () => {};
  const ipc = {
    clientId: "client", closed: false, follow() {}, close() {}, onFrame(fn: typeof listener) { listener = fn; return () => {}; },
    async request(method: string, params: any, version: number) {
      if (method === "thread-follower-steer-turn") { control.steers++; assert.equal(version, 1); assert.equal(params.clientUserMessageId, "followup"); assert.ok(params.restoreMessage.context); return {result:{result:{turnId:control.inProgress ? "external" : "accepted"}}}; }
      if (method === "thread-follower-start-turn") { control.starts++; control.accepted = true; return { result: { result: { turn: { id: "accepted" } } } }; }
      control.reads++; control.onHistory?.();
      const show = control.accepted && control.reads > control.pendingReads;
      const state = { ...canonical(show ? { "turn:accepted": { turnId: "accepted", status: control.turnStatus, items: control.items ?? [user, ...(control.commentary ? [{ ...text("progress", "streamed"), phase: "commentary" }] : []), text("answer", "expected")] } } : {}), id: "thread", hostId: "local", cwd: home, rolloutPath };
      state.threadRuntimeStatus.type = control.runtimeStatus;
      if (control.inProgress) Object.assign(state, canonical({ "turn:external": { turnId: "external", status: "inProgress", items: [] } }), { threadRuntimeStatus: { type: control.runtimeStatus } });
      listener({ type: "broadcast", method: "thread-stream-state-changed", sourceClientId: "owner", targetClientIds: ["client"], version: 11, params: { hostId: "local", conversationId: "thread", change: { type: "snapshot", revision: control.reads, conversationState: state } } });
      return { result: { revision: control.reads } };
    },
  };
  const Constructor = DesktopSession as unknown as new (agent: AgentConfig, ipc: DesktopIpc, owner: string, home: string) => DesktopSession;
  const session = new Constructor({ id: "a", label: "a", threadId: "thread", model: "model", cwd: home }, ipc as unknown as DesktopIpc, "owner", home);
  try { await run(session, control); } finally { await session.close(); await rm(home, { recursive: true, force: true }); }
}
test("Desktop acknowledgement before authoritative history waits without resending", async () => sessionFixture(async (session, control) => {
  await session.resume();
  assert.equal(await session.admit([{ type: "text", text: "test", text_elements: [] }], { clientUserMessageId: "ours" }), "accepted");
  control.pendingReads = control.reads + 1;
  assert.equal((await session.observe("accepted")).finalText, "expected");
  assert.equal(control.starts, 1);
}));
test("Desktop restore reconciles persisted UUID without starting another turn", async () => sessionFixture(async (session, control) => {
  control.accepted = true; control.pendingReads = 1;
  assert.equal(await session.restore(undefined, { clientUserMessageId: "ours" }, [], "ours"), "accepted");
  assert.equal((await session.observe("accepted")).finalText, "expected");
  assert.equal(control.starts, 0);
}));

test("Desktop admission uses the completed preflight without another history request", async () => sessionFixture(async (session, control) => {
  await session.resume();
  const reads = control.reads;
  await session.admit([{ type: "text", text: "test", text_elements: [] }], { clientUserMessageId: "ours" });
  assert.equal(control.reads, reads);
  assert.equal(control.starts, 1);
}));
for (const busyState of ["unprepared", "runtime", "turn"]) {
  test(`Desktop admission rejects ${busyState} busy state without dispatch`, async () => sessionFixture(async (session, control) => {
    if (busyState !== "unprepared") {
      control.runtimeStatus = busyState === "runtime" ? "active" : "idle";
      control.inProgress = busyState === "turn";
      await session.resume();
    }
    await assert.rejects(session.admit([{ type: "text", text: "test", text_elements: [] }], { clientUserMessageId: "ours" }), (error: any) => error.code === "thread_busy" && !error.ambiguous);
    assert.equal(control.starts, 0);
  }));
}
test("Desktop discovery only treats an owner-discovery rejection as definite absence", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "desktop-discovery-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  let ownerFound = false;
  let closes = 0;
  const ipc = {
    follow() {}, onFrame() { return () => {}; }, close() { closes++; },
    async request(method: string) {
      if (ownerFound && method === "thread-owner-discovery") return { handledByClientId: "owner" };
      throw new DesktopResponseError({ resultType: "error", error: "no-client-found" });
    },
  };
  t.mock.method(DesktopIpc, "connect", async () => ipc as unknown as DesktopIpc);
  const agent = { id: "a", label: "a", threadId: "thread", model: "model", cwd: home };
  try {
    assert.equal(await DesktopSession.discover(agent), undefined);
    ownerFound = true;
    await assert.rejects(DesktopSession.discover(agent), (error: unknown) => error instanceof DesktopResponseError && error.code === "app_server_disconnected");
    assert.ok(closes >= 2);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("Desktop emits completed commentary before terminal status and isolates observer errors", async () => sessionFixture(async (session, control) => {
  await session.resume();
  await session.admit([{ type: "text", text: "test", text_elements: [] }], { clientUserMessageId: "ours" });
  control.turnStatus = "inProgress"; control.commentary = true;
  await writeFile(control.rolloutPath, [
    { type: "session_meta", payload: { id: "thread", history_mode: "paginated" } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: "thread", turn_id: "accepted", item: { type: "AgentMessage", id: "progress", phase: "commentary", content: [{ type: "Text", text: "streamed" }] } } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  let observed = 0;
  const outcome = await session.observe("accepted", message => {
    assert.equal(control.turnStatus, "inProgress");
    assert.equal(message.itemId, "progress"); assert.equal(message.turnId, "accepted");
    assert.equal(message.text, "streamed"); observed++;
    control.turnStatus = "completed";
    throw new Error("consumer disconnected");
  });
  assert.equal(observed, 1); assert.equal(outcome.finalText, "expected");
  assert.equal(session.capabilities.commentary.state, "available");
}));

test("Desktop follow-up dispatches native steering without starting a second turn", async () => sessionFixture(async (session, control) => {
  await session.resume();
  await session.admit([{ type: "text", text: "first", text_elements: [] }], { clientUserMessageId: "ours" });
  control.turnStatus = "inProgress"; await session.resume();
  assert.equal(await session.admit([{type:"text",text:"redirect",text_elements:[]}], {clientUserMessageId:"followup",expectedTurnId:"accepted"}), "accepted");
  assert.equal(control.starts, 1); assert.equal(control.steers, 1);
  control.turnStatus = "completed";
  assert.equal((await session.observe("accepted")).finalText, "expected");
}));
test("Desktop external steering rejects stale identity before dispatch", async () => sessionFixture(async (session, control) => {
  control.inProgress = true; control.runtimeStatus = "active"; await session.resume();
  await assert.rejects(session.admit([], {clientUserMessageId:"followup",expectedTurnId:"stale"}), (e:any)=>e.code==="thread_busy" && !e.ambiguous);
  assert.equal(control.steers, 0);
  assert.equal(await session.admit([{type:"text",text:"redirect",text_elements:[]}],{clientUserMessageId:"followup",expectedTurnId:"external"}),"external");
  assert.equal(control.starts, 0); assert.equal(control.steers, 1);
}));

test("Desktop accepted steering uses the server marker as its output boundary", () => {
  const steer = {type:"steeringUserMessage",id:"draft",clientUserMessageId:"followup",targetTurnId:"t",status:"accepted",serverUserMessageId:"marker"};
  const turn = {turnId:"t",status:"completed",items:[user,steer,text("early","OLD"),{type:"steered",id:"marker"},text("late","NEW")]};
  assert.equal(desktopOutcome(turn,"followup",[])?.finalText,"NEW");
  assert.throws(()=>desktopOutcome({...turn,items:turn.items.filter(i=>i.id!=="marker")},"followup",[]),/boundary/);
  assert.throws(()=>desktopOutcome({...turn,items:[{...steer,status:"pending"},{type:"steered",id:"marker"}]},"followup",[]),/boundary/);
  assert.throws(()=>desktopOutcome({...turn,items:[...turn.items,{...steer,id:"duplicate"}]},"followup",[]),/boundary/);
});

for (const outcome of ["accepted", "mismatch", "rejected", "ended"]) test(`Desktop interruption ${outcome} uses only exact v4 turn`, async () => {
  const calls: unknown[] = [];
  const ipc = { clientId: "client", follow() {}, close() {}, onFrame() { return () => {}; },
    async request(...args: unknown[]) {
      calls.push(args);
      if (outcome === "rejected") throw new Error("unsupported interrupt version");
      return { result: { ok: true, interruptedTurnId: outcome === "mismatch" ? "other" : "turn" } };
    },
  };
  const Constructor = DesktopSession as unknown as new (agent: AgentConfig, ipc: DesktopIpc, owner: string, home: string) => DesktopSession;
  const session = new Constructor({ id: "a", label: "a", threadId: "thread", cwd: "/work", model: "model" }, ipc as unknown as DesktopIpc, "owner", "/home");
  Object.assign(session, { snapshot: { turns: [{ turnId: "turn", status: outcome === "ended" ? "completed" : "inProgress", items: [] }] } });
  try {
    if (outcome === "accepted") await session.interrupt("turn");
    else await assert.rejects(session.interrupt("turn"), (error: any) => outcome === "ended" ? error.code === "thread_busy" && !error.ambiguous : error.ambiguous === true);
    assert.deepEqual(calls, outcome === "ended" ? [] : [["thread-follower-interrupt-turn", { conversationId: "thread", expectedTurnId: "turn", mode: "user-stop" }, 4, "owner"]]);
  } finally { await session.close(); }
});


for (const mode of ["live", "restored"]) test(`Desktop ${mode} steering waits beyond the admission timeout without resending`, async t => sessionFixture(async (session, control) => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const receipt = { type: "steeringUserMessage", id: "draft", clientUserMessageId: "followup", targetTurnId: "accepted", status: "accepted", serverUserMessageId: null as string | null };
  control.accepted = true; control.turnStatus = "inProgress";
  control.items = [user, receipt, { ...text("old-progress", "OLD"), phase: "commentary" }, text("old-answer", "OLD")];
  control.onHistory = () => { now += 20000; };
  if (mode === "live") {
    control.runtimeStatus = "active";
    await session.resume();
    await session.admit([{ type: "text", text: "steer", text_elements: [] }], { clientUserMessageId: "followup", expectedTurnId: "accepted" });
  } else assert.equal(await session.restore("accepted", { clientUserMessageId: "followup", expectedTurnId: "accepted" }, [], "followup"), "accepted");
  const reads = control.reads;
  control.onHistory = () => {
    now += 20000;
    if (control.reads >= reads + 2) {
      receipt.serverUserMessageId = "marker";
      control.items!.push({ type: "steered", id: "marker" }, text("new-answer", "NEW"));
      control.turnStatus = "completed";
    }
  };
  await writeFile(control.rolloutPath, [
    { type: "session_meta", payload: { id: "thread", history_mode: "paginated" } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: "thread", turn_id: "accepted", item: { type: "AgentMessage", id: "old-progress", phase: "commentary", content: [{ type: "Text", text: "OLD" }] } } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const emitted: unknown[] = [];
  assert.equal((await session.observe("accepted", message => emitted.push(message))).finalText, "NEW");
  assert.deepEqual(emitted, []);
  assert.equal(control.starts, 0); assert.equal(control.steers, mode === "live" ? 1 : 0);
}));

for (const invalid of ["pending", "wrong-turn", "duplicate-receipt", "duplicate-marker", "terminal-without-marker"]) {
  test(`Desktop steering ${invalid} never produces output`, async t => sessionFixture(async (session, control) => {
    let now = 100000; t.mock.method(Date, "now", () => now);
    control.accepted = true;
    const receipt = { type: "steeringUserMessage", id: "draft", clientUserMessageId: "followup", targetTurnId: invalid === "wrong-turn" ? "other" : "accepted", status: invalid === "pending" ? "pending" : "accepted", serverUserMessageId: "marker" };
    control.items = [receipt];
    if (invalid === "duplicate-receipt") control.items.push({ ...receipt, id: "duplicate" });
    if (invalid !== "terminal-without-marker") control.items.push({ type: "steered", id: "marker" });
    if (invalid === "duplicate-marker") control.items.push({ type: "steered", id: "marker" });
    control.items.push(text("answer", "MUST NOT EMIT"));
    control.onHistory = () => { now += 20000; };
    if (["pending", "wrong-turn", "duplicate-receipt", "duplicate-marker"].includes(invalid)) {
      await assert.rejects(session.restore("accepted", { clientUserMessageId: "followup", expectedTurnId: "accepted" }, [], "followup"), (error: any) => error.code === "thread_unavailable" && error.ambiguous);
    } else {
      await session.restore("accepted", { clientUserMessageId: "followup", expectedTurnId: "accepted" }, [], "followup");
      const emitted: unknown[] = [];
      await assert.rejects(session.observe("accepted", value => emitted.push(value)), /authoritative user-message boundary/);
      assert.deepEqual(emitted, []);
    }
    assert.equal(control.starts, 0); assert.equal(control.steers, 0);
  }));
}
