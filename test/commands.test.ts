import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptedTurnId,
  connectRecoveryAppServer,
  findCorrelatedTurn,
  inspectRemoteAppServer,
  isReconnectable,
  waitForTurn,
  type SemanticMessage,
} from "../src/commands.js";
import type { AppServerConnection } from "../src/app-server.js";
import type { AgentConfig } from "../src/config.js";
import { RouterError, failedMessage } from "../src/errors.js";
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

const REMOTE_AGENT: AgentConfig = {
  id: "remote",
  label: "Remote",
  sshHost: "server",
  cwd: "/work",
  threadId: "thread",
  model: "model",
};

const LOCAL_AGENT: AgentConfig = {
  id: "local",
  label: "Local",
  cwd: "/work",
  threadId: "thread",
  model: "model",
};

function proxyConnection(): AppServerConnection {
  return { client: {} as JsonRpcClient, transportKind: "proxy", close: async () => undefined };
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

test("daemon start failures remain reconnectable after turn acceptance", () => {
  assert.equal(isReconnectable(new RouterError("app_server_start_failed", "not ready")), true);
});

test("recovery keeps local agents on proxy and uses daemon-aware connection for SSH", async () => {
  const calls: string[] = [];
  const operations = {
    connectLocalProxy: async () => { calls.push("local-proxy"); return proxyConnection(); },
    connectRemote: async (sshHost: string) => { calls.push(`remote:${sshHost}`); return proxyConnection(); },
  };
  await connectRecoveryAppServer(LOCAL_AGENT, operations);
  await connectRecoveryAppServer(REMOTE_AGENT, operations);
  assert.deepEqual(calls, ["local-proxy", "remote:server"]);
});

test("remote doctor reports startup readiness without starting or connecting", async () => {
  const calls: string[] = [];
  const checks = await inspectRemoteAppServer(REMOTE_AGENT, {
    probe: async () => { calls.push("probe"); return "absent"; },
    daemonAvailable: async () => { calls.push("capability"); return true; },
    connectProxy: async () => { calls.push("connect"); throw new Error("must not connect"); },
  });
  assert.deepEqual(calls, ["probe", "capability"]);
  assert.equal(checks[0]?.ok, true);
  assert.match(checks[0]?.text ?? "", /first send will start it/);
  assert.deepEqual(checks[1], { name: "agent:remote:thread", ok: false, text: "Task was not checked." });
});

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
