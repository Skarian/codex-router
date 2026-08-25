import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptedTurnId,
  acceptedSteerTurnId,
  cancelTurn,
  connectRecoveryAppServer,
  findCorrelatedTurn,
  inspectRemoteAppServer,
  isReconnectable,
  resumedThreadState,
  sendTurn,
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

class ScriptedTransport implements MessageTransport {
  readonly kind: TransportKind = "stdio";
  private messageListener: ((message: unknown) => void) | undefined;

  constructor(private readonly handle: (method: string, params: unknown) => unknown | Promise<unknown>) {}

  async start(): Promise<void> {}
  async send(message: unknown): Promise<void> {
    const request = message as { id?: number; method?: string; params?: unknown };
    if (typeof request.id !== "number" || typeof request.method !== "string") return;
    try {
      const result = await this.handle(request.method, request.params);
      this.messageListener?.({ id: request.id, result });
    } catch (error) {
      this.messageListener?.({ id: request.id, error: { message: error instanceof Error ? error.message : String(error) } });
    }
  }
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

function scriptedConnection(transport: ScriptedTransport): AppServerConnection {
  return { client: new JsonRpcClient(transport), transportKind: "stdio", close: async () => undefined };
}

function testOperations(connection: AppServerConnection) {
  return {
    checkDirectory: async () => ({ name: "cwd", ok: true, text: "ok" }),
    connect: async () => connection,
    clientUserMessageId: () => "client-message",
  };
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

test("idle send starts once and follows the client-correlated owning turn", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  let resumes = 0;
  const transport = new ScriptedTransport((method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume" && resumes++ === 0) {
      return { thread: { status: { type: "idle" }, turns: [] } };
    }
    if (method === "turn/start") return { turn: { id: "submission-id", status: "inProgress" } };
    if (method === "thread/resume") {
      return { thread: { status: { type: "idle" }, turns: [{
        id: "owning-turn",
        status: "completed",
        items: [
          { id: "user", type: "userMessage", clientId: "client-message" },
          { id: "final", type: "agentMessage", phase: "final_answer", text: "Started result" },
        ],
      }] } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const result = await sendTurn(LOCAL_AGENT, "hello", () => undefined, undefined, testOperations(scriptedConnection(transport)));
  assert.deepEqual(result.result, { type: "completed", text: "Started result" });
  assert.equal(calls.filter(({ method }) => method === "turn/start").length, 1);
  const start = calls.find(({ method }) => method === "turn/start")?.params as Record<string, unknown>;
  assert.equal(start.clientUserMessageId, "client-message");
  assert.equal(start.cwd, "/work");
});

test("idle send tolerates delayed client-message visibility without resending", async () => {
  let resumes = 0;
  let starts = 0;
  const transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      resumes += 1;
      if (resumes === 1) return { thread: { status: { type: "idle" }, turns: [] } };
      if (resumes === 2) return { thread: { status: { type: "active" }, turns: [{ id: "owning-turn", status: "inProgress", items: [] }] } };
      return { thread: { status: { type: "idle" }, turns: [{
        id: "owning-turn",
        status: "completed",
        items: [
          { id: "user", type: "userMessage", clientId: "client-message" },
          { id: "final", type: "agentMessage", phase: "final_answer", text: "Delayed result" },
        ],
      }] } };
    }
    if (method === "turn/start") {
      starts += 1;
      return { turn: { id: "submission-id", status: "inProgress" } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const result = await sendTurn(LOCAL_AGENT, "hello", () => undefined, undefined, testOperations(scriptedConnection(transport)));
  assert.deepEqual(result.result, { type: "completed", text: "Delayed result" });
  assert.equal(starts, 1);
  assert.equal(resumes, 3);
});

test("active send steers once, waits for the shared turn, and does not replay old commentary", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  let transport: ScriptedTransport;
  transport = new ScriptedTransport((method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") return { thread: { status: { type: "active" }, turns: [{
      id: "active-turn",
      status: "inProgress",
      items: [{ id: "old", type: "agentMessage", phase: "commentary", text: "Old progress" }],
    }] } };
    if (method === "turn/steer") {
      transport.receive("item/completed", { threadId: "thread", turnId: "active-turn", item: { id: "new", type: "agentMessage", phase: "commentary", text: "New progress" } });
      transport.receive("item/completed", { threadId: "thread", turnId: "active-turn", item: { id: "final", type: "agentMessage", phase: "final_answer", text: "Shared result" } });
      transport.receive("turn/completed", { threadId: "thread", turn: { id: "active-turn", status: "completed" } });
      return { turnId: "active-turn" };
    }
    throw new Error(`unexpected ${method}`);
  });
  const emitted: SemanticMessage[] = [];
  const result = await sendTurn(LOCAL_AGENT, "change focus", (message) => emitted.push(message), undefined, testOperations(scriptedConnection(transport)));
  assert.deepEqual(result.result, { type: "completed", text: "Shared result" });
  assert.deepEqual(emitted, [{ type: "commentary", text: "New progress" }]);
  assert.equal(calls.some(({ method }) => method === "turn/start"), false);
  assert.equal(calls.some(({ method }) => method === "turn/interrupt"), false);
  const steer = calls.find(({ method }) => method === "turn/steer")?.params as Record<string, unknown>;
  assert.deepEqual(steer, {
    threadId: "thread",
    input: [{ type: "text", text: "change focus", text_elements: [] }],
    clientUserMessageId: "client-message",
    expectedTurnId: "active-turn",
  });
});

