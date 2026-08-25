import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentConfig, RouterConfig } from "./config.js";
import { RouterError } from "./errors.js";
import {
  connectAppServer,
  connectExistingProxy,
  connectExistingRemoteProxy,
  remoteControlSocketState,
  remoteDaemonAvailable,
  type AppServerConnection,
} from "./app-server.js";
import type { JsonRpcClient } from "./json-rpc.js";
import { codexProcessSpec, sshProcessSpec } from "./transport.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;
const EFFECT_ACK_TIMEOUT_MS = 15_000;
const THREAD_RESUME_TIMEOUT_MS = 60_000;
const REMOTE_COMMAND_TIMEOUT_MS = 15_000;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

interface TurnState {
  finalText?: string;
  readonly seenItemIds: Set<string>;
  readonly seenSemanticUnits: Set<string>;
}

interface Notification {
  method: string;
  params: unknown;
}

interface ResumedThreadState {
  thread: Record<string, unknown>;
  activeTurn?: Record<string, unknown>;
}

export interface SemanticMessage {
  type: "reasoning" | "commentary" | "completed";
  text: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  text: string;
}

export type CancelResult =
  | { type: "interrupt_requested"; agent: string; turn_id: string }
  | { type: "already_idle"; agent: string };

export interface TurnCommandOperations {
  checkDirectory(agent: AgentConfig): Promise<DoctorCheck>;
  connect(agent: AgentConfig): Promise<AppServerConnection>;
  clientUserMessageId(): string;
  effectAckTimeoutMs?: number;
  threadResumeTimeoutMs?: number;
  recovery?: RecoveryConnectionOperations;
  reconnectDelaysMs?: readonly number[];
}

const defaultTurnCommandOperations: TurnCommandOperations = {
  checkDirectory,
  connect: (agent) => connectAppServer(agent.sshHost),
  clientUserMessageId: randomUUID,
};

export interface RemoteDoctorOperations {
  probe(): Promise<"absent" | "socket">;
  daemonAvailable(): Promise<boolean>;
  connectProxy(): Promise<AppServerConnection>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function resumedThreadState(resumeResult: unknown): ResumedThreadState {
  const thread = object(object(resumeResult)?.thread);
  const status = object(thread?.status);
  if (!thread || !status || !Array.isArray(thread.turns)) {
    throw new RouterError("app_server_protocol_failed", "Codex app-server returned an invalid thread/resume response.");
  }
  const activeTurns = thread.turns
    .map((value) => object(value))
    .filter((turn): turn is Record<string, unknown> => turn?.status === "inProgress");
  if (status.type === "idle" && activeTurns.length === 0) return { thread };
  if (status.type === "active" && activeTurns.length === 1) return { thread, activeTurn: activeTurns[0]! };
  throw new RouterError("app_server_protocol_failed", "Codex app-server returned inconsistent active-turn state.");
}

function bounded(text: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
    throw new RouterError("output_too_large", "Codex produced a message too large for the router output contract.");
  }
  return text;
}

export function listAgents(config: RouterConfig): Array<{ id: string; label: string }> {
  return config.agents.map(({ id, label }) => ({ id, label }));
}

export function formatAgentTable(config: RouterConfig): string {
  const rows = [["ID", "LABEL"], ...config.agents.map(({ id, label }) => [id, label])];
  const width = Math.max(...rows.map(([id]) => id?.length ?? 0));
  return rows.map(([id, label]) => `${id?.padEnd(width)}  ${label}`).join("\n");
}

