import type { ServerResponse } from "node:http";

import { RequestProgress, type ProgressEntry, type ProgressMessage, type ProgressSnapshot, type ProgressStatus } from "./request-progress.js";
export type { ProgressMessage, ProgressSnapshot, ProgressStatus } from "./request-progress.js";
export interface ProgressFrame { id: string; event: "status" | "reasoning" | "commentary" | "terminal" | "reset"; data: string; end: boolean }
interface Cursor { e: string; s: number; p: number }
export interface ProgressLimits {
  requestBytes?: number;
  requestMessages?: number;
  globalBytes?: number;
  globalStreams?: number;
  accountStreams?: number;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
  writableBytes?: number;
  encodedCacheBytes?: number;
}
const FRAME_BYTES = 4096;
const TEXT_BYTES = 256 * 1024;
const METADATA_BYTES = 16 * 1024;
const defaults = {
  requestBytes: 2 * 1024 * 1024, requestMessages: 128, globalBytes: 16 * 1024 * 1024,
  globalStreams: 32, accountStreams: 4, heartbeatMs: 15_000, drainTimeoutMs: 10_000, writableBytes: 64 * 1024, encodedCacheBytes: 2 * 1024 * 1024,
};
function cursorId(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function parseCursor(value: string | undefined): Cursor | undefined {
  if (!value || value.length > 1024) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!parsed || typeof parsed !== "object") return undefined;
    const c = parsed as Cursor;
    return typeof c.e === "string" && Number.isSafeInteger(c.s) && c.s >= 0 && Number.isSafeInteger(c.p) && c.p >= 0 ? c : undefined;
  } catch { return undefined; }
}
function json(value: ProgressStatus): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > METADATA_BYTES) throw new RangeError("Progress metadata exceeds 16 KiB");
  return encoded;
}
interface FrameIndex { parts: Uint32Array; metadata?: string }
type FrameMessage = { id: string; text: string; metadata?: ProgressStatus };
function frame(epoch: string, sequence: number, event: ProgressFrame["event"], messageId: string,
  part: number, field: string, text: string, end: boolean): ProgressFrame {
  const id = cursorId({ e: epoch, s: sequence, p: part });
  return { id, event, end, data: `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify({ message_id: messageId, part, end, field, text })}\n\n` };
}
/** Index UTF-16 slice boundaries once; retain neither escaped payloads nor source text. */
function indexFrames(epoch: string, sequence: number, event: ProgressFrame["event"], message: FrameMessage): FrameIndex {
  if (Buffer.byteLength(message.id) > 512) throw new RangeError("Progress identity exceeds 512 bytes");
  if (Buffer.byteLength(message.text) > TEXT_BYTES) throw new RangeError("Progress text exceeds 256 KiB");
  const metadata = message.metadata === undefined ? undefined : json(message.metadata);
  const fields: Array<[number, string]> = [];
  if (metadata !== undefined) fields.push([1, metadata]);
  if (event === "reasoning" || event === "commentary" || event === "terminal") fields.push([0, message.text]);
  if (!fields.length) fields.push([0, ""]);
  const parts: number[] = [];
  for (const [field, value] of fields) {
    let start = 0, offset = 0;
    const envelope = () => Buffer.byteLength(frame(epoch, sequence, event, message.id, parts.length / 3,
      field ? "metadata" : "text", "", false).data);
    let used = envelope();
    if (used > FRAME_BYTES) throw new RangeError("Progress frame envelope exceeds 4 KiB");
    for (const character of value) {
      const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;
      if (used + bytes > FRAME_BYTES) {
        if (offset === start) throw new RangeError("Progress frame envelope exceeds 4 KiB");
        parts.push(field, start, offset);
        start = offset; used = envelope();
        if (used + bytes > FRAME_BYTES) throw new RangeError("Progress frame envelope exceeds 4 KiB");
      }
      used += bytes; offset += character.length;
    }
    parts.push(field, start, offset);
  }
  return { parts: new Uint32Array(parts), ...(metadata === undefined ? {} : { metadata }) };
}
function indexedFrame(index: FrameIndex, epoch: string, sequence: number, event: ProgressFrame["event"], message: FrameMessage,
  part: number): ProgressFrame | undefined {
  const offset = part * 3;
  if (!Number.isSafeInteger(part) || part < 0 || offset >= index.parts.length) return undefined;
  const metadata = index.parts[offset] === 1;
  const value = metadata ? index.metadata! : message.text;
  return frame(epoch, sequence, event, message.id, part, metadata ? "metadata" : "text",
    value.slice(index.parts[offset + 1], index.parts[offset + 2]), offset + 3 === index.parts.length);
}
/** Convenience encoder; live streams use the compact index and encode only the requested frame. */
export function encodeProgressFrames(epoch: string, sequence: number, event: ProgressFrame["event"], message: FrameMessage): ProgressFrame[] {
  const index = indexFrames(epoch, sequence, event, message);
  return Array.from({ length: index.parts.length / 3 }, (_, part) => indexedFrame(index, epoch, sequence, event, message, part)!);
}
function controlFrames(epoch: string, event: "status" | "reset", metadata: ProgressStatus): ProgressFrame[] {
  // Control updates must not overwrite Last-Event-ID for commentary/result replay.
  return encodeProgressFrames(epoch, 0, event, { id: event, text: "", metadata })
    .map((frame) => ({ ...frame, id: "", data: frame.data.slice(frame.data.indexOf("\n") + 1) }));
}
export interface ProgressSubscription { read(): ProgressFrame | undefined; close(): void }

