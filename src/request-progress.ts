import { randomUUID } from "node:crypto";

export type ProgressStatus = Record<string, unknown>;
export interface ProgressMessage {
  id: string;
  kind: "reasoning" | "commentary" | "terminal";
  text: string;
  metadata?: ProgressStatus;
}
export interface ProgressSnapshot { status: ProgressStatus; terminal?: ProgressMessage }
export interface ProgressEntry { sequence: number; message: ProgressMessage; bytes: number }
interface RequestState {
  epoch: string;
  sequence: number;
  entries: ProgressEntry[];
  bytes: number;
  listeners: Set<() => void>;
}
export interface ProgressView { readonly epoch: string; readonly sequence: number; readonly entries: readonly ProgressEntry[]; readonly bytes: number }
export interface ReplayLimits { requestBytes?: number; requestMessages?: number; globalBytes?: number; subscriptions?: number }
const STATE_BYTES = 256;
const defaults = { requestBytes: 2 * 1024 * 1024, requestMessages: 128, globalBytes: 16 * 1024 * 1024, subscriptions: 128 };

/** Bounded semantic replay. No transport frames or network response objects. */
export class RequestProgress {
  readonly limits: typeof defaults;
  private readonly nonce = randomUUID();
  private generation = 0;
  private states = new Map<string, RequestState>();
  private bytes = 0;
  private closed = false;
  private subscriptions = 0;
  private closers = new Set<() => void>();
  constructor(limits: ReplayLimits = {}) {
    this.limits = { ...defaults, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Progress limits must be positive integers");
    if (this.limits.globalBytes < STATE_BYTES) throw new RangeError("Progress global budget is too small");
  }
  private state(key: string): RequestState {
    if (this.closed) throw new Error("Progress hub is closed");
    let state = this.states.get(key);
    if (!state) {
      this.trim(STATE_BYTES);
      if (this.bytes + STATE_BYTES > this.limits.globalBytes) throw new RangeError("Progress state capacity exceeded");
      state = { epoch: `${this.nonce}.${++this.generation}`, sequence: 0, entries: [], bytes: 0, listeners: new Set() };
      this.states.set(key, state); this.bytes += STATE_BYTES;
    }
    return state;
  }
  private signal(state: RequestState): void {
    for (const listener of [...state.listeners]) { try { listener(); } catch { /* Observers cannot break execution. */ } }
  }
  notify(key: string): void { const state = this.states.get(key); if (state) this.signal(state); }
  publish(key: string, message: ProgressMessage): boolean {
    if (Buffer.byteLength(message.id) > 512 || Buffer.byteLength(message.text) > 256 * 1024
      || Buffer.byteLength(JSON.stringify(message.metadata ?? {})) > 16 * 1024) throw new RangeError("Progress message exceeds its size limit");
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > this.limits.requestBytes || bytes + STATE_BYTES > this.limits.globalBytes) throw new RangeError("Completed progress message exceeds replay budget");
    const state = this.state(key);
    if (state.entries.some(entry => entry.message.id === message.id && entry.message.kind === message.kind)) return false;
    state.entries.push(Object.freeze({ sequence: ++state.sequence, message: freezeMessage(message), bytes }));
    state.bytes += bytes; this.bytes += bytes; this.trim(); this.signal(state);
    return true;
  }
  reset(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    this.bytes -= state.bytes; state.bytes = 0; state.entries = []; state.sequence = 0;
    state.epoch = `${this.nonce}.${++this.generation}`; this.signal(state);
  }
  private removeFirst(state: RequestState): void {
    const entry = state.entries.shift();
    if (entry) { state.bytes -= entry.bytes; this.bytes -= entry.bytes; }
  }
  private trim(reservedBytes = 0): void {
    for (const state of this.states.values()) while (state.bytes > this.limits.requestBytes || state.entries.length > this.limits.requestMessages) this.removeFirst(state);
    for (const [key, state] of this.states) {
      if (this.bytes + reservedBytes <= this.limits.globalBytes) break;
      while (state.entries.length && this.bytes + reservedBytes > this.limits.globalBytes) this.removeFirst(state);
      if (!state.entries.length && !state.listeners.size) { this.states.delete(key); this.bytes -= STATE_BYTES; }
    }
  }
  /** Wake signals carry no private observer queue. Readers pull from shared bounded replay. */
  watch(key: string, wake: () => void): { view: ProgressView; close(): void } {
    if (this.subscriptions >= this.limits.subscriptions) throw new RangeError("Progress subscription capacity exceeded");
    const state = this.state(key);
    this.subscriptions++;
    state.listeners.add(wake); this.trim();
    let closed = false;
    return { view: Object.freeze({
      get epoch() { return state.epoch; }, get sequence() { return state.sequence; },
      get entries() { return Object.freeze([...state.entries]); }, get bytes() { return state.bytes; },
    }), close: () => {
      if (closed) return;
      closed = true; this.subscriptions--; state.listeners.delete(wake);
      if (!state.entries.length && this.states.get(key) === state && !state.listeners.size) { this.states.delete(key); this.bytes -= STATE_BYTES; }
      this.trim();
    } };
  }
  onClose(close: () => void): () => void {
    if (this.closed) { close(); return () => {}; }
    this.closers.add(close); return () => { this.closers.delete(close); };
  }
  get retainedBytes(): number { return this.bytes; }
  get requestCount(): number { return this.states.size; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const close of this.closers) { try { close(); } catch { /* Isolate observers. */ } }
    this.closers.clear();
    for (const state of this.states.values()) { state.listeners.clear(); state.entries = []; state.bytes = 0; }
    this.states.clear(); this.bytes = 0;
  }
}

function freezeMessage(message: ProgressMessage): ProgressMessage {
  const copy = structuredClone(message);
  function freeze(value: unknown): void {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  freeze(copy);
  return copy;
}