export async function inspectRemoteAppServer(agent: AgentConfig, operations: RemoteDoctorOperations): Promise<DoctorCheck[]> {
  const state = await operations.probe();
  if (state === "absent") {
    const daemonAvailable = await operations.daemonAvailable();
    return [
      {
        name: `agent:${agent.id}:app-server`,
        ok: daemonAvailable,
        text: daemonAvailable
          ? "Persistent app-server is not running; the first send will start it."
          : "Persistent app-server is not running, and this Codex installation does not support durable daemon startup.",
      },
      { name: `agent:${agent.id}:thread`, ok: false, text: "Task was not checked." },
    ];
  }

  let connection: AppServerConnection | undefined;
  try {
    connection = await operations.connectProxy();
    const checks: DoctorCheck[] = [{
      name: `agent:${agent.id}:app-server`,
      ok: true,
      text: "Persistent app-server initialized over SSH proxy.",
    }];
    try {
      await connection.client.request("thread/read", { threadId: agent.threadId, includeTurns: false });
      checks.push({ name: `agent:${agent.id}:thread`, ok: true, text: "Task exists." });
    } catch {
      checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task is unavailable." });
    }
    return checks;
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

async function checkDirectory(agent: AgentConfig): Promise<DoctorCheck> {
  if (agent.sshHost !== undefined) {
    try {
      const spec = sshProcessSpec(agent.sshHost, ["test", "-d", agent.cwd]);
      await execFileAsync(spec.command, spec.args, { timeout: REMOTE_COMMAND_TIMEOUT_MS });
      return { name: `agent:${agent.id}:cwd`, ok: true, text: "Working directory is accessible." };
    } catch {
      return { name: `agent:${agent.id}:cwd`, ok: false, text: "Working directory is not accessible." };
    }
  }
  try {
    const info = await stat(agent.cwd);
    return info.isDirectory()
      ? { name: `agent:${agent.id}:cwd`, ok: true, text: "Working directory is accessible." }
      : { name: `agent:${agent.id}:cwd`, ok: false, text: "Working directory is not a directory." };
  } catch {
    return { name: `agent:${agent.id}:cwd`, ok: false, text: "Working directory is not accessible." };
  }
}

export async function runDoctor(config: RouterConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [{ name: "config", ok: true, text: "Configuration is valid." }];
  const localAgents = config.agents.filter(({ sshHost }) => sshHost === undefined);
  const remoteAgents = config.agents.filter(({ sshHost }) => sshHost !== undefined);
  if (localAgents.length > 0 || config.agents.length === 0) {
    try {
      const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 5_000 });
      checks.push({ name: "codex", ok: true, text: stdout.trim() || "Codex executable is available." });
    } catch {
      checks.push({ name: "codex", ok: false, text: "Codex executable is unavailable." });
    }
  }
  checks.push(...await Promise.all(config.agents.map(checkDirectory)));

  for (const agent of remoteAgents) {
    try {
      const spec = codexProcessSpec(["--version"], agent.sshHost);
      const { stdout } = await execFileAsync(spec.command, spec.args, { timeout: REMOTE_COMMAND_TIMEOUT_MS });
      checks.push({ name: `agent:${agent.id}:codex`, ok: true, text: stdout.trim() || "Codex executable is available." });
    } catch {
      checks.push({ name: `agent:${agent.id}:codex`, ok: false, text: "Codex executable is unavailable." });
    }
  }

  if (localAgents.length > 0 || config.agents.length === 0) {
    let connection: Awaited<ReturnType<typeof connectAppServer>> | undefined;
    try {
      connection = await connectAppServer();
      checks.push({ name: "app-server", ok: true, text: `App-server initialized over ${connection.transportKind}.` });
      for (const agent of localAgents) {
        try {
          await connection.client.request("thread/read", { threadId: agent.threadId, includeTurns: false });
          checks.push({ name: `agent:${agent.id}:thread`, ok: true, text: "Task exists." });
        } catch {
          checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task is unavailable." });
        }
      }
    } catch {
      checks.push({ name: "app-server", ok: false, text: "App-server is unavailable." });
      for (const agent of localAgents) {
        checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task was not checked." });
      }
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  for (const agent of remoteAgents) {
    try {
      checks.push(...await inspectRemoteAppServer(agent, {
        probe: () => remoteControlSocketState(agent.sshHost!),
        daemonAvailable: () => remoteDaemonAvailable(agent.sshHost!),
        connectProxy: () => connectExistingRemoteProxy(agent.sshHost!),
      }));
    } catch {
      checks.push({ name: `agent:${agent.id}:app-server`, ok: false, text: "App-server is unavailable over SSH." });
      checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task was not checked." });
    }
  }
  return checks;
}

export function waitForTurn(
  client: JsonRpcClient,
  threadId: string,
  turnId: string,
  emit: (message: SemanticMessage) => void,
  signal?: AbortSignal,
  initialNotifications: ReadonlyArray<Notification> = [],
  state: TurnState = { seenItemIds: new Set(), seenSemanticUnits: new Set() },
): Promise<SemanticMessage> {
  return new Promise((resolve, reject) => {
    const finish = (callback: () => void) => {
      unsubscribe();
      unsubscribeClose();
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new RouterError("interrupted", "The Codex turn was interrupted by the caller.", { ambiguous: true })));
    const unsubscribeClose = client.onClose((error) => finish(() => reject(error)));
    const handleNotification = (method: string, rawParams: unknown) => {
      try {
        const params = object(rawParams);
        if (!params || params.threadId !== threadId) return;
        if (method === "item/completed" && params.turnId === turnId) {
          const item = object(params.item);
          if (item) applyCompletedItem(item, state, emit);
          return;
        }
        if (method !== "turn/completed") return;
        const turn = object(params.turn);
        if (!turn || turn.id !== turnId) return;
        applyTurnItems(turn, state, emit);
        if (turn.status === "completed" && state.finalText !== undefined) {
          const result: SemanticMessage = { type: "completed", text: state.finalText };
          finish(() => resolve(result));
        } else if (turn.status === "interrupted") {
          finish(() => reject(new RouterError("interrupted", "The Codex turn was interrupted.")));
        } else {
          finish(() => reject(new RouterError("turn_failed", "The Codex turn failed before producing a final response.")));
        }
      } catch (error) {
        finish(() => reject(error instanceof RouterError
          ? error
          : new RouterError("app_server_protocol_failed", "Codex app-server emitted an invalid turn event.", { cause: error })));
      }
    };
    const unsubscribe = client.onNotification(handleNotification);
    for (const notification of initialNotifications) handleNotification(notification.method, notification.params);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function applyCompletedItem(item: Record<string, unknown>, state: TurnState, emit: (message: SemanticMessage) => void): void {
  const itemId = typeof item.id === "string" ? item.id : undefined;
  if (itemId !== undefined) {
    if (state.seenItemIds.has(itemId)) return;
    state.seenItemIds.add(itemId);
  }
  if (item.type === "reasoning" && Array.isArray(item.summary)) {
    const text = bounded(item.summary.filter((part): part is string => typeof part === "string").join("\n\n"));
    const semanticKey = `reasoning\0${text}`;
    if (text && !state.seenSemanticUnits.has(semanticKey)) {
      state.seenSemanticUnits.add(semanticKey);
      emit({ type: "reasoning", text });
    }
  }
  if (item.type === "agentMessage" && typeof item.text === "string") {
    if (item.phase === "commentary") {
      const text = bounded(item.text);
      const semanticKey = `commentary\0${text}`;
      if (!state.seenSemanticUnits.has(semanticKey)) {
        state.seenSemanticUnits.add(semanticKey);
        emit({ type: "commentary", text });
      }
    }
    if (item.phase === "final_answer") state.finalText = bounded(item.text);
  }
}

function applyTurnItems(turn: Record<string, unknown>, state: TurnState, emit: (message: SemanticMessage) => void): void {
  if (!Array.isArray(turn.items)) return;
  for (const rawItem of turn.items) {
    const item = object(rawItem);
    if (item) applyCompletedItem(item, state, emit);
  }
}

function baselineTurnItems(turn: Record<string, unknown>, state: TurnState): void {
  if (!Array.isArray(turn.items)) return;
  for (const rawItem of turn.items) {
    const item = object(rawItem);
    if (item?.type === "reasoning" && Array.isArray(item.summary)) {
      const text = bounded(item.summary.filter((part): part is string => typeof part === "string").join("\n\n"));
      if (text) state.seenSemanticUnits.add(`reasoning\0${text}`);
    }
    if (item?.type === "agentMessage" && item.phase === "commentary" && typeof item.text === "string") {
      state.seenSemanticUnits.add(`commentary\0${bounded(item.text)}`);
    }
  }
}

function validateCorrelatedTurn(
  turn: Record<string, unknown>,
  expectedTurnId: string | undefined,
): Record<string, unknown> {
  if (expectedTurnId !== undefined && turn.id !== expectedTurnId) {
    throw new RouterError(
      "app_server_protocol_failed",
      "Codex persisted the input on a different turn than the one the router steered.",
      { ambiguous: true },
    );
  }
  return turn;
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
      try {
        const validated = validateCorrelatedTurn(turn, expectedTurnId);
        finish(() => resolve(validated));
      } catch (error) {
        finish(() => reject(error));
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
          if (!(error instanceof RouterError) || error.code !== "timeout") throw error;
        }
      }
    })().catch((error) => finish(() => reject(error)));
  });
}

