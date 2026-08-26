import { randomUUID } from "node:crypto";
import {
  connectAppServer,
  connectExistingProxy,
  type AppServerConnection,
} from "./app-server.js";
import type { AgentConfig } from "./config.js";
import { checkAgentDirectory } from "./doctor.js";
import { RouterError } from "./errors.js";
import type { JsonRpcClient } from "./json-rpc.js";
import {
  acceptedSteerTurnId,
  acceptedTurnId,
  applyTurnItems,
  baselineTurnItems,
  findCorrelatedTurn,
  resumedThreadState,
  terminalResult,
  waitForTurn,
  type Notification,
  type SemanticMessage,
  type TurnState,
} from "./turn-state.js";

const EFFECT_ACK_TIMEOUT_MS = 15_000;
const THREAD_RESUME_TIMEOUT_MS = 60_000;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export type CancelResult =
  | { type: "interrupt_requested"; agent: string; turn_id: string }
  | { type: "already_idle"; agent: string };

export interface RecoveryConnectionOperations {
  connectLocalProxy(): Promise<AppServerConnection>;
  connectRemote(sshHost: string): Promise<AppServerConnection>;
}

export interface TurnCommandOperations {
  checkDirectory(agent: AgentConfig): Promise<{ ok: boolean }>;
  connect(agent: AgentConfig): Promise<AppServerConnection>;
  clientUserMessageId(): string;
  effectAckTimeoutMs?: number;
  threadResumeTimeoutMs?: number;
  recovery?: RecoveryConnectionOperations;
  reconnectDelaysMs?: readonly number[];
}

