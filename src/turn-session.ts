import {
  connectAppServer,
  connectExistingProxy,
  type AppServerConnection,
} from "./app-server.js";
import type { AgentConfig } from "./config.js";
import { checkAgentDirectory } from "./doctor.js";
import { RouterError } from "./errors.js";
import { RpcRequestError, type JsonRpcClient } from "./json-rpc.js";
import {
  acceptedSteerTurnId,
  acceptedTurnId,
  applyTurnItems,
  applyResumedImages,
  baselineTurnItems,
  scopeCommentary,
  semanticMessage,
  emitSafely,
  findCorrelatedTurn,
  resumedThreadState,
  terminalOutcome,
  waitForOutcome,
  type TurnOutcome,
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
  effectAckTimeoutMs?: number;
  threadResumeTimeoutMs?: number;
  recovery?: RecoveryConnectionOperations;
  reconnectDelaysMs?: readonly number[];
}

const defaultTurnCommandOperations: TurnCommandOperations = {
  checkDirectory: checkAgentDirectory,
  connect: (agent) => connectAppServer(agent.sshHost),
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
    // Recovery can temporarily have no live socket. Keep the foreground command alive.
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function notificationBuffer(client: JsonRpcClient, threadId: string, admissionOnly = false): { notifications: Notification[]; stop(): void } {
  const notifications: Notification[] = [];
  const stop = client.onNotification((method, params) => {
    if (object(params)?.threadId !== threadId) return;
    const item = object(object(params)?.item);
    if (admissionOnly && item?.type !== "userMessage") return;
    if (method === "turn/completed" || ((method === "item/started" || method === "item/completed")
      && ["userMessage", "agentMessage", "reasoning", "imageGeneration"].includes(String(item?.type)))) {
      notifications.push({ method, params });
    }
  });
  return { notifications, stop: () => { stop(); notifications.length = 0; } };
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

export class TurnEndedError extends RouterError {
  constructor() { super("turn_failed", "The owned Codex turn has ended."); }
}

export interface AdmissionIntent {
  clientUserMessageId: string;
  expectedTurnId?: string;
}

export type TurnInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "localImage"; path: string };

/** One connection owner for concurrent observation and serialized admissions. */
export class TurnSession {
  private readonly abort = new AbortController();
  private readonly state: TurnState = { seenItemIds: new Set(), seenSemanticUnits: new Set() };
  private connection: AppServerConnection;
  private buffered: ReturnType<typeof notificationBuffer>;
  private resumed: ReturnType<typeof resumedThreadState> | undefined;
  private resumeFlight: Promise<ReturnType<typeof resumedThreadState>> | undefined;
  private recoveryFlight: Promise<void> | undefined;
  private admissionQueue: Promise<unknown> = Promise.resolve();
  private pending: { intent: AdmissionIntent; turn?: Record<string, unknown> } | undefined;
  private owned: Record<string, unknown> | undefined;
  private observation: Promise<TurnOutcome> | undefined;
  private terminal: TurnOutcome | undefined;
  private closing = false;
  private closeFlight: Promise<void> | undefined;
  private readonly stopCallerAbort: () => void;

  private constructor(
    private readonly agent: AgentConfig,
    connection: AppServerConnection,
    private readonly operations: TurnCommandOperations,
    signal?: AbortSignal,
  ) {
    this.connection = connection;
    this.buffered = notificationBuffer(connection.client, this.agent.threadId);
    const onAbort = () => this.abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    this.stopCallerAbort = () => signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) onAbort();
  }

  static async open(
    agent: AgentConfig,
    operations: TurnCommandOperations = defaultTurnCommandOperations,
    signal?: AbortSignal,
  ): Promise<TurnSession> {
    throwIfAborted(signal, false);
    const directory = await operations.checkDirectory(agent);
    if (!directory.ok) throw new RouterError("working_directory_invalid", `${agent.label}'s working directory is unavailable.`);
    throwIfAborted(signal, false);
    const connection = await operations.connect(agent);
    if (signal?.aborted) {
      await connection.close();
      throwIfAborted(signal, false);
    }
    return new TurnSession(agent, connection, operations, signal);
  }

  get transportKind(): "proxy" | "stdio" { return this.connection.transportKind; }
  get backend(): "proxy" | "stdio" { return this.transportKind; }
  readonly capabilities = { steer: true, commentary: { state: "available" } } as const;
  get serverInfo() { return this.connection.client.serverInfo; }
  get artifactBaseline(): string[] { return [...(this.state.artifactBaseline ?? [])]; }

  async interrupt(expectedTurnId: string): Promise<void> {
    this.checkOpen();
    this.connection.client.markTurnAccepted();
    const result = await this.connection.client.request("turn/interrupt", {
      threadId: this.agent.threadId, turnId: expectedTurnId,
    }, this.operations.effectAckTimeoutMs ?? EFFECT_ACK_TIMEOUT_MS);
    const response = object(result);
    if (!response || Object.keys(response).length !== 0) {
      throw new RouterError("app_server_protocol_failed", "Codex app-server returned an invalid turn/interrupt response.", { ambiguous: true });
    }
  }

  async filesystem(method: "fs/getMetadata" | "fs/readDirectory" | "fs/createDirectory" | "fs/remove", params: unknown): Promise<unknown> {
    this.checkOpen();
    if (this.recoveryFlight) await this.recoveryFlight;
    return this.connection.client.request(method, params, THREAD_RESUME_TIMEOUT_MS, this.abort.signal);
  }


  private checkOpen(): void {
    if (this.closing) throw new RouterError("interrupted", "The Codex session is closed.", { ambiguous: !!this.pending });
    throwIfAborted(this.abort.signal, !!this.pending || !!this.owned);
  }

  async resume(): Promise<ReturnType<typeof resumedThreadState>> {
    this.checkOpen();
    if (this.recoveryFlight) await this.recoveryFlight;
    if (this.resumed) return this.resumed;
    if (!this.resumeFlight) {
      const connection = this.connection;
      this.resumeFlight = (async () => {
        try {
          const result = await connection.client.request("thread/resume", { threadId: this.agent.threadId },
            this.operations.threadResumeTimeoutMs ?? THREAD_RESUME_TIMEOUT_MS, this.abort.signal);
          this.resumed = resumedThreadState(result);
          return this.resumed;
        } catch (error) {
          if (error instanceof RpcRequestError
            && error.payload.message?.includes(`thread ${this.agent.threadId} already has an active writer`)) {
            throw new RouterError("thread_busy", `${this.agent.label}'s Codex task is owned by another process. Waiting for that owner to release it.`, { cause: error });
          }
          if (error instanceof RouterError && !(error instanceof RpcRequestError)) throw error;
          throw new RouterError("thread_unavailable", `${this.agent.label}'s Codex task could not be resumed.`, { cause: error });
        }
      })().finally(() => { this.resumeFlight = undefined; });
    }
    return this.resumeFlight;
  }

  admit(input: readonly TurnInput[], intent: AdmissionIntent): Promise<string> {
    const operation = this.admissionQueue.then(() => this.admitOnce(input, intent));
    this.admissionQueue = operation.catch(() => undefined);
    return operation;
  }

  private async admitOnce(input: readonly TurnInput[], intent: AdmissionIntent): Promise<string> {
    this.checkOpen();
    if (this.pending) throw new RouterError("turn_failed", "The previous admission is unresolved.", { ambiguous: true });
    if (this.recoveryFlight) await this.recoveryFlight;
    const resumed = await this.resume();
    this.checkOpen();
    if (this.terminal) throw new TurnEndedError();
    const active = this.owned ?? resumed.activeTurn;
    const expected = active ? acceptedTurnId(active, "thread/resume") : undefined;
    if (expected !== intent.expectedTurnId) {
      throw new RouterError("input_invalid", "The admission intent does not match the resumed turn.");
    }
    if (!this.state.artifactBaseline) {
      const items = Array.isArray(active?.items) ? active.items : [];
      this.state.artifactBaseline = new Set(items.flatMap((raw) => {
        const item = object(raw);
        return item?.type === "imageGeneration" && typeof item.id === "string" ? [item.id] : [];
      }));
      if (active) baselineTurnItems(active, this.state);
    }
    this.state.inputUuid ??= intent.clientUserMessageId;
    const pending = { intent } as { intent: AdmissionIntent; turn?: Record<string, unknown> };
    this.pending = pending;
    const connection = this.connection;
    const admissionBuffer = notificationBuffer(connection.client, this.agent.threadId, true);
    connection.client.markTurnAccepted();
    try {
      try {
        if (expected) {
          const result = await connection.client.request("turn/steer", {
            threadId: this.agent.threadId, input, clientUserMessageId: intent.clientUserMessageId, expectedTurnId: expected,
          }, this.operations.effectAckTimeoutMs ?? EFFECT_ACK_TIMEOUT_MS, this.abort.signal);
          acceptedSteerTurnId(result, expected);
          pending.turn = active!;
        } else {
          await connection.client.request("turn/start", {
            threadId: this.agent.threadId, input, clientUserMessageId: intent.clientUserMessageId,
            cwd: this.agent.cwd, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
            model: this.agent.model, ...(this.agent.reasoning === undefined ? {} : { effort: this.agent.reasoning }), summary: "auto",
          }, this.operations.effectAckTimeoutMs ?? EFFECT_ACK_TIMEOUT_MS, this.abort.signal);
        }
      } catch (error) {
        if (!isRequestTimeout(error)) throw error;
      }
      if (!pending.turn) pending.turn = await correlateAdmission(connection.client, this.agent.threadId,
        intent.clientUserMessageId, admissionBuffer.notifications, this.abort.signal, expected,
        this.operations.threadResumeTimeoutMs ?? THREAD_RESUME_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof RpcRequestError) {
        this.pending = undefined;
        throw error;
      }
      if (!isDisconnect(error) || connection.transportKind !== "proxy") throw error;
      await this.recover(connection);
    } finally {
      admissionBuffer.stop();
    }
    this.checkOpen();
    if (!pending.turn) throw new RouterError("app_server_protocol_failed", "The admission has no correlated turn.", { ambiguous: true });
    this.owned = pending.turn;
    scopeCommentary(this.owned, this.state, this.state.inputUuid!);
    this.pending = undefined;
    return acceptedTurnId(pending.turn, "thread/resume");
  }

  /** Reconstruct durable work without starting or steering a turn. */
  async restore(turnId: string | undefined, intent: AdmissionIntent | undefined, artifactBaseline: readonly string[], clientUserMessageId?: string): Promise<string> {
    this.checkOpen();
    if (this.owned || this.pending) throw new RouterError("input_invalid", "The session already owns Codex work.");
    this.state.artifactBaseline = new Set(artifactBaseline);
    this.state.inputUuid = clientUserMessageId ?? intent?.clientUserMessageId;
    const resumed = await this.resume();
    let turn: Record<string, unknown> | undefined;
    if (intent) {
      this.pending = { intent };
      try {
        turn = await correlateAdmission(this.connection.client, this.agent.threadId, intent.clientUserMessageId,
          this.buffered.notifications, this.abort.signal, intent.expectedTurnId,
          this.operations.threadResumeTimeoutMs ?? THREAD_RESUME_TIMEOUT_MS);
      } catch (error) {
        if (!isDisconnect(error) || this.transportKind !== "proxy") throw error;
        await this.recover(this.connection);
        turn = this.pending?.turn;
      }
    } else if (turnId) {
      turn = findCorrelatedTurn({ thread: resumed.thread }, turnId, "");
    }
    if (!turn || (turnId && turn.id !== turnId)) {
      throw new RouterError("app_server_protocol_failed", "The persisted Codex turn is absent.", { ambiguous: true });
    }
    this.checkOpen();
    this.owned = turn;
    if (this.state.inputUuid) scopeCommentary(turn, this.state, this.state.inputUuid);
    this.pending = undefined;
    return acceptedTurnId(turn, "thread/resume");
  }

  observe(turnId: string, emit: (message: SemanticMessage) => void = () => undefined): Promise<TurnOutcome> {
    this.checkOpen();
    if (!this.owned || this.owned.id !== turnId) {
      return Promise.reject(new RouterError("input_invalid", "The session does not own this turn."));
    }
    const scopedEmit = (message: SemanticMessage) => emitSafely(emit, semanticMessage(message.type, message.text, message.itemId, turnId));
    this.observation ??= this.observeOwned(scopedEmit);
    return this.observation;
  }

  private async observeOwned(emit: (message: SemanticMessage) => void): Promise<TurnOutcome> {
    while (true) {
      this.checkOpen();
      if (this.recoveryFlight) await this.recoveryFlight;
      const connection = this.connection;
      const turn = this.owned!;
      if (this.state.inputUuid) {
        scopeCommentary(turn, this.state, this.state.inputUuid);
        const before: string[] = [];
        for (const event of this.buffered.notifications) {
          const item = object(object(event.params)?.item);
          if (item?.type === "userMessage" && item.clientId === this.state.inputUuid) {
            for (const id of before) this.state.excludedCommentaryIds!.add(id);
            break;
          }
          if (typeof item?.id === "string") before.push(item.id);
        }
      }
      try {
        if (turn.status !== "inProgress") {
          for (const event of this.buffered.notifications) {
            const params = object(event.params);
            if (event.method === "item/completed" && params && params.turnId === turn.id) {
              applyTurnItems({ items: [params.item] }, this.state, emit);
            }
            const completed = object(params?.turn);
            if (event.method === "turn/completed" && completed && completed.id === turn.id) {
              applyTurnItems(completed, this.state, emit);
            }
          }
          applyTurnItems(turn, this.state, emit);
          this.buffered.stop();
        } else applyResumedImages(turn, this.state);
        const terminal = terminalOutcome(turn, this.state);
        if (terminal) { this.terminal = terminal; return terminal; }
        const observed = waitForOutcome(connection.client, this.agent.threadId, acceptedTurnId(turn, "thread/resume"),
          emit, this.abort.signal, this.buffered.notifications, this.state);
        this.buffered.stop();
        const result = await observed;
        this.terminal = result;
        return result;
      } catch (error) {
        if (!isDisconnect(error) || connection.transportKind !== "proxy") throw error;
        await this.recover(connection);
      }
    }
  }

  private async recover(failed: AppServerConnection): Promise<void> {
    this.checkOpen();
    if (this.recoveryFlight) return this.recoveryFlight;
    if (this.connection !== failed) return;
    this.recoveryFlight = this.reconnect(failed).finally(() => { this.recoveryFlight = undefined; });
    return this.recoveryFlight;
  }

  private async reconnect(failed: AppServerConnection): Promise<void> {
    this.buffered.stop();
    await failed.close().catch(() => undefined);
    let attempt = 0;
    while (true) {
      await reconnectDelay(attempt++, this.abort.signal, this.operations.reconnectDelaysMs);
      let next: AppServerConnection | undefined;
      let buffer: ReturnType<typeof notificationBuffer> | undefined;
      try {
        next = await connectRecoveryAppServer(this.agent, this.operations.recovery);
        this.checkOpen();
        next.client.markTurnAccepted();
        buffer = notificationBuffer(next.client, this.agent.threadId);
        let turn: Record<string, unknown> | undefined;
        const pending = this.pending;
        if (pending && !pending.turn) {
          turn = await correlateAdmission(next.client, this.agent.threadId, pending.intent.clientUserMessageId,
            buffer.notifications, this.abort.signal, pending.intent.expectedTurnId,
            this.operations.threadResumeTimeoutMs ?? THREAD_RESUME_TIMEOUT_MS);
          pending.turn = turn;
        } else {
          const resumed = await next.client.request("thread/resume", { threadId: this.agent.threadId },
            this.operations.threadResumeTimeoutMs ?? THREAD_RESUME_TIMEOUT_MS, this.abort.signal);
          turn = findCorrelatedTurn(resumed, this.owned?.id as string | undefined, pending?.intent.clientUserMessageId ?? "");
          if (!turn) throw new RouterError("app_server_protocol_failed", "The accepted Codex turn is absent after reconnect.", { ambiguous: true });
        }
        this.checkOpen();
        this.owned = turn;
        this.connection = next;
        this.buffered = buffer;
        return;
      } catch (error) {
        buffer?.stop();
        await next?.close().catch(() => undefined);
        if (!isReconnectable(error)) throw error;
      }
    }
  }

  close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight;
    this.closing = true;
    this.abort.abort();
    this.stopCallerAbort();
    this.buffered.stop();
    this.closeFlight = (async () => {
      await this.connection.close().catch(() => undefined);
      await Promise.allSettled([this.admissionQueue, this.observation, this.resumeFlight, this.recoveryFlight]);
    })();
    return this.closeFlight;
  }
}
