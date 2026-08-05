import assert from "node:assert/strict";
import test from "node:test";
import { waitForTurn, type SemanticMessage } from "../src/commands.js";
import { JsonRpcClient } from "../src/json-rpc.js";
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

test("waitForTurn emits only completed semantic units and the terminal final answer", async () => {
  const transport = new EventTransport();
  const client = new JsonRpcClient(transport);
  const emitted: SemanticMessage[] = [];
  const result = waitForTurn(client, "thread", "turn", (message) => emitted.push(message));

  transport.receive("item/completed", {
    threadId: "thread",
    turnId: "turn",
    item: { type: "commandExecution", command: "secret" },
  });
  transport.receive("item/completed", {
    threadId: "thread",
    turnId: "turn",
    item: { type: "reasoning", summary: ["First", "Second"] },
  });
  transport.receive("item/completed", {
    threadId: "thread",
    turnId: "turn",
    item: { type: "agentMessage", phase: "commentary", text: "Progress" },
  });
  transport.receive("item/completed", {
    threadId: "thread",
    turnId: "turn",
    item: { type: "agentMessage", phase: "final_answer", text: "Done" },
  });
  transport.receive("turn/completed", {
    threadId: "thread",
    turn: { id: "turn", status: "completed" },
  });

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