/** Volatile progress only. The caller owns durable results and admission/observation identity. */
export class ProgressHub {
  readonly limits: typeof defaults;
  private closed = false;
  private streams = new Map<string, number>();
  private streamClosers = new Set<() => void>();
  private subscriptionClosers = new Set<() => void>();
  private readonly encoded = new Map<string, { index: FrameIndex; bytes: number }>();
  private encodingBytes = 0;
  private readonly ownsSource: boolean;
  private readonly detach: () => void;
  readonly semantic: RequestProgress;
  constructor(limits: ProgressLimits = {}, source?: RequestProgress) {
    this.limits = { ...defaults, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Progress limits must be positive integers");
    this.ownsSource = source === undefined;
    this.semantic = source ?? new RequestProgress({ requestBytes: this.limits.requestBytes, requestMessages: this.limits.requestMessages, globalBytes: this.limits.globalBytes });
    this.detach = this.semantic.onClose(() => this.close());
  }
  private frameIndex(epoch: string, entry: ProgressEntry): FrameIndex {
    const key = `${epoch}:${entry.sequence}`;
    const cached = this.encoded.get(key);
    if (cached) { this.encoded.delete(key); this.encoded.set(key, cached); return cached.index; }
    const index = indexFrames(epoch, entry.sequence, entry.message.kind, entry.message);
    // Typed boundaries have exact byte size; reserve UTF-16 storage and map/object overhead.
    const bytes = index.parts.byteLength + 2 * (key.length + (index.metadata?.length ?? 0)) + 128;
    if (bytes > this.limits.encodedCacheBytes) throw new RangeError("Progress frame index exceeds presentation budget");
    while (this.encodingBytes + bytes > this.limits.encodedCacheBytes) {
      const oldest = this.encoded.keys().next().value!;
      this.encodingBytes -= this.encoded.get(oldest)!.bytes; this.encoded.delete(oldest);
    }
    this.encoded.set(key, { index, bytes }); this.encodingBytes += bytes;
    return index;
  }
  get encodedBytes(): number { return this.encodingBytes; }

  notify(key: string): void { this.semantic.notify(key); }
  publish(key: string, message: ProgressMessage): boolean { return this.semantic.publish(key, message); }
  reset(key: string): void { this.semantic.reset(key); }
  /** Snapshot, cursor validation and listener registration are synchronous. onAvailable is only a wake signal. */
  subscribe(key: string, options: { cursor?: string; snapshot: () => ProgressSnapshot }, onAvailable: () => void): ProgressSubscription {
    const initialSnapshot = options.snapshot();
    const watch = this.semantic.watch(key, () => wake());
    const state = watch.view;
    let closed = false;
    let epoch = state.epoch;
    let cursor = parseCursor(options.cursor);
    let statusDirty = true;
    let lastStatus: string | undefined;
    let initialStatusPending = true;
    const watermark = state.sequence;
    let initial = true;
    let cursorComplete = true;
    let controls: ProgressFrame[] = [];
    let lastTerminal: string | undefined;
    const wake = () => { statusDirty = true; try { onAvailable(); } catch { /* Isolate observers. */ } };
    let firstSnapshot: ProgressSnapshot | undefined = initialSnapshot;

    const reset = (snapshot: ProgressSnapshot) => {
      epoch = state.epoch;
      cursor = { e: epoch, s: (state.entries[0]?.sequence ?? state.sequence + 1) - 1, p: Number.MAX_SAFE_INTEGER };
      controls = controlFrames(epoch, "reset", { reason: "progress_unavailable" });
      controls.push(...controlFrames(epoch, "status", snapshot.status));
      lastStatus = json(snapshot.status);
      cursorComplete = true;
      initialStatusPending = false;
      lastTerminal = undefined;
    };
    const subscription: ProgressSubscription = {
      read: () => {
        if (closed || this.closed) return undefined;
        if (controls.length) return controls.shift();
        const snapshot = firstSnapshot ?? options.snapshot();
        firstSnapshot = undefined;
        if (snapshot.terminal && lastTerminal !== snapshot.terminal.id && !state.entries.some((entry) => entry.message.kind === "terminal" && entry.message.id === snapshot.terminal!.id)) {
          // Durable regeneration uses the shared ring, never a per-subscriber message queue.
          this.publish(key, snapshot.terminal);
        }
        const invalid = epoch !== state.epoch || (cursor !== undefined && (cursor.e !== state.epoch || cursor.s > state.sequence || (cursor.s > 0 && !state.entries.some((e) => e.sequence === cursor!.s && cursor!.p < this.frameIndex(state.epoch, e).parts.length / 3))));
        if (initial) {
          initial = false;
          if ((options.cursor !== undefined && !cursor) || invalid) { reset(snapshot); statusDirty = false; return controls.shift(); }
          cursor ??= { e: epoch, s: (state.entries[0]?.sequence ?? state.sequence + 1) - 1, p: Number.MAX_SAFE_INTEGER };
        } else if (epoch !== state.epoch || (cursor && (cursor.s < (state.entries[0]?.sequence ?? state.sequence + 1) - 1 || (!cursorComplete && !state.entries.some((entry) => entry.sequence === cursor!.s))))) {
          reset(snapshot); statusDirty = false; return controls.shift();
        }
        for (const entry of state.entries) {
          if (initialStatusPending && entry.sequence > watermark) break;
          if (entry.sequence < cursor!.s) continue;
          const next = entry.sequence === cursor!.s ? cursor!.p + 1 : 0;
          const frame = indexedFrame(this.frameIndex(state.epoch, entry), state.epoch, entry.sequence, entry.message.kind, entry.message, next);
          if (frame) {
            cursor = { e: epoch, s: entry.sequence, p: next };
            cursorComplete = frame.end;
            if (entry.message.kind === "terminal" && frame.end) lastTerminal = entry.message.id;
            return frame;
          }
        }
        if (initialStatusPending || statusDirty) {
          const status = initialStatusPending ? initialSnapshot.status : snapshot.status;
          initialStatusPending = false;
          statusDirty = false;
          const serialized = json(status);
          if (serialized !== lastStatus) {
            lastStatus = serialized;
            controls = controlFrames(epoch, "status", status);
            return controls.shift();
          }
        }
        return undefined;
      },
      close: () => {
        if (closed) return;
        closed = true;
        watch.close();
        this.subscriptionClosers.delete(subscription.close);
      },
    };
    this.subscriptionClosers.add(subscription.close);
    return subscription;
  }
  /** Stream slots are acquired before sending HTTP headers. */
  acquireStream(account: string, close: () => void): (() => void) | undefined {
    if (this.closed || this.streamClosers.size >= this.limits.globalStreams || (this.streams.get(account) ?? 0) >= this.limits.accountStreams) return undefined;
    this.streams.set(account, (this.streams.get(account) ?? 0) + 1);
    this.streamClosers.add(close);
    return () => {
      if (!this.streamClosers.delete(close)) return;
      const remaining = (this.streams.get(account) ?? 1) - 1;
      if (remaining) this.streams.set(account, remaining); else this.streams.delete(account);
    };
  }
  get retainedBytes(): number { return this.semantic.retainedBytes; }
  get requestCount(): number { return this.semantic.requestCount; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const close of [...this.streamClosers]) close();
    for (const close of [...this.subscriptionClosers]) close();
    this.detach?.();
    this.encoded.clear(); this.encodingBytes = 0;
    if (this.ownsSource) this.semantic.close();
  }
}

