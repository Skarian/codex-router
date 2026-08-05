import { RouterError } from "./errors.js";
export class JsonRpcClient {
    transport;
    nextId = 1;
    pending = new Map();
    listeners = new Set();
    closeListeners = new Set();
    acceptedTurn = false;
    closed = false;
    constructor(transport) {
        this.transport = transport;
        transport.onMessage((message) => this.handleMessage(message));
        transport.onClose((error) => this.handleClose(error));
    }
    markTurnAccepted() {
        this.acceptedTurn = true;
    }
    onNotification(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    onClose(listener) {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }
    async initialize() {
        await this.request("initialize", {
            clientInfo: { name: "codex-router", title: "Codex Router", version: "0.1.0" },
            capabilities: null,
        }, 10_000);
        await this.notify("initialized");
    }
    async request(method, params, timeoutMs = 15_000) {
        if (this.closed)
            throw this.disconnectedError();
        const id = this.nextId++;
        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new RouterError("timeout", `Codex app-server timed out while handling ${method}.`, { ambiguous: this.acceptedTurn }));
            }, timeoutMs);
            timer.unref();
            this.pending.set(id, { resolve, reject, timer });
        });
        try {
            await this.transport.send({ id, method, ...(params === undefined ? {} : { params }) });
        }
        catch (error) {
            const pending = this.pending.get(id);
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(id);
            }
            throw new RouterError("app_server_disconnected", `Could not send ${method} to Codex app-server.`, {
                ambiguous: this.acceptedTurn,
                cause: error,
            });
        }
        return response;
    }
    async notify(method, params) {
        await this.transport.send({ method, ...(params === undefined ? {} : { params }) });
    }
    handleMessage(value) {
        if (value === null || typeof value !== "object" || Array.isArray(value))
            return;
        const message = value;
        if (typeof message.id === "number") {
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error !== undefined) {
                const payload = message.error;
                const detail = typeof payload?.message === "string" ? payload.message : "Unknown app-server error.";
                pending.reject(new RouterError("app_server_protocol_failed", `Codex app-server rejected the request: ${detail}`));
            }
            else {
                pending.resolve(message.result);
            }
            return;
        }
        if (typeof message.method === "string") {
            for (const listener of this.listeners)
                listener(message.method, message.params);
        }
    }
    handleClose(error) {
        if (this.closed)
            return;
        this.closed = true;
        const disconnected = this.disconnectedError(error);
        for (const listener of this.closeListeners)
            listener(disconnected);
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(disconnected);
        }
        this.pending.clear();
    }
    disconnectedError(cause) {
        return new RouterError("app_server_disconnected", "The Codex app-server connection closed before the command completed.", {
            ambiguous: this.acceptedTurn,
            cause,
        });
    }
}
//# sourceMappingURL=json-rpc.js.map