import { RouterError } from "./errors.js";
import type { JsonRpcClient } from "./json-rpc.js";

const MAX_OUTPUT_BYTES = 256 * 1024;

export interface TurnState {
  inputUuid?: string | undefined;
  inputSeen?: boolean;
  excludedCommentaryIds?: Set<string>;
  finalText?: string;
  imageGenerations?: Map<string, TurnOutcome["imageGenerations"][number]>;
  artifactBaseline?: ReadonlySet<string>;
  readonly seenItemIds: Set<string>;
  readonly seenSemanticUnits: Set<string>;
}

export interface TurnOutcome {
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  finalText?: string;
  imageGenerations: Array<{ id: string; savedPath?: string; result?: string }>;
}

export interface Notification {
  method: string;
  params: unknown;
}

export interface ResumedThreadState {
  thread: Record<string, unknown>;
  activeTurn?: Record<string, unknown>;
}

export interface SemanticMessage {
  type: "reasoning" | "commentary" | "completed";
  text: string;
  readonly itemId?: string;
  readonly turnId?: string;
}

/** Native metadata stays internal; CLI JSON remains exactly type and text. */
export function semanticMessage(type: SemanticMessage["type"], text: string, itemId?: string, turnId?: string): SemanticMessage {
  const message: SemanticMessage = { type, text };
  Object.defineProperties(message, { itemId: { value: itemId }, turnId: { value: turnId } });
  return message;
}
export function emitSafely(emit: (message: SemanticMessage) => void, message: SemanticMessage): void {
  try { emit(message); } catch { /* Progress observers cannot invalidate execution. */ }
}
export function scopeCommentary(turn: Record<string, unknown>, state: TurnState, uuid: string): void {
  state.inputUuid = uuid;
  state.excludedCommentaryIds ??= new Set();
  const items = Array.isArray(turn.items) ? turn.items : [];
  const boundary = items.findIndex(raw => object(raw)?.type === "userMessage" && object(raw)?.clientId === uuid);
  if (typeof turn.id === "string") state.inputSeen = boundary >= 0;
  if (boundary >= 0) {
    state.inputSeen = true;
    for (const raw of items.slice(0, boundary)) { const item = object(raw); if (typeof item?.id === "string") state.excludedCommentaryIds.add(item.id); }
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bounded(text: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
    throw new RouterError("output_too_large", "Codex produced a message too large for the router output contract.");
  }
  return text;
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

export function waitForOutcome(
  client: JsonRpcClient,
  threadId: string,
  turnId: string,
  emit: (message: SemanticMessage) => void,
  signal?: AbortSignal,
  initialNotifications: ReadonlyArray<Notification> = [],
  state: TurnState = { seenItemIds: new Set(), seenSemanticUnits: new Set() },
): Promise<TurnOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      unsubscribeClose();
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new RouterError("interrupted", "The Codex turn was interrupted by the caller.", { ambiguous: true })));
    const unsubscribeClose = client.onClose((error) => finish(() => reject(error)));
    const handleNotification = (method: string, rawParams: unknown) => {
      if (settled) return;
      try {
        const params = object(rawParams);
        if (!params || params.threadId !== threadId) return;
        if (method === "item/started" && params.turnId === turnId && state.inputUuid) {
          const item = object(params.item);
          if (item?.type === "userMessage" && item.clientId === state.inputUuid) state.inputSeen = true;
          else if (!state.inputSeen && typeof item?.id === "string") {
            state.excludedCommentaryIds ??= new Set(); state.excludedCommentaryIds.add(item.id);
          }
          return;
        }
        if (method === "item/completed" && params.turnId === turnId) {
          const item = object(params.item);
          if (item) applyCompletedItem(item, state, emit);
          return;
        }
        if (method !== "turn/completed") return;
        const turn = object(params.turn);
        if (!turn || turn.id !== turnId) return;
        applyTurnItems(turn, state, emit);
        const outcome = terminalOutcome(turn, state);
        if (outcome) finish(() => resolve(outcome));
      } catch (error) {
        finish(() => reject(error instanceof RouterError
          ? error
          : new RouterError("app_server_protocol_failed", "Codex app-server emitted an invalid turn event.", { cause: error })));
      }
    };
    const unsubscribe = client.onNotification(handleNotification);
    for (const notification of initialNotifications) handleNotification(notification.method, notification.params);
    if (settled) return;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function textResult(outcome: TurnOutcome): SemanticMessage {
  if (outcome.status === "completed" && outcome.finalText !== undefined) {
    return { type: "completed", text: outcome.finalText };
  }
  if (outcome.status === "interrupted") throw new RouterError("interrupted", "The Codex turn was interrupted.");
  throw new RouterError("turn_failed", "The Codex turn failed before producing a final response.");
}