const presentations = new WeakMap<RequestProgress, ProgressHub>();

/** Returns false on stream-capacity rejection; the caller sends its normal HTTP error. */
export function writeProgressStream(options: {
  hub: ProgressHub | RequestProgress; requestKey: string; accountId: string; response: ServerResponse;
  cursor?: string; snapshot: () => ProgressSnapshot;
}): boolean {
  const { response } = options;
  let hub: ProgressHub;
  if (options.hub instanceof ProgressHub) hub = options.hub;
  else {
    hub = presentations.get(options.hub) ?? new ProgressHub({}, options.hub);
    presentations.set(options.hub, hub);
  }
  let subscription: ProgressSubscription | undefined;
  let closed = false;
  let blocked = false;
  let pumping = false;
  let terminalDone = false;
  let scheduled = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let release: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    subscription?.close();
    release?.();
    clearTimeout(drainTimer);
    clearInterval(heartbeat);
    response.off("drain", drain);
    response.off("close", close);
    response.off("error", close);
    response.destroy();
  };
  const write = (data: string): boolean => {
    const ready = response.write(data);
    if (response.writableLength > hub.limits.writableBytes) { close(); return false; }
    if (!ready) {
      blocked = true;
      drainTimer = setTimeout(close, hub.limits.drainTimeoutMs);
      drainTimer.unref();
    }
    return ready;
  };
  const finish = () => {
    if (closed) return;
    subscription?.close(); release?.(); clearInterval(heartbeat); clearTimeout(drainTimer);
    response.off("drain", drain); response.off("close", close); response.off("error", close);
    closed = true;
    response.end();
  };
  const pump = () => {
    scheduled = false;
    if (closed || blocked || pumping) return;
    if (terminalDone) { finish(); return; }
    pumping = true;
    try {
      let frame: ProgressFrame | undefined;
      while (!closed && !blocked && (frame = subscription?.read())) {
        write(frame.data);
        if (!closed && frame.event === "terminal" && frame.end) {
          terminalDone = true;
          if (!blocked) finish();
          break;
        }
      }
    } catch { close(); } finally { pumping = false; }
  };
  const schedule = () => {
    if (closed || scheduled) return;
    scheduled = true;
    setImmediate(pump);
  };
  const drain = () => { blocked = false; clearTimeout(drainTimer); schedule(); };
  release = hub.acquireStream(options.accountId, close);
  if (!release) return false;
  try {
    subscription = hub.subscribe(options.requestKey, { snapshot: options.snapshot, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) }, schedule);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
    response.flushHeaders();
    response.on("drain", drain); response.on("close", close); response.on("error", close);
    heartbeat = setInterval(() => {
      if (closed) return;
      // Capability/status changes can occur without a commentary or terminal publication.
      hub.notify(options.requestKey);
      if (!blocked) { try { write(": heartbeat\n\n"); } catch { close(); } }
    }, hub.limits.heartbeatMs);
    heartbeat.unref();
    schedule();
    return true;
  } catch { close(); return true; }
}
