import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelTurn,
  sendTurn,
} from "../src/turn-session.js";
import type { SemanticMessage } from "../src/turn-state.js";
import type { AppServerConnection } from "../src/app-server.js";
import type { AgentConfig } from "../src/config.js";
import { RouterError } from "../src/errors.js";
import { JsonRpcClient } from "../src/json-rpc.js";
import type { MessageTransport, TransportKind } from "../src/transport.js";

const NO_RESPONSE = Symbol("no response");

class ScriptedTransport implements MessageTransport {
  private messageListener: ((message: unknown) => void) | undefined;
  private closeListener: ((error?: Error) => void) | undefined;

  constructor(
    private readonly handle: (method: string, params: unknown) => unknown | Promise<unknown>,
    readonly kind: TransportKind = "stdio",
  ) {}

  async start(): Promise<void> {}
  async send(message: unknown): Promise<void> {
    const request = message as { id?: number; method?: string; params?: unknown };
    if (typeof request.id !== "number" || typeof request.method !== "string") return;
    try {
      const result = await this.handle(request.method, request.params);
      if (result === NO_RESPONSE) return;
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
  onClose(listener: (error?: Error) => void): () => void {
    this.closeListener = listener;
    return () => { this.closeListener = undefined; };
  }
  receive(method: string, params: unknown): void { this.messageListener?.({ method, params }); }
  disconnect(): void { this.closeListener?.(new Error("forced disconnect")); }
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
  return { client: new JsonRpcClient(transport), transportKind: transport.kind, close: async () => undefined };
}

function testOperations(connection: AppServerConnection) {
  return {
    checkDirectory: async () => ({ name: "cwd", ok: true, text: "ok" }),
    connect: async () => connection,
    clientUserMessageId: () => "client-message",
  };
}

function fastTimeoutOperations(connection: AppServerConnection) {
  return {
    ...testOperations(connection),
    effectAckTimeoutMs: 5,
    threadResumeTimeoutMs: 25,
    reconnectDelaysMs: [1],
  };
}

test("send abort before setup prevents every mutation and connection", async () => {
  const controller = new AbortController();
  controller.abort();
  let checks = 0;
  let connects = 0;
  await assert.rejects(
    sendTurn(LOCAL_AGENT, "hello", () => undefined, controller.signal, {
      checkDirectory: async () => { checks += 1; return { name: "cwd", ok: true, text: "ok" }; },
      connect: async () => { connects += 1; return proxyConnection(); },
      clientUserMessageId: () => "client-message",
    }),
    (error: unknown) => error instanceof RouterError && error.code === "interrupted" && !error.ambiguous,
  );
  assert.equal(checks, 0);
  assert.equal(connects, 0);
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

test("idle send waits for delayed client-message notification without polling or resending", async () => {
  let resumes = 0;
  let starts = 0;
  let transport: ScriptedTransport;
  transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      resumes += 1;
      if (resumes === 1) return { thread: { status: { type: "idle" }, turns: [] } };
      setTimeout(() => {
        transport.receive("item/started", {
          threadId: "thread",
          turnId: "owning-turn",
          item: { id: "user", type: "userMessage", clientId: "client-message" },
        });
        transport.receive("item/completed", {
          threadId: "thread",
          turnId: "owning-turn",
          item: { id: "final", type: "agentMessage", phase: "final_answer", text: "Delayed result" },
        });
        transport.receive("turn/completed", { threadId: "thread", turn: { id: "owning-turn", status: "completed" } });
      }, 20);
      return { thread: { status: { type: "active" }, turns: [{ id: "owning-turn", status: "inProgress", items: [] }] } };
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
  assert.equal(resumes, 2);
});

test("turn/start acknowledgment timeout correlates without resending", async () => {
  let resumes = 0;
  let starts = 0;
  const transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      resumes += 1;
      if (resumes === 1) return { thread: { status: { type: "idle" }, turns: [] } };
      return { thread: { status: { type: "idle" }, turns: [{
        id: "owning-turn",
        status: "completed",
        items: [
          { id: "user", type: "userMessage", clientId: "client-message" },
          { id: "final", type: "agentMessage", phase: "final_answer", text: "Recovered start" },
        ],
      }] } };
    }
    if (method === "turn/start") {
      starts += 1;
      return NO_RESPONSE;
    }
    throw new Error(`unexpected ${method}`);
  });
  const result = await sendTurn(
    LOCAL_AGENT,
    "hello",
    () => undefined,
    undefined,
    fastTimeoutOperations(scriptedConnection(transport)),
  );
  assert.deepEqual(result.result, { type: "completed", text: "Recovered start" });
  assert.equal(starts, 1);
  assert.equal(resumes, 2);
});

test("definite turn/start rejection does not enter correlation or resend", async () => {
  let resumes = 0;
  let starts = 0;
  const transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      resumes += 1;
      return { thread: { status: { type: "idle" }, turns: [] } };
    }
    if (method === "turn/start") {
      starts += 1;
      throw new Error("rejected");
    }
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(
    sendTurn(LOCAL_AGENT, "hello", () => undefined, undefined, fastTimeoutOperations(scriptedConnection(transport))),
    (error: unknown) => error instanceof RouterError && error.code === "app_server_protocol_failed",
  );
  assert.equal(starts, 1);
  assert.equal(resumes, 1);
});