test("active baseline does not hide completion of a partially streamed item", async () => {
  let transport: ScriptedTransport;
  transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") return { thread: { status: { type: "active" }, turns: [{
      id: "active-turn",
      status: "inProgress",
      items: [{ id: "same", type: "agentMessage", phase: "final_answer", text: "partial" }],
    }] } };
    if (method === "turn/steer") {
      transport.receive("item/completed", {
        threadId: "thread",
        turnId: "active-turn",
        item: { id: "same", type: "agentMessage", phase: "final_answer", text: "full" },
      });
      transport.receive("turn/completed", { threadId: "thread", turn: { id: "active-turn", status: "completed" } });
      return { turnId: "active-turn" };
    }
    throw new Error(`unexpected ${method}`);
  });
  const result = await sendTurn(LOCAL_AGENT, "change focus", () => undefined, undefined, testOperations(scriptedConnection(transport)));
  assert.deepEqual(result.result, { type: "completed", text: "full" });
});

test("idle admission does not hide completion of a partially streamed item", async () => {
  let resumes = 0;
  let transport: ScriptedTransport;
  transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      resumes += 1;
      if (resumes === 1) return { thread: { status: { type: "idle" }, turns: [] } };
      transport.receive("item/completed", {
        threadId: "thread",
        turnId: "owning-turn",
        item: { id: "same", type: "agentMessage", phase: "final_answer", text: "full" },
      });
      transport.receive("turn/completed", { threadId: "thread", turn: { id: "owning-turn", status: "completed" } });
      return { thread: { status: { type: "active" }, turns: [{
        id: "owning-turn",
        status: "inProgress",
        items: [
          { id: "user", type: "userMessage", clientId: "client-message" },
          { id: "same", type: "agentMessage", phase: "final_answer", text: "partial" },
        ],
      }] } };
    }
    if (method === "turn/start") return { turn: { id: "submission-id", status: "inProgress" } };
    throw new Error(`unexpected ${method}`);
  });
  const result = await sendTurn(LOCAL_AGENT, "hello", () => undefined, undefined, testOperations(scriptedConnection(transport)));
  assert.deepEqual(result.result, { type: "completed", text: "full" });
});

test("cancel interrupts one active turn and treats idle as a successful no-op", async () => {
  const activeCalls: Array<{ method: string; params: unknown }> = [];
  const activeTransport = new ScriptedTransport((method, params) => {
    activeCalls.push({ method, params });
    if (method === "thread/resume") return { thread: { status: { type: "active" }, turns: [{ id: "active-turn", status: "inProgress" }] } };
    if (method === "turn/interrupt") return {};
    throw new Error(`unexpected ${method}`);
  });
  assert.deepEqual(
    await cancelTurn(LOCAL_AGENT, async () => scriptedConnection(activeTransport)),
    { type: "interrupt_requested", agent: "local", turn_id: "active-turn" },
  );
  assert.deepEqual(activeCalls[1], { method: "turn/interrupt", params: { threadId: "thread", turnId: "active-turn" } });

  const idleCalls: string[] = [];
  const idleTransport = new ScriptedTransport((method) => {
    idleCalls.push(method);
    return { thread: { status: { type: "idle" }, turns: [] } };
  });
  assert.deepEqual(
    await cancelTurn(LOCAL_AGENT, async () => scriptedConnection(idleTransport)),
    { type: "already_idle", agent: "local" },
  );
  assert.deepEqual(idleCalls, ["thread/resume"]);
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