const defaultTurnCommandOperations: TurnCommandOperations = {
  checkDirectory: checkAgentDirectory,
  connect: (agent) => connectAppServer(agent.sshHost),
  clientUserMessageId: randomUUID,
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isDisconnect(error: unknown): error is RouterError {
  return error instanceof RouterError && error.code === "app_server_disconnected";
}

function isReconnectable(error: unknown): boolean {
  return error instanceof RouterError && [
    "app_server_connect_failed",
    "app_server_disconnected",
    "app_server_start_failed",
    "timeout",
  ].includes(error.code);
}

function isRequestTimeout(error: unknown): error is RouterError {
  return error instanceof RouterError && error.code === "timeout";
}

function throwIfAborted(signal: AbortSignal | undefined, ambiguous: boolean): void {
  if (signal?.aborted) throw new RouterError("interrupted", "The Codex turn was interrupted by the caller.", { ambiguous });
}

async function reconnectDelay(
  attempt: number,
  signal?: AbortSignal,
  delaysMs: readonly number[] = RECONNECT_DELAYS_MS,
): Promise<void> {
  throwIfAborted(signal, true);
  const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 5_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RouterError("interrupted", "The Codex turn was interrupted by the caller.", { ambiguous: true }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function notificationBuffer(client: JsonRpcClient): { notifications: Notification[]; stop(): void } {
  const notifications: Notification[] = [];
  const stop = client.onNotification((method, params) => {
    if (notifications.length === 256) notifications.shift();
    notifications.push({ method, params });
  });
  return { notifications, stop };
}

function correlatedNotificationTurn(
  method: string,
  rawParams: unknown,
  threadId: string,
  clientUserMessageId: string,
): Record<string, unknown> | undefined {
  if (method !== "item/started" && method !== "item/completed") return undefined;
  const params = object(rawParams);
  const item = object(params?.item);
  if (params?.threadId !== threadId
    || item?.type !== "userMessage"
    || item.clientId !== clientUserMessageId
    || typeof params.turnId !== "string") return undefined;
  return { id: params.turnId, status: "inProgress", items: [item] };
}

function correlateAdmission(
  client: JsonRpcClient,
  threadId: string,
  clientUserMessageId: string,
  notifications: ReadonlyArray<Notification>,
  signal?: AbortSignal,
  expectedTurnId?: string,
  resumeTimeoutMs = THREAD_RESUME_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribeNotification: () => void = () => undefined;
    let unsubscribeClose: () => void = () => undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribeNotification();
      unsubscribeClose();
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const accept = (turn: Record<string, unknown>) => {
      if (expectedTurnId !== undefined && turn.id !== expectedTurnId) {
        finish(() => reject(new RouterError(
          "app_server_protocol_failed",
          "Codex persisted the input on a different turn than the one the router steered.",
          { ambiguous: true },
        )));
      } else {
        finish(() => resolve(turn));
      }
    };
    const handleNotification = (method: string, params: unknown) => {
      const turn = correlatedNotificationTurn(method, params, threadId, clientUserMessageId);
      if (turn) accept(turn);
    };
    const onAbort = () => finish(() => reject(new RouterError(
      "interrupted",
      "The Codex turn was interrupted by the caller.",
      { ambiguous: true },
    )));
    unsubscribeNotification = client.onNotification(handleNotification);
    unsubscribeClose = client.onClose((error) => finish(() => reject(error)));
    for (const notification of notifications) {
      handleNotification(notification.method, notification.params);
      if (settled) return;
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    void (async () => {
      while (!settled) {
        try {
          const resumed = await client.request("thread/resume", { threadId }, resumeTimeoutMs, signal);
          if (settled) return;
          const correlated = findCorrelatedTurn(resumed, undefined, clientUserMessageId);
          if (correlated) accept(correlated);
          return;
        } catch (error) {
          if (settled) return;
          if (!isRequestTimeout(error)) throw error;
        }
      }
    })().catch((error) => finish(() => reject(error)));
  });
}

async function connectRecoveryAppServer(
  agent: AgentConfig,
  operations: RecoveryConnectionOperations = {
    connectLocalProxy: () => connectExistingProxy(),
    connectRemote: (sshHost) => connectAppServer(sshHost),
  },
): Promise<AppServerConnection> {
  return agent.sshHost === undefined
    ? operations.connectLocalProxy()
    : operations.connectRemote(agent.sshHost);
}

async function recoverProxyTurn(
  agent: AgentConfig,
  turnId: string | undefined,
  clientUserMessageId: string,
  state: TurnState,
  emit: (message: SemanticMessage) => void,
  signal?: AbortSignal,
  expectedCorrelatedTurnId?: string,
  recoveryOperations?: RecoveryConnectionOperations,
  reconnectDelaysMs?: readonly number[],
): Promise<SemanticMessage> {
  let attempt = 0;
  let lastError: unknown;
  while (true) {
    await reconnectDelay(attempt, signal, reconnectDelaysMs);
    let connection: AppServerConnection | undefined;
    let buffered: ReturnType<typeof notificationBuffer> | undefined;
    let phase: "connect" | "resume" | "observe" = "connect";
    try {
      connection = await connectRecoveryAppServer(agent, recoveryOperations);
      connection.client.markTurnAccepted();
      buffered = notificationBuffer(connection.client);
      phase = "resume";
      let turn: Record<string, unknown>;
      if (turnId === undefined) {
        turn = await correlateAdmission(
          connection.client,
          agent.threadId,
          clientUserMessageId,
          buffered.notifications,
          signal,
          expectedCorrelatedTurnId,
        );
      } else {
        const resumed = await connection.client.request(
          "thread/resume",
          { threadId: agent.threadId },
          THREAD_RESUME_TIMEOUT_MS,
          signal,
        );
        const correlated = findCorrelatedTurn(resumed, turnId, clientUserMessageId);
        if (!correlated) {
          throw new RouterError(
            "app_server_protocol_failed",
            "The SSH connection was restored, but the accepted Codex turn was absent.",
            { ambiguous: true, cause: lastError },
          );
        }
        turn = correlated;
      }
      turnId = acceptedTurnId(turn, "thread/resume");
      if (turn.status !== "inProgress") applyTurnItems(turn, state, emit);
      const completed = terminalResult(turn, state);
      if (completed) return completed;
      const observation = waitForTurn(
        connection.client,
        agent.threadId,
        turnId,
        emit,
        signal,
        buffered.notifications,
        state,
      );
      buffered.stop();
      phase = "observe";
      try {
        return await observation;
      } catch (error) {
        if (!isDisconnect(error)) throw error;
        lastError = error;
      }
    } catch (error) {
      const retryable = phase === "connect"
        ? isReconnectable(error)
        : isDisconnect(error) || isRequestTimeout(error);
      if (!retryable) throw error;
      lastError = error;
    } finally {
      buffered?.stop();
      await connection?.close().catch(() => undefined);
    }
    attempt += 1;
  }
}

async function observeAcceptedTurn(
  connection: AppServerConnection,
  agent: AgentConfig,
  turn: Record<string, unknown>,
  clientUserMessageId: string,
  buffered: ReturnType<typeof notificationBuffer>,
  state: TurnState,
  emit: (message: SemanticMessage) => void,
  signal?: AbortSignal,
  recoveryOperations?: RecoveryConnectionOperations,
  reconnectDelaysMs?: readonly number[],
): Promise<SemanticMessage> {
  const turnId = acceptedTurnId(turn, "thread/resume");
  if (turn.status !== "inProgress") applyTurnItems(turn, state, emit);
  const completed = terminalResult(turn, state);
  if (completed) return completed;
  const resultPromise = waitForTurn(
    connection.client,
    agent.threadId,
    turnId,
    emit,
    signal,
    buffered.notifications,
    state,
  );
  buffered.stop();
  try {
    return await resultPromise;
  } catch (error) {
    if (connection.transportKind !== "proxy" || !isDisconnect(error)) throw error;
    await connection.close().catch(() => undefined);
    return recoverProxyTurn(
      agent,
      turnId,
      clientUserMessageId,
      state,
      emit,
      signal,
      undefined,
      recoveryOperations,
      reconnectDelaysMs,
    );
  }
}

export async function sendTurn(
  agent: AgentConfig,
  text: string,
  emit: (message: SemanticMessage) => void,
  signal?: AbortSignal,
  operations: TurnCommandOperations = defaultTurnCommandOperations,
): Promise<{ result: SemanticMessage; transportKind: "proxy" | "stdio" }> {
  throwIfAborted(signal, false);
  const directory = await operations.checkDirectory(agent);
  if (!directory.ok) throw new RouterError("working_directory_invalid", `${agent.label}'s working directory is unavailable.`);
  throwIfAborted(signal, false);
  const connection = await operations.connect(agent);
  const effectAckTimeoutMs = operations.effectAckTimeoutMs ?? EFFECT_ACK_TIMEOUT_MS;
  const threadResumeTimeoutMs = operations.threadResumeTimeoutMs ?? THREAD_RESUME_TIMEOUT_MS;
  const clientUserMessageId = operations.clientUserMessageId();
  const state: TurnState = { seenItemIds: new Set(), seenSemanticUnits: new Set() };
  const buffered = notificationBuffer(connection.client);
  try {
    let resumeResult: unknown;
    try {
      resumeResult = await connection.client.request(
        "thread/resume",
        { threadId: agent.threadId },
        threadResumeTimeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof RouterError && error.code === "interrupted") throw error;
      throw new RouterError("thread_unavailable", `${agent.label}'s Codex task could not be resumed.`, { cause: error });
    }
    const resumed = resumedThreadState(resumeResult);
    throwIfAborted(signal, false);
    connection.client.markTurnAccepted();
    let turn: Record<string, unknown>;
    let expectedTurnId: string | undefined;
    try {
      if (resumed.activeTurn) {
        baselineTurnItems(resumed.activeTurn, state);
        expectedTurnId = acceptedTurnId(resumed.activeTurn, "thread/resume");
        try {
          const steered = await connection.client.request("turn/steer", {
            threadId: agent.threadId,
            input: [{ type: "text", text, text_elements: [] }],
            clientUserMessageId,
            expectedTurnId,
          }, effectAckTimeoutMs, signal);
          acceptedSteerTurnId(steered, expectedTurnId);
          turn = resumed.activeTurn;
        } catch (error) {
          if (!isRequestTimeout(error)) throw error;
          turn = await correlateAdmission(
            connection.client,
            agent.threadId,
            clientUserMessageId,
            buffered.notifications,
            signal,
            expectedTurnId,
            threadResumeTimeoutMs,
          );
        }
      } else {
        try {
          await connection.client.request("turn/start", {
            threadId: agent.threadId,
            input: [{ type: "text", text, text_elements: [] }],
            clientUserMessageId,
            cwd: agent.cwd,
            approvalPolicy: "never",
            sandboxPolicy: { type: "dangerFullAccess" },
            model: agent.model,
            ...(agent.reasoning === undefined ? {} : { effort: agent.reasoning }),
            summary: "auto",
          }, effectAckTimeoutMs, signal);
        } catch (error) {
          if (!isRequestTimeout(error)) throw error;
        }
        turn = await correlateAdmission(
          connection.client,
          agent.threadId,
          clientUserMessageId,
          buffered.notifications,
          signal,
          undefined,
          threadResumeTimeoutMs,
        );
      }
    } catch (error) {
      if (connection.transportKind !== "proxy" || !isDisconnect(error)) throw error;
      await connection.close().catch(() => undefined);
      return {
        result: await recoverProxyTurn(
          agent,
          undefined,
          clientUserMessageId,
          state,
          emit,
          signal,
          expectedTurnId,
          operations.recovery,
          operations.reconnectDelaysMs,
        ),
        transportKind: "proxy",
      };
    }
    return {
      result: await observeAcceptedTurn(
        connection,
        agent,
        turn,
        clientUserMessageId,
        buffered,
        state,
        emit,
        signal,
        operations.recovery,
        operations.reconnectDelaysMs,
      ),
      transportKind: connection.transportKind,
    };
  } finally {
    buffered.stop();
    await connection.close().catch(() => undefined);
  }
}

export async function cancelTurn(
  agent: AgentConfig,
  connect: (agent: AgentConfig) => Promise<AppServerConnection> = defaultTurnCommandOperations.connect,
  effectAckTimeoutMs = EFFECT_ACK_TIMEOUT_MS,
): Promise<CancelResult> {
  const connection = await connect(agent);
  try {
    let resumeResult: unknown;
    try {
      resumeResult = await connection.client.request("thread/resume", { threadId: agent.threadId }, THREAD_RESUME_TIMEOUT_MS);
    } catch (error) {
      throw new RouterError("thread_unavailable", `${agent.label}'s Codex task could not be resumed.`, { cause: error });
    }
    const resumed = resumedThreadState(resumeResult);
    if (!resumed.activeTurn) return { type: "already_idle", agent: agent.id };
    const turnId = acceptedTurnId(resumed.activeTurn, "thread/resume");
    connection.client.markTurnAccepted();
    const result = await connection.client.request(
      "turn/interrupt",
      { threadId: agent.threadId, turnId },
      effectAckTimeoutMs,
    );
    const response = object(result);
    if (!response || Object.keys(response).length !== 0) {
      throw new RouterError("app_server_protocol_failed", "Codex app-server returned an invalid turn/interrupt response.", { ambiguous: true });
    }
    return { type: "interrupt_requested", agent: agent.id, turn_id: turnId };
  } finally {
    await connection.close().catch(() => undefined);
  }
}
