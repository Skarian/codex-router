import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcClient } from "../src/json-rpc.js";
import type { MessageTransport, TransportKind } from "../src/transport.js";

class FakeTransport implements MessageTransport {
  readonly kind: TransportKind = "stdio";
  readonly sent: unknown[] = [];
  private messageListener: ((message: unknown) => void) | undefined;
  private closeListener: ((error?: Error) => void) | undefined;

  async start(): Promise<void> {}
  async send(message: unknown): Promise<void> { this.sent.push(message); }
  async close(): Promise<void> {}
  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListener = listener;
    return () => { this.messageListener = undefined; };
  }
  onClose(listener: (error?: Error) => void): () => void {
    this.closeListener = listener;
    return () => { this.closeListener = undefined; };
  }
  receive(message: unknown): void { this.messageListener?.(message); }
  disconnect(): void { this.closeListener?.(new Error("gone")); }
}

test("JsonRpcClient correlates responses and emits notifications", async () => {
  const transport = new FakeTransport();
  const client = new JsonRpcClient(transport);
  const notifications: string[] = [];
  client.onNotification((method) => notifications.push(method));
  const pending = client.request("thread/read", { threadId: "thread" });
  assert.deepEqual(transport.sent[0], { id: 1, method: "thread/read", params: { threadId: "thread" } });
  transport.receive({ id: 1, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  transport.receive({ method: "thread/status/changed", params: {} });
  assert.deepEqual(notifications, ["thread/status/changed"]);
});

test("JsonRpcClient marks disconnects after acceptance as ambiguous", async () => {
  const transport = new FakeTransport();
  const client = new JsonRpcClient(transport);
  client.markTurnAccepted();
  const pending = client.request("test");
  transport.disconnect();
  await assert.rejects(pending, (error: unknown) => {
    const candidate = error as { code?: string; ambiguous?: boolean };
    return candidate.code === "app_server_disconnected" && candidate.ambiguous === true;
  });
});
