import test from "node:test";
import assert from "node:assert/strict";
import { sendTurn, cancelTurn } from "../src/execution-commands.js";
import { openExecutionSession, type ExecutionSession } from "../src/execution-session.js";
import type { AgentConfig } from "../src/config.js";
import type { AdmissionIntent } from "../src/turn-session.js";
import { RouterError } from "../src/errors.js";
const agent: AgentConfig = { id: "test", label: "test", cwd: "/work", threadId: "thread", model: "model" };
function fixture(active = true, backend: "desktop" | "stdio" = "desktop") {
  const calls: string[] = [];
  let intent: AdmissionIntent | undefined;
  const session = {
    backend,
    async resume() { calls.push("resume"); return { thread: { id: "thread", turns: [] }, ...(active ? { activeTurn: { id: "active" } } : {}) }; },
    async admit(_input: unknown, value: AdmissionIntent) { calls.push("admit"); intent = value; return active ? "active" : "new"; },
    async observe(turnId: string, emit?: (message: { type: "commentary"; text: string }) => void) { calls.push("observe"); emit?.({ type: "commentary", text: "working" }); return { turnId, status: "completed", finalText: "answer", imageGenerations: [] }; },
    async interrupt(turnId: string) { calls.push(`interrupt:${turnId}`); },
    async close() { calls.push("close"); },
  } as unknown as ExecutionSession;
  return { session, calls, intent: () => intent };
}
for (const active of [false, true]) test(`CLI uses Desktop owner for ${active ? "steering" : "starting"} and preserves output`, async () => {
  const f = fixture(active), emitted: unknown[] = [];
  const open = (a: AgentConfig, signal: AbortSignal) => openExecutionSession(a, signal, undefined, {
    desktop: async () => f.session, direct: async () => { throw Error("must not open competing direct connection"); },
  });
  const result = await sendTurn(agent, "hello", message => emitted.push(message), undefined, open);
  assert.equal(result.transportKind, "desktop");
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { type: "completed", text: "answer" });
  assert.deepEqual(emitted, [{ type: "commentary", text: "working" }]);
  assert.equal(f.intent()?.expectedTurnId, active ? "active" : undefined);
  assert.match(f.intent()!.clientUserMessageId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(f.calls, ["resume", "admit", "observe", "close"]);
});
test("CLI uses direct backend only when Desktop discovery establishes absence", async () => {
  const f = fixture(false, "stdio"); let direct = 0;
  const open = (a: AgentConfig, signal: AbortSignal) => openExecutionSession(a, signal, undefined, {
    desktop: async () => undefined, direct: async () => { direct++; return f.session; },
  });
  assert.equal((await sendTurn(agent, "hello", () => {}, undefined, open)).transportKind, "stdio");
  assert.equal(direct, 1);
});
test("CLI cancellation targets current owner once; idle cancellation is a no-op", async () => {
  for (const active of [true, false]) {
    const f = fixture(active);
    const result = await cancelTurn(agent, async () => f.session);
    assert.deepEqual(result, active ? { type: "interrupt_requested", agent: "test", turn_id: "active" } : { type: "already_idle", agent: "test" });
    assert.deepEqual(f.calls, active ? ["resume", "interrupt:active", "close"] : ["resume", "close"]);
  }
});
test("CLI does not switch backend or repeat an uncertain mutation", async () => {
  const f = fixture(); let opens = 0;
  f.session.interrupt = async () => { f.calls.push("interrupt"); throw new RouterError("timeout", "uncertain", { ambiguous: true }); };
  await assert.rejects(cancelTurn(agent, async () => { opens++; return f.session; }), (error: any) => error.ambiguous);
  assert.equal(opens, 1); assert.deepEqual(f.calls, ["resume", "interrupt", "close"]);
});
test("CLI abort before opening avoids every connection", async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(sendTurn(agent, "hello", () => {}, abort.signal, async () => { throw Error("must not connect"); }), (error: any) => error.code === "interrupted");
});
