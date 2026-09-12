import assert from "node:assert/strict";
import test from "node:test";
import { RouterError, failedMessage } from "../src/errors.js";
import { JsonRpcClient } from "../src/json-rpc.js";
import {
  acceptedSteerTurnId,
  acceptedTurnId,
  findCorrelatedTurn,
  resumedThreadState,
  waitForTurn,
  type SemanticMessage,
} from "../src/turn-state.js";
import type { MessageTransport, TransportKind } from "../src/transport.js";

class EventTransport implements MessageTransport {
  readonly kind: TransportKind = "stdio";
  private messageListener: ((message: unknown) => void) | undefined;
  async start(): Promise<void> {}
  async send(): Promise<void> {}
  async close(): Promise<void> {}
  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListener = listener;
    return () => { this.messageListener = undefined; };
  }
  onClose(): () => void { return () => undefined; }
  receive(method: string, params: unknown): void { this.messageListener?.({ method, params }); }
}

test("accepted turn responses preserve ambiguity when the turn id is invalid", () => {
  for (const [result, operation] of [
    [{ turn: {} }, "turn/start"],
    [{ id: "", status: "inProgress" }, "thread/resume"],
  ] as const) {
    assert.throws(
      () => acceptedTurnId(result, operation),
      (error: unknown) => error instanceof RouterError
        && error.code === "app_server_protocol_failed"
        && failedMessage(error).ambiguous === true,
    );
  }
});

test("steer responses must acknowledge the expected active turn", () => {
  assert.equal(acceptedSteerTurnId({ turnId: "active" }, "active"), "active");
  assert.throws(
    () => acceptedSteerTurnId({ turnId: "different" }, "active"),
    (error: unknown) => error instanceof RouterError && error.ambiguous,
  );
});

test("resumed thread state requires one authoritative active turn", () => {
  assert.equal(resumedThreadState({ thread: { status: { type: "idle" }, turns: [] } }).activeTurn, undefined);
  assert.equal(
    resumedThreadState({ thread: { status: { type: "active" }, turns: [{ id: "active", status: "inProgress" }] } }).activeTurn?.id,
    "active",
  );
  for (const turns of [[], [{ id: "a", status: "inProgress" }, { id: "b", status: "inProgress" }]]) {
    assert.throws(
      () => resumedThreadState({ thread: { status: { type: "active" }, turns } }),
      (error: unknown) => error instanceof RouterError && error.code === "app_server_protocol_failed",
    );
  }
});

test("waitForTurn emits only completed semantic units and the terminal final answer", async () => {
  const transport = new EventTransport();
  const client = new JsonRpcClient(transport);
  const emitted: SemanticMessage[] = [];
  const result = waitForTurn(client, "thread", "turn", (message) => emitted.push(message));

  transport.receive("item/completed", { threadId: "thread", turnId: "turn", item: { type: "commandExecution", command: "secret" } });
  transport.receive("item/completed", { threadId: "thread", turnId: "turn", item: { type: "reasoning", summary: ["First", "Second"] } });
  transport.receive("item/completed", { threadId: "thread", turnId: "turn", item: { type: "agentMessage", phase: "commentary", text: "Progress" } });
  transport.receive("item/completed", { threadId: "thread", turnId: "turn", item: { type: "agentMessage", phase: "final_answer", text: "Done" } });
  transport.receive("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });

  assert.deepEqual(emitted, [
    { type: "reasoning", text: "First\n\nSecond" },
    { type: "commentary", text: "Progress" },
  ]);
  assert.deepEqual(await result, { type: "completed", text: "Done" });
});

test("waitForTurn drains terminal notifications buffered before subscription", async () => {
  const transport = new EventTransport();
  const client = new JsonRpcClient(transport);
  const result = waitForTurn(client, "thread", "fast-turn", () => undefined, undefined, [
    { method: "item/completed", params: { threadId: "thread", turnId: "fast-turn", item: { type: "agentMessage", phase: "final_answer", text: "Immediate" } } },
    { method: "turn/completed", params: { threadId: "thread", turn: { id: "fast-turn", status: "completed" } } },
  ]);
  assert.deepEqual(await result, { type: "completed", text: "Immediate" });
});

test("waitForTurn ignores the removed router deadline and completes only on terminal state", async () => {
  const previous = process.env.CODEX_ROUTER_TURN_TIMEOUT_MS;
  process.env.CODEX_ROUTER_TURN_TIMEOUT_MS = "1";
  try {
    const transport = new EventTransport();
    const client = new JsonRpcClient(transport);
    let settled = false;
    const result = waitForTurn(client, "thread", "long-turn", () => undefined).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    transport.receive("item/completed", {
      threadId: "thread",
      turnId: "long-turn",
      item: { id: "final", type: "agentMessage", phase: "final_answer", text: "Eventually done" },
    });
    transport.receive("turn/completed", { threadId: "thread", turn: { id: "long-turn", status: "completed" } });
    assert.deepEqual(await result, { type: "completed", text: "Eventually done" });
  } finally {
    if (previous === undefined) delete process.env.CODEX_ROUTER_TURN_TIMEOUT_MS;
    else process.env.CODEX_ROUTER_TURN_TIMEOUT_MS = previous;
  }
});

test("waitForTurn exits promptly when the caller aborts", async () => {
  const transport = new EventTransport();
  const client = new JsonRpcClient(transport);
  const controller = new AbortController();
  const result = waitForTurn(client, "thread", "turn", () => undefined, controller.signal);
  controller.abort();
  await assert.rejects(
    result,
    (error: unknown) => error instanceof RouterError && error.code === "interrupted" && error.ambiguous,
  );
});

test("waitForTurn does not re-emit items restored after reconnect", async () => {
  const transport = new EventTransport();
  const client = new JsonRpcClient(transport);
  const emitted: SemanticMessage[] = [];
  const state = { seenItemIds: new Set<string>(), seenSemanticUnits: new Set<string>() };
  const result = waitForTurn(client, "thread", "turn", (message) => emitted.push(message), undefined, [
    { method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "reason", type: "reasoning", summary: ["Once"] } } },
    { method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "reason", type: "reasoning", summary: ["Once"] } } },
    { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Done" }] } } },
  ], state);
  assert.deepEqual(await result, { type: "completed", text: "Done" });
  assert.deepEqual(emitted, [{ type: "reasoning", text: "Once" }]);
});

