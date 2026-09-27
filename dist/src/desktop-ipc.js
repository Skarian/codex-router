import { randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { RouterError } from "./errors.js";
export const DESKTOP_FRAME_LIMIT = 32 * 1024 * 1024;
export function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export class DesktopResponseError extends RouterError {
    response;
    constructor(response) {
        super(["no-client-found", "client-disconnected"].includes(response.error) ? "app_server_disconnected" : "app_server_protocol_failed", `Desktop IPC rejected the request: ${String(response.error)}`);
        this.response = response;
    }
}
/** A client only: never creates the Desktop broker or advertises thread ownership. */
export class DesktopIpc {
    socket;
    signal;
    timeoutMs;
    clientId = "initializing-client";
    buffer = Buffer.alloc(0);
    failure;
    pending = new Map();
    listeners = new Set();
    abort = () => this.fail(new RouterError("interrupted", "Desktop IPC was interrupted."));
    constructor(socket, signal, timeoutMs = 15_000) {
        this.socket = socket;
        this.signal = signal;
        this.timeoutMs = timeoutMs;
        socket.on("data", data => this.receive(data));
        socket.on("error", () => this.fail(new RouterError("app_server_disconnected", "Desktop IPC disconnected.")));
        socket.on("close", () => this.fail(new RouterError("app_server_disconnected", "Desktop IPC closed.")));
        signal?.addEventListener("abort", this.abort, { once: true });
        if (signal?.aborted)
            this.abort();
    }
    static async connect(home, signal) {
        if (process.platform === "win32") {
            // Trusted local Desktop endpoint. Protocol identities do not authenticate
            // the Windows account serving this pipe.
            const socket = connect(String.raw `\\.\pipe\codex-ipc`);
            try {
                await new Promise((resolve, reject) => {
                    const cleanup = () => {
                        clearTimeout(timer);
                        signal?.removeEventListener("abort", abort);
                        socket.removeListener("connect", ready);
                        socket.removeListener("error", failed);
                    };
                    const ready = () => { cleanup(); resolve(); };
                    const failed = (error) => { cleanup(); reject(error); };
                    const abort = () => failed(new RouterError("interrupted", "Desktop IPC was interrupted."));
                    const timer = setTimeout(() => failed(new RouterError("timeout", "Desktop IPC connection timed out.")), 5_000);
                    socket.once("connect", ready);
                    socket.once("error", failed);
                    signal?.addEventListener("abort", abort, { once: true });
                    if (signal?.aborted)
                        abort();
                });
            }
            catch (error) {
                socket.destroy();
                if (error.code === "ENOENT")
                    return undefined;
                if (error instanceof RouterError)
                    throw error;
                throw new RouterError("app_server_connect_failed", "Cannot connect to Desktop IPC.", { cause: error });
            }
            const client = new DesktopIpc(socket, signal);
            try {
                await client.initialize();
                return client;
            }
            catch (error) {
                client.close();
                throw error;
            }
        }
        const path = join(home, "ipc", "ipc.sock");
        try {
            await lstat(path);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw new RouterError("app_server_connect_failed", "Cannot inspect Desktop IPC endpoint.", { cause: error });
        }
        try {
            const endpoint = await realpath(path);
            for (const candidate of [dirname(path), dirname(endpoint), endpoint]) {
                const metadata = await stat(candidate);
                if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0)
                    throw new RouterError("app_server_connect_failed", "Desktop IPC endpoint has unsafe ownership or permissions.");
            }
            if (!(await lstat(endpoint)).isSocket())
                throw new RouterError("app_server_connect_failed", "Desktop IPC endpoint is not a socket.");
        }
        catch (error) {
            if (error instanceof RouterError)
                throw error;
            throw new RouterError("app_server_connect_failed", "Cannot validate Desktop IPC endpoint.", { cause: error });
        }
        if (signal?.aborted)
            throw new RouterError("interrupted", "Desktop IPC was interrupted.");
        const socket = connect(path);
        const client = new DesktopIpc(socket, signal);
        try {
            await client.initialize();
            return client;
        }
        catch (error) {
            client.close();
            throw error;
        }
    }
    get closed() { return this.failure !== undefined; }
    async initialize() {
        const response = await this.request("initialize", { clientType: "codex-router" }, 0);
        if (typeof response.result?.clientId !== "string")
            throw new RouterError("app_server_protocol_failed", "Desktop IPC did not assign a client identity.");
        this.clientId = response.result.clientId;
    }
    onFrame(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    request(method, params, version, owner) {
        if (this.failure)
            return Promise.reject(this.failure);
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(requestId); reject(new RouterError("timeout", `Desktop IPC timed out: ${method}.`)); }, this.timeoutMs);
            this.pending.set(requestId, { method, ...(owner ? { owner } : {}), resolve, reject, timer });
            try {
                this.send({ type: "request", requestId, sourceClientId: this.clientId, method, params, version, timeoutMs: this.timeoutMs, ...(owner ? { targetClientId: owner } : {}) });
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(error);
            }
        });
    }
    follow(owner, threadId, following) {
        this.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1, sourceClientId: this.clientId, targetClientIds: [owner], params: { hostId: "local", conversationId: threadId, following } });
    }
    send(frame) {
        if (this.failure)
            throw this.failure;
        const body = Buffer.from(JSON.stringify(frame));
        if (!body.length || body.length > DESKTOP_FRAME_LIMIT)
            throw new RouterError("output_too_large", "Desktop IPC frame exceeds the size limit.");
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        this.socket.write(Buffer.concat([header, body]));
    }
    receive(data) {
        try {
            this.buffer = Buffer.concat([this.buffer, data]);
            while (this.buffer.length >= 4) {
                const size = this.buffer.readUInt32LE(0);
                if (!size || size > DESKTOP_FRAME_LIMIT)
                    throw new Error("Invalid frame size");
                if (this.buffer.length < size + 4)
                    break;
                const frame = record(JSON.parse(this.buffer.subarray(4, size + 4).toString("utf8")));
                this.buffer = this.buffer.subarray(size + 4);
                if (frame.type === "client-discovery-request")
                    this.send({ type: "client-discovery-response", requestId: frame.requestId, response: { canHandle: false } });
                if (frame.type === "response") {
                    const pending = this.pending.get(frame.requestId);
                    if (pending) {
                        this.pending.delete(frame.requestId);
                        clearTimeout(pending.timer);
                        if ((frame.method !== undefined && frame.method !== pending.method) || (frame.resultType === "success" && (frame.method !== pending.method || (pending.owner && frame.handledByClientId !== pending.owner))))
                            pending.reject(new RouterError("app_server_protocol_failed", "Desktop IPC response identity mismatch."));
                        else if (frame.resultType === "success")
                            pending.resolve(frame);
                        else
                            pending.reject(new DesktopResponseError(frame));
                    }
                }
                for (const listener of this.listeners)
                    listener(frame);
            }
        }
        catch {
            this.fail(new RouterError("app_server_protocol_failed", "Desktop IPC sent an invalid frame."));
        }
    }
    fail(error) {
        if (this.failure)
            return;
        this.failure = error;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.signal?.removeEventListener("abort", this.abort);
        this.socket.destroy();
    }
    close() { this.fail(new RouterError("app_server_disconnected", "Desktop IPC client closed.")); }
}
//# sourceMappingURL=desktop-ipc.js.map