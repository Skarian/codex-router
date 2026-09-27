import { randomUUID } from "node:crypto";
const FRAME_BYTES = 4096;
const TEXT_BYTES = 256 * 1024;
const METADATA_BYTES = 16 * 1024;
const STATE_BYTES = 256;
const defaults = {
    requestBytes: 2 * 1024 * 1024, requestMessages: 128, globalBytes: 16 * 1024 * 1024,
    globalStreams: 32, accountStreams: 4, heartbeatMs: 15_000, drainTimeoutMs: 10_000, writableBytes: 64 * 1024,
};
function cursorId(cursor) { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function parseCursor(value) {
    if (!value || value.length > 1024)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
        if (!parsed || typeof parsed !== "object")
            return undefined;
        const c = parsed;
        return typeof c.e === "string" && Number.isSafeInteger(c.s) && c.s >= 0 && Number.isSafeInteger(c.p) && c.p >= 0 ? c : undefined;
    }
    catch {
        return undefined;
    }
}
function json(value) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > METADATA_BYTES)
        throw new RangeError("Progress metadata exceeds 16 KiB");
    return encoded;
}
/** Fragments only complete messages. Metadata is serialized JSON carried in field=metadata parts. */
export function encodeProgressFrames(epoch, sequence, event, message) {
    if (Buffer.byteLength(message.id) > 512)
        throw new RangeError("Progress identity exceeds 512 bytes");
    if (Buffer.byteLength(message.text) > TEXT_BYTES)
        throw new RangeError("Progress text exceeds 256 KiB");
    const fields = [];
    if (message.metadata !== undefined)
        fields.push(["metadata", json(message.metadata)]);
    if (event === "commentary" || event === "terminal")
        fields.push(["text", message.text]);
    if (fields.length === 0)
        fields.push(["text", ""]);
    const parts = [];
    const frame = (part, field, text, end) => {
        const id = cursorId({ e: epoch, s: sequence, p: part });
        return { id, event, end, data: `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify({ message_id: message.id, part, end, field, text })}\n\n` };
    };
    for (const [field, value] of fields) {
        let piece = "";
        let used = Buffer.byteLength(frame(parts.length, field, "", false).data);
        for (const character of value) {
            const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;
            if (used + bytes > FRAME_BYTES) {
                if (!piece)
                    throw new RangeError("Progress frame envelope exceeds 4 KiB");
                parts.push({ field, text: piece });
                piece = "";
                used = Buffer.byteLength(frame(parts.length, field, "", false).data);
            }
            piece += character;
            used += bytes;
        }
        parts.push({ field, text: piece });
    }
    return parts.map((part, index) => frame(index, part.field, part.text, index === parts.length - 1));
}
function controlFrames(epoch, event, metadata) {
    // Control updates must not overwrite Last-Event-ID for commentary/result replay.
    return encodeProgressFrames(epoch, 0, event, { id: event, text: "", metadata })
        .map((frame) => ({ ...frame, id: "", data: frame.data.slice(frame.data.indexOf("\n") + 1) }));
}
/** Volatile progress only. The caller owns durable results and admission/observation identity. */
export class ProgressHub {
    limits;
    nonce = randomUUID();
    generation = 0;
    states = new Map();
    bytes = 0;
    closed = false;
    streams = new Map();
    streamClosers = new Set();
    constructor(limits = {}) {
        this.limits = { ...defaults, ...limits };
        for (const value of Object.values(this.limits))
            if (!Number.isSafeInteger(value) || value <= 0)
                throw new RangeError("Progress limits must be positive integers");
        if (this.limits.globalBytes < STATE_BYTES)
            throw new RangeError("Progress global budget is too small");
    }
    state(key) {
        if (this.closed)
            throw new Error("Progress hub is closed");
        let state = this.states.get(key);
        if (!state) {
            state = { epoch: `${this.nonce}.${++this.generation}`, sequence: 0, entries: [], bytes: 0, listeners: new Set() };
            this.states.set(key, state);
            this.bytes += STATE_BYTES;
        }
        return state;
    }
    signal(state) {
        for (const listener of [...state.listeners]) {
            try {
                listener();
            }
            catch { /* Observers cannot break execution. */ }
        }
    }
    notify(key) { const state = this.states.get(key); if (state)
        this.signal(state); }
    /** Returns false for a duplicate retained item. Native observation dedup remains authoritative after eviction. */
    publish(key, message) {
        const state = this.state(key);
        if (state.entries.some((entry) => entry.message.id === message.id && entry.message.kind === message.kind))
            return false;
        const sequence = state.sequence + 1;
        let frames;
        let bytes;
        try {
            frames = encodeProgressFrames(state.epoch, sequence, message.kind, message);
            bytes = frames.reduce((sum, frame) => sum + Buffer.byteLength(frame.data), 0);
            if (bytes > this.limits.requestBytes || bytes + STATE_BYTES > this.limits.globalBytes)
                throw new RangeError("Completed progress message exceeds replay budget");
        }
        catch (error) {
            if (state.entries.length === 0 && state.listeners.size === 0) {
                this.states.delete(key);
                this.bytes -= STATE_BYTES;
            }
            throw error;
        }
        state.sequence = sequence;
        state.entries.push({ sequence, message: { id: message.id, kind: message.kind, text: "" }, frames, bytes });
        state.bytes += bytes;
        this.bytes += bytes;
        this.trim();
        this.signal(state);
        return true;
    }
    reset(key) {
        const state = this.states.get(key);
        if (!state)
            return;
        this.bytes -= state.bytes;
        state.bytes = 0;
        state.entries = [];
        state.sequence = 0;
        state.epoch = `${this.nonce}.${++this.generation}`;
        this.signal(state);
    }
    removeFirst(state) {
        const entry = state.entries.shift();
        if (entry) {
            state.bytes -= entry.bytes;
            this.bytes -= entry.bytes;
        }
    }
    trim() {
        for (const state of this.states.values()) {
            while (state.bytes > this.limits.requestBytes || state.entries.length > this.limits.requestMessages)
                this.removeFirst(state);
        }
        for (const [key, state] of this.states) {
            if (this.bytes <= this.limits.globalBytes)
                break;
            while (state.entries.length && this.bytes > this.limits.globalBytes)
                this.removeFirst(state);
            if (state.entries.length === 0 && state.listeners.size === 0) {
                this.states.delete(key);
                this.bytes -= STATE_BYTES;
            }
        }
    }
    /** Snapshot, cursor validation and listener registration are synchronous. onAvailable is only a wake signal. */
    subscribe(key, options, onAvailable) {
        const initialSnapshot = options.snapshot();
        const state = this.state(key);
        let closed = false;
        let epoch = state.epoch;
        let cursor = parseCursor(options.cursor);
        let statusDirty = true;
        let lastStatus;
        let initialStatusPending = true;
        const watermark = state.sequence;
        let initial = true;
        let cursorComplete = true;
        let controls = [];
        let lastTerminal;
        const wake = () => { statusDirty = true; try {
            onAvailable();
        }
        catch { /* Isolate observers. */ } };
        let firstSnapshot = initialSnapshot;
        state.listeners.add(wake);
        this.trim();
        const reset = (snapshot) => {
            epoch = state.epoch;
            cursor = { e: epoch, s: (state.entries[0]?.sequence ?? state.sequence + 1) - 1, p: Number.MAX_SAFE_INTEGER };
            controls = controlFrames(epoch, "reset", { reason: "progress_unavailable" });
            controls.push(...controlFrames(epoch, "status", snapshot.status));
            lastStatus = json(snapshot.status);
            cursorComplete = true;
            initialStatusPending = false;
            lastTerminal = undefined;
        };
        return {
            read: () => {
                if (closed || this.closed)
                    return undefined;
                if (controls.length)
                    return controls.shift();
                const snapshot = firstSnapshot ?? options.snapshot();
                firstSnapshot = undefined;
                if (snapshot.terminal && lastTerminal !== snapshot.terminal.id && !state.entries.some((entry) => entry.message.kind === "terminal" && entry.message.id === snapshot.terminal.id)) {
                    // Durable regeneration uses the shared ring, never a per-subscriber message queue.
                    this.publish(key, snapshot.terminal);
                }
                const invalid = epoch !== state.epoch || (cursor !== undefined && (cursor.e !== state.epoch || cursor.s > state.sequence || (cursor.s > 0 && !state.entries.some((e) => e.sequence === cursor.s && cursor.p < e.frames.length))));
                if (initial) {
                    initial = false;
                    if ((options.cursor !== undefined && !cursor) || invalid) {
                        reset(snapshot);
                        statusDirty = false;
                        return controls.shift();
                    }
                    cursor ??= { e: epoch, s: (state.entries[0]?.sequence ?? state.sequence + 1) - 1, p: Number.MAX_SAFE_INTEGER };
                }
                else if (epoch !== state.epoch || (cursor && (cursor.s < (state.entries[0]?.sequence ?? state.sequence + 1) - 1 || (!cursorComplete && !state.entries.some((entry) => entry.sequence === cursor.s))))) {
                    reset(snapshot);
                    statusDirty = false;
                    return controls.shift();
                }
                for (const entry of state.entries) {
                    if (initialStatusPending && entry.sequence > watermark)
                        break;
                    if (entry.sequence < cursor.s)
                        continue;
                    const next = entry.sequence === cursor.s ? cursor.p + 1 : 0;
                    const frame = entry.frames[next];
                    if (frame) {
                        cursor = { e: epoch, s: entry.sequence, p: next };
                        cursorComplete = frame.end;
                        if (entry.message.kind === "terminal" && frame.end)
                            lastTerminal = entry.message.id;
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
                if (closed)
                    return;
                closed = true;
                state.listeners.delete(wake);
                if (!state.entries.length && this.states.get(key) === state) {
                    this.states.delete(key);
                    this.bytes -= STATE_BYTES;
                }
                this.trim();
            },
        };
    }
    /** Stream slots are acquired before sending HTTP headers. */
    acquireStream(account, close) {
        if (this.closed || this.streamClosers.size >= this.limits.globalStreams || (this.streams.get(account) ?? 0) >= this.limits.accountStreams)
            return undefined;
        this.streams.set(account, (this.streams.get(account) ?? 0) + 1);
        this.streamClosers.add(close);
        return () => {
            if (!this.streamClosers.delete(close))
                return;
            const remaining = (this.streams.get(account) ?? 1) - 1;
            if (remaining)
                this.streams.set(account, remaining);
            else
                this.streams.delete(account);
        };
    }
    get retainedBytes() { return this.bytes; }
    get requestCount() { return this.states.size; }
    close() {
        this.closed = true;
        for (const close of [...this.streamClosers])
            close();
        for (const state of this.states.values())
            state.listeners.clear();
        this.states.clear();
        this.bytes = 0;
    }
}
/** Returns false on stream-capacity rejection; the caller sends its normal HTTP error. */
export function writeProgressStream(options) {
    const { hub, response } = options;
    let subscription;
    let closed = false;
    let blocked = false;
    let pumping = false;
    let terminalDone = false;
    let scheduled = false;
    let drainTimer;
    let heartbeat;
    let release;
    const close = () => {
        if (closed)
            return;
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
    const write = (data) => {
        const ready = response.write(data);
        if (response.writableLength > hub.limits.writableBytes) {
            close();
            return false;
        }
        if (!ready) {
            blocked = true;
            drainTimer = setTimeout(close, hub.limits.drainTimeoutMs);
            drainTimer.unref();
        }
        return ready;
    };
    const finish = () => {
        if (closed)
            return;
        subscription?.close();
        release?.();
        clearInterval(heartbeat);
        clearTimeout(drainTimer);
        response.off("drain", drain);
        response.off("close", close);
        response.off("error", close);
        closed = true;
        response.end();
    };
    const pump = () => {
        scheduled = false;
        if (closed || blocked || pumping)
            return;
        if (terminalDone) {
            finish();
            return;
        }
        pumping = true;
        try {
            let frame;
            while (!closed && !blocked && (frame = subscription?.read())) {
                write(frame.data);
                if (!closed && frame.event === "terminal" && frame.end) {
                    terminalDone = true;
                    if (!blocked)
                        finish();
                    break;
                }
            }
        }
        catch {
            close();
        }
        finally {
            pumping = false;
        }
    };
    const schedule = () => {
        if (closed || scheduled)
            return;
        scheduled = true;
        setImmediate(pump);
    };
    const drain = () => { blocked = false; clearTimeout(drainTimer); schedule(); };
    release = hub.acquireStream(options.accountId, close);
    if (!release)
        return false;
    try {
        subscription = hub.subscribe(options.requestKey, { snapshot: options.snapshot, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) }, schedule);
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
        response.flushHeaders();
        response.on("drain", drain);
        response.on("close", close);
        response.on("error", close);
        heartbeat = setInterval(() => {
            if (closed)
                return;
            // Capability/status changes can occur without a commentary or terminal publication.
            hub.notify(options.requestKey);
            if (!blocked) {
                try {
                    write(": heartbeat\n\n");
                }
                catch {
                    close();
                }
            }
        }, hub.limits.heartbeatMs);
        heartbeat.unref();
        schedule();
        return true;
    }
    catch {
        close();
        return true;
    }
}
//# sourceMappingURL=gateway-progress.js.map