test("waitForTurn deduplicates replayed semantic content even when persisted item ids change", async () => {
  const transport = new EventTransport();
  const client = new JsonRpcClient(transport);
  const emitted: SemanticMessage[] = [];
  const state = { seenItemIds: new Set<string>(), seenSemanticUnits: new Set<string>() };
  const result = waitForTurn(client, "thread", "turn", (message) => emitted.push(message), undefined, [
    { method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "live", type: "agentMessage", phase: "commentary", text: "Same progress" } } },
    { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [
      { id: "persisted", type: "agentMessage", phase: "commentary", text: "Same progress" },
      { id: "final", type: "agentMessage", phase: "final_answer", text: "Done" },
    ] } } },
  ], state);
  assert.deepEqual(await result, { type: "completed", text: "Done" });
  assert.deepEqual(emitted, [{ type: "commentary", text: "Same progress" }]);
});

test("findCorrelatedTurn uses the stable client user message id when turn/start response is lost", () => {
  const expected = {
    id: "accepted-turn",
    status: "inProgress",
    items: [{ id: "user", type: "userMessage", clientId: "client-message" }],
  };
  assert.equal(findCorrelatedTurn({ thread: { turns: [
    { id: "older", status: "completed", items: [] },
    expected,
  ] } }, undefined, "client-message"), expected);
  assert.equal(findCorrelatedTurn({ thread: { turns: [expected] } }, "accepted-turn", "irrelevant"), expected);
});

test("native images survive terminal reconstruction while the original baseline stays excluded", async () => {
  const { waitForOutcome } = await import("../src/turn-state.js");
  const transport = new EventTransport();
  const state = { seenItemIds: new Set<string>(), seenSemanticUnits: new Set<string>(), artifactBaseline: new Set(["old"]) };
  const result = waitForOutcome(new JsonRpcClient(transport), "thread", "turn", () => undefined, undefined, [], state);
  transport.receive("item/started", { threadId: "thread", turnId: "turn", item: { id: "incomplete", type: "imageGeneration", status: "inProgress" } });
  transport.receive("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed", items: [
    { id: "old", type: "imageGeneration", status: "completed", savedPath: "/old.png" },
    { id: "new", type: "imageGeneration", status: "completed", savedPath: "/new.png", result: "aGVsbG8=" },
    { id: "incomplete", type: "imageGeneration", status: "inProgress" },
  ] } });
  assert.deepEqual(await result, { turnId: "turn", status: "completed", imageGenerations: [
    { id: "new", savedPath: "/new.png", result: "aGVsbG8=" },
  ] });
});

test("terminal statuses without final text remain outcomes but preserve one-shot failures", async () => {
  const { terminalOutcome, textResult } = await import("../src/turn-state.js");
  for (const status of ["completed", "failed", "interrupted"] as const) {
    const outcome = terminalOutcome({ id: "turn", status }, { seenItemIds: new Set(), seenSemanticUnits: new Set() })!;
    assert.equal(outcome.status, status);
    assert.throws(() => textResult(outcome), (error: unknown) => error instanceof RouterError
      && error.code === (status === "interrupted" ? "interrupted" : "turn_failed"));
  }
});