export function findCorrelatedTurn(resumeResult: unknown, turnId: string | undefined, clientUserMessageId: string): Record<string, unknown> | undefined {
  const thread = object(object(resumeResult)?.thread);
  if (!Array.isArray(thread?.turns)) return undefined;
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = object(thread.turns[index]);
    if (!turn) continue;
    if (turnId !== undefined && turn.id === turnId) return turn;
    if (turnId === undefined && Array.isArray(turn.items) && turn.items.some((rawItem) => {
      const item = object(rawItem);
      return item?.type === "userMessage" && item.clientId === clientUserMessageId;
    })) return turn;
  }
  return undefined;
}

function terminalResult(turn: Record<string, unknown>, state: TurnState): SemanticMessage | undefined {
  if (turn.status === "inProgress") return undefined;
  if (turn.status === "completed" && state.finalText !== undefined) return { type: "completed", text: state.finalText };
  if (turn.status === "interrupted") throw new RouterError("interrupted", "The Codex turn was interrupted.");
  throw new RouterError("turn_failed", "The Codex turn failed before producing a final response.");
}

function isDisconnect(error: unknown): error is RouterError {
  return error instanceof RouterError && error.code === "app_server_disconnected";
}

export function isReconnectable(error: unknown): boolean {
  return error instanceof RouterError && [
    "app_server_connect_failed",
    "app_server_disconnected",
    "app_server_start_failed",
    "timeout",
  ].includes(error.code);
}