test("correlation retries a timed-out historical resume without resending", async () => {
  let resumes = 0;
  let starts = 0;
  const transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      resumes += 1;
      if (resumes === 1) return { thread: { status: { type: "idle" }, turns: [] } };
      if (resumes === 2) return NO_RESPONSE;
      return { thread: { status: { type: "idle" }, turns: [{
        id: "owning-turn",
        status: "completed",
        items: [
          { id: "user", type: "userMessage", clientId: "client-message" },
          { id: "final", type: "agentMessage", phase: "final_answer", text: "Found in history" },
        ],
      }] } };
    }
    if (method === "turn/start") {
      starts += 1;
      return { turn: { id: "submission", status: "inProgress" } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const result = await sendTurn(
    LOCAL_AGENT,
    "hello",
    () => undefined,
    undefined,
    fastTimeoutOperations(scriptedConnection(transport)),
  );
  assert.deepEqual(result.result, { type: "completed", text: "Found in history" });
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

test("turn/steer acknowledgment timeout requires client-id correlation without resending", async () => {
  let resumes = 0;
  let steers = 0;
  let transport: ScriptedTransport;
  transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      resumes += 1;
      if (resumes === 1) {
        return { thread: { status: { type: "active" }, turns: [{ id: "active-turn", status: "inProgress", items: [] }] } };
      }
      transport.receive("item/completed", {
        threadId: "thread",
        turnId: "active-turn",
        item: { id: "final", type: "agentMessage", phase: "final_answer", text: "Recovered steer" },
      });
      transport.receive("turn/completed", { threadId: "thread", turn: { id: "active-turn", status: "completed" } });
      return { thread: { status: { type: "active" }, turns: [{
        id: "active-turn",
        status: "inProgress",
        items: [{ id: "user", type: "userMessage", clientId: "client-message" }],
      }] } };
    }
    if (method === "turn/steer") {
      steers += 1;
      return NO_RESPONSE;
    }
    throw new Error(`unexpected ${method}`);
  });
  const result = await sendTurn(
    LOCAL_AGENT,
    "change focus",
    () => undefined,
    undefined,
    fastTimeoutOperations(scriptedConnection(transport)),
  );
  assert.deepEqual(result.result, { type: "completed", text: "Recovered steer" });
  assert.equal(steers, 1);
  assert.equal(resumes, 2);
});

test("caller abort during turn/steer acknowledgment is ambiguous and never resends", async () => {
  let steers = 0;
  const controller = new AbortController();
  const transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      return { thread: { status: { type: "active" }, turns: [{ id: "active-turn", status: "inProgress", items: [] }] } };
    }
    if (method === "turn/steer") {
      steers += 1;
      setTimeout(() => controller.abort(), 5);
      return NO_RESPONSE;
    }
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(
    sendTurn(LOCAL_AGENT, "change focus", () => undefined, controller.signal, {
      ...fastTimeoutOperations(scriptedConnection(transport)),
      effectAckTimeoutMs: 60_000,
    }),
    (error: unknown) => error instanceof RouterError && error.code === "interrupted" && error.ambiguous,
  );
  assert.equal(steers, 1);
});

