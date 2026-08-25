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

class HangingSendTransport extends FakeTransport {
  override async send(message: unknown): Promise<void> {
    this.sent.push(message);
    await new Promise<void>(() => undefined);
  }
}

class LateRejectSendTransport extends FakeTransport {
  private rejectSend?: (error: Error) => void;
  override send(message: unknown): Promise<void> {
    this.sent.push(message);
    return new Promise<void>((_resolve, reject) => { this.rejectSend = reject; });
  }
  rejectAfterSettlement(): void { this.rejectSend?.(new Error("late send failure")); }
}

class InitializeThenHangTransport extends FakeTransport {
  override async send(message: unknown): Promise<void> {
    this.sent.push(message);
    const request = message as { id?: number; method?: string };
    if (request.method === "initialize" && typeof request.id === "number") {
      this.receive({ id: request.id, result: {} });
      return;
    }
    await new Promise<void>(() => undefined);
  }
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

test("JsonRpcClient aborts an in-flight accepted request promptly", async () => {
  const transport = new FakeTransport();
  const client = new JsonRpcClient(transport);
  const controller = new AbortController();
  client.markTurnAccepted();
  const pending = client.request("turn/start", {}, 60_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    const candidate = error as { code?: string; ambiguous?: boolean };
    return candidate.code === "interrupted" && candidate.ambiguous === true;
  });
  assert.equal(transport.sent.length, 1);
});

test("JsonRpcClient does not send a request when already aborted", async () => {
  const transport = new FakeTransport();
  const client = new JsonRpcClient(transport);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.request("turn/start", {}, 60_000, controller.signal), (error: unknown) => {
    const candidate = error as { code?: string; ambiguous?: boolean };
    return candidate.code === "interrupted" && candidate.ambiguous === false;
  });
  assert.equal(transport.sent.length, 0);
});

test("JsonRpcClient timeout bounds a transport send that never settles", async () => {
  const transport = new HangingSendTransport();
  const client = new JsonRpcClient(transport);
  await assert.rejects(client.request("thread/read", {}, 5), (error: unknown) => {
    const candidate = error as { code?: string };
    return candidate.code === "timeout";
  });
  assert.equal(transport.sent.length, 1);
});

test("JsonRpcClient keeps abort as the first result when send rejects later", async () => {
  const transport = new LateRejectSendTransport();
  const client = new JsonRpcClient(transport);
  const controller = new AbortController();
  client.markTurnAccepted();
  const pending = client.request("turn/steer", {}, 60_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    const candidate = error as { code?: string; ambiguous?: boolean };
    return candidate.code === "interrupted" && candidate.ambiguous === true;
  });
  transport.rejectAfterSettlement();
  await new Promise((resolve) => setImmediate(resolve));
});

test("JsonRpcClient bounds the initialized notification write", async () => {
  const transport = new InitializeThenHangTransport();
  const client = new JsonRpcClient(transport);
  await assert.rejects(client.initialize(5), (error: unknown) => {
    const candidate = error as { code?: string };
    return candidate.code === "timeout";
  });
  assert.deepEqual(
    transport.sent.map((message) => (message as { method?: string }).method),
    ["initialize", "initialized"],
  );
});