export function terminalOutcome(turn: Record<string, unknown>, state: TurnState): TurnOutcome | undefined {
  if (turn.status === "inProgress") return undefined;
  if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") {
    throw new RouterError("app_server_protocol_failed", "Codex returned an invalid terminal status.");
  }
  return {
    turnId: acceptedTurnId(turn, "thread/resume"),
    status: turn.status,
    ...(state.finalText === undefined ? {} : { finalText: state.finalText }),
    imageGenerations: [...(state.imageGenerations?.values() ?? [])],
  };
}

function applyCompletedItem(item: Record<string, unknown>, state: TurnState, emit: (message: SemanticMessage) => void): void {
  const itemId = typeof item.id === "string" ? item.id : undefined;
  if (item.type === "userMessage" && item.clientId === state.inputUuid) state.inputSeen = true;
  if (itemId !== undefined) {
    if (state.seenItemIds.has(itemId)) return;
    state.seenItemIds.add(itemId);
  }
  if (item.type === "imageGeneration" && itemId && item.status === "completed"
    && !state.artifactBaseline?.has(itemId)) {
    state.imageGenerations ??= new Map();
    state.imageGenerations.set(itemId, {
      id: itemId,
      ...(typeof item.savedPath === "string" ? { savedPath: item.savedPath } : {}),
      ...(typeof item.result === "string" ? { result: item.result } : {}),
    });
  }
  if (item.type === "reasoning" && Array.isArray(item.summary)) {
    const text = bounded(item.summary.filter((part): part is string => typeof part === "string").join("\n\n"));
    const semanticKey = `reasoning\0${text}`;
    if (text && !state.seenSemanticUnits.has(semanticKey)) {
      state.seenSemanticUnits.add(semanticKey);
      emitSafely(emit, { type: "reasoning", text });
    }
  }
  if (item.type === "agentMessage" && typeof item.text === "string") {
    if (item.phase === "commentary") {
      const text = bounded(item.text);
      if ((!state.inputUuid || state.inputSeen) && !(itemId && state.excludedCommentaryIds?.has(itemId))) {
        const semanticKey = `commentary\0${text}`;
        if (itemId || !state.seenSemanticUnits.has(semanticKey)) {
          if (!itemId) state.seenSemanticUnits.add(semanticKey);
          emitSafely(emit, semanticMessage("commentary", text, itemId));
        }
      }
    }
    if (item.phase === "final_answer") state.finalText = bounded(item.text);
  }
}

export function applyTurnItems(turn: Record<string, unknown>, state: TurnState, emit: (message: SemanticMessage) => void): void {
  if (!Array.isArray(turn.items)) return;
  if (state.inputUuid) scopeCommentary(turn, state, state.inputUuid);
  for (const rawItem of turn.items) {
    const item = object(rawItem);
    if (item) applyCompletedItem(item, state, emit);
  }
}

/** Active resumes can contain partial text, but completed native images are stable items. */
export function applyResumedImages(turn: Record<string, unknown>, state: TurnState): void {
  if (!Array.isArray(turn.items)) return;
  for (const raw of turn.items) {
    const item = object(raw);
    if (item?.type === "imageGeneration" && item.status === "completed") {
      applyCompletedItem(item, state, () => undefined);
    }
  }
}

export function baselineTurnItems(turn: Record<string, unknown>, state: TurnState): void {
  if (!Array.isArray(turn.items)) return;
  for (const rawItem of turn.items) {
    const item = object(rawItem);
    if (item?.type === "reasoning" && Array.isArray(item.summary)) {
      const text = bounded(item.summary.filter((part): part is string => typeof part === "string").join("\n\n"));
      if (text) state.seenSemanticUnits.add(`reasoning\0${text}`);
    }
    if (item?.type === "agentMessage" && item.phase === "commentary" && typeof item.text === "string") {
      if (typeof item.id === "string") { state.excludedCommentaryIds ??= new Set(); state.excludedCommentaryIds.add(item.id); }
      else state.seenSemanticUnits.add(`commentary\0${bounded(item.text)}`);
    }
  }
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

export function acceptedTurnId(result: unknown, operation: "turn/start" | "thread/resume"): string {
  const turn = operation === "turn/start" ? object(object(result)?.turn) : object(result);
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