export function acceptedTurnId(result: unknown, operation: "turn/start" | "thread/resume"): string {
  const turn = operation === "turn/start"
    ? object(object(result)?.turn)
    : object(result);
  if (typeof turn?.id !== "string" || turn.id.length === 0) {
    throw new RouterError("app_server_protocol_failed", `Codex app-server returned an invalid ${operation} turn.`, { ambiguous: true });
  }
  return turn.id;
}

export function acceptedSteerTurnId(result: unknown, expectedTurnId: string): string {
  const turnId = object(result)?.turnId;
  if (typeof turnId !== "string" || turnId.length === 0 || turnId !== expectedTurnId) {
    throw new RouterError("app_server_protocol_failed", "Codex app-server returned an invalid turn/steer response.", { ambiguous: true });
  }
  return turnId;
}

export interface RecoveryConnectionOperations {
  connectLocalProxy(): Promise<AppServerConnection>;
  connectRemote(sshHost: string): Promise<AppServerConnection>;
}

export async function connectRecoveryAppServer(
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
          THREAD_RESUME_TIMEOUT_MS,
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
      if (completed) {
        buffered.stop();
        return completed;
      }
      const observation = waitForTurn(connection.client, agent.threadId, turnId, emit, signal, buffered.notifications, state);
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
        : isDisconnect(error) || (error instanceof RouterError && error.code === "timeout");
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
    if (connection.transportKind === "proxy" && isDisconnect(error)) {
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
    throw error;
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
    if (resumed.activeTurn) {
      baselineTurnItems(resumed.activeTurn, state);
      const expectedTurnId = acceptedTurnId(resumed.activeTurn, "thread/resume");
      let steered: unknown;
      try {
        steered = await connection.client.request("turn/steer", {
          threadId: agent.threadId,
          input: [{ type: "text", text, text_elements: [] }],
          clientUserMessageId,
          expectedTurnId,
        }, effectAckTimeoutMs, signal);
      } catch (error) {
        if (connection.transportKind === "proxy" && isDisconnect(error)) {
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
        if (isRequestTimeout(error)) {
          try {
            turn = await correlateAdmission(
              connection.client,
              agent.threadId,
              clientUserMessageId,
              buffered.notifications,
              signal,
              expectedTurnId,
              threadResumeTimeoutMs,
            );
          } catch (correlationError) {
            if (connection.transportKind === "proxy" && isDisconnect(correlationError)) {
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
            throw correlationError;
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
        }
        throw error;
      }
      acceptedSteerTurnId(steered, expectedTurnId);
      turn = resumed.activeTurn;
    } else {
      try {
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
      } catch (error) {
        if (connection.transportKind === "proxy" && isDisconnect(error)) {
          await connection.close().catch(() => undefined);
          return {
            result: await recoverProxyTurn(
              agent,
              undefined,
              clientUserMessageId,
              state,
              emit,
              signal,
              undefined,
              operations.recovery,
              operations.reconnectDelaysMs,
            ),
            transportKind: "proxy",
          };
        }
        throw error;
      }
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