test("timed-out steer rejects correlation to a different turn", async () => {
  let resumes = 0;
  let steers = 0;
  const transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      resumes += 1;
      if (resumes === 1) {
        return { thread: { status: { type: "active" }, turns: [{ id: "active-turn", status: "inProgress", items: [] }] } };
      }
      return { thread: { status: { type: "active" }, turns: [{
        id: "different-turn",
        status: "inProgress",
        items: [{ id: "user", type: "userMessage", clientId: "client-message" }],
      }] } };
    }
    if (method === "turn/steer") {
      steers += 1;
      return NO_RESPONSE;
    }
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(
    sendTurn(LOCAL_AGENT, "change focus", () => undefined, undefined, fastTimeoutOperations(scriptedConnection(transport))),
    (error: unknown) => error instanceof RouterError && error.code === "app_server_protocol_failed" && error.ambiguous,
  );
  assert.equal(steers, 1);
  assert.equal(resumes, 2);
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

test("cancel acknowledgment timeout is ambiguous and never resends interrupt", async () => {
  let interrupts = 0;
  const transport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      return { thread: { status: { type: "active" }, turns: [{ id: "active-turn", status: "inProgress" }] } };
    }
    if (method === "turn/interrupt") {
      interrupts += 1;
      return NO_RESPONSE;
    }
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(
    cancelTurn(LOCAL_AGENT, async () => scriptedConnection(transport), 5),
    (error: unknown) => error instanceof RouterError && error.code === "timeout" && error.ambiguous,
  );
  assert.equal(interrupts, 1);
});

test("identified-turn recovery retries until the persisted turn completes", async () => {
  let initialResumes = 0;
  let starts = 0;
  let initialTransport: ScriptedTransport;
  initialTransport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      initialResumes += 1;
      if (initialResumes === 1) return { thread: { status: { type: "idle" }, turns: [] } };
      setTimeout(() => initialTransport.disconnect(), 10);
      return { thread: { status: { type: "active" }, turns: [{
        id: "owning-turn",
        status: "inProgress",
        items: [{ id: "user", type: "userMessage", clientId: "client-message" }],
      }] } };
    }
    if (method === "turn/start") {
      starts += 1;
      return { turn: { id: "submission", status: "inProgress" } };
    }
    throw new Error(`unexpected ${method}`);
  }, "proxy");

  let recoveryAttempts = 0;
  const recoveredTransport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      return { thread: { status: { type: "idle" }, turns: [{
        id: "owning-turn",
        status: "completed",
        items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Recovered after retries" }],
      }] } };
    }
    throw new Error(`unexpected ${method}`);
  }, "proxy");
  const operations = {
    ...testOperations(scriptedConnection(initialTransport)),
    reconnectDelaysMs: [1],
    recovery: {
      connectLocalProxy: async () => { throw new Error("unexpected local recovery"); },
      connectRemote: async () => {
        recoveryAttempts += 1;
        if (recoveryAttempts < 4) throw new RouterError("app_server_connect_failed", "still offline");
        return scriptedConnection(recoveredTransport);
      },
    },
  };
  const result = await sendTurn(REMOTE_AGENT, "work", () => undefined, undefined, operations);
  assert.deepEqual(result.result, { type: "completed", text: "Recovered after retries" });
  assert.equal(starts, 1);
  assert.equal(recoveryAttempts, 4);
});

test("indefinite recovery stops on caller abort without resending", async () => {
  let initialResumes = 0;
  let starts = 0;
  let initialTransport: ScriptedTransport;
  initialTransport = new ScriptedTransport((method) => {
    if (method === "thread/resume") {
      initialResumes += 1;
      if (initialResumes === 1) return { thread: { status: { type: "idle" }, turns: [] } };
      setTimeout(() => initialTransport.disconnect(), 5);
      return { thread: { status: { type: "active" }, turns: [{
        id: "owning-turn",
        status: "inProgress",
        items: [{ id: "user", type: "userMessage", clientId: "client-message" }],
      }] } };
    }
    if (method === "turn/start") {
      starts += 1;
      return { turn: { id: "submission", status: "inProgress" } };
    }
    throw new Error(`unexpected ${method}`);
  }, "proxy");
  let recoveryAttempts = 0;
  const controller = new AbortController();
  const operations = {
    ...testOperations(scriptedConnection(initialTransport)),
    reconnectDelaysMs: [1],
    recovery: {
      connectLocalProxy: async () => { throw new Error("unexpected local recovery"); },
      connectRemote: async () => {
        recoveryAttempts += 1;
        throw new RouterError("app_server_connect_failed", "still offline");
      },
    },
  };
  const pending = sendTurn(REMOTE_AGENT, "work", () => undefined, controller.signal, operations);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof RouterError && error.code === "interrupted" && error.ambiguous,
  );
  assert.equal(starts, 1);
  assert.ok(recoveryAttempts > 1);
});
