import { RouterError } from "./errors.js";
import type { MessageTransport } from "./transport.js";

interface RpcErrorPayload {
  code?: number;
  message?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type NotificationListener = (method: string, params: unknown) => void;
type ClientCloseListener = (error: RouterError) => void;

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly closeListeners = new Set<ClientCloseListener>();
  private acceptedTurn = false;
  private closed = false;

  constructor(private readonly transport: MessageTransport) {
    transport.onMessage((message) => this.handleMessage(message));
    transport.onClose((error) => this.handleClose(error));
  }

  markTurnAccepted(): void {
    this.acceptedTurn = true;
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: ClientCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async initialize(timeoutMs = 10_000): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "codex-router", title: "Codex Router", version: "0.1.0" },
      capabilities: null,
    }, timeoutMs);
    await this.notify("initialized", undefined, timeoutMs);
  }

  async request(method: string, params?: unknown, timeoutMs = 15_000, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw this.disconnectedError();
    if (signal?.aborted) {
      throw new RouterError("interrupted", "The Codex request was interrupted by the caller.", { ambiguous: this.acceptedTurn });
    }
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.clearPending(pending);
        reject(new RouterError("timeout", `Codex app-server timed out while handling ${method}.`, { ambiguous: this.acceptedTurn }));
      }, timeoutMs);
      timer.unref();
      const pending: PendingRequest = { resolve, reject, timer, ...(signal ? { signal } : {}) };
      if (signal) {
        pending.onAbort = () => {
          if (this.pending.get(id) !== pending) return;
          this.pending.delete(id);
          this.clearPending(pending);
          reject(new RouterError("interrupted", "The Codex request was interrupted by the caller.", { ambiguous: this.acceptedTurn }));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
    });
    const failSend = (error: unknown) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      this.clearPending(pending);
      pending.reject(new RouterError("app_server_disconnected", `Could not send ${method} to Codex app-server.`, {
        ambiguous: this.acceptedTurn,
        cause: error,
      }));
    };
    try {
      void this.transport.send({ id, method, ...(params === undefined ? {} : { params }) }).catch(failSend);
    } catch (error) {
      failSend(error);
    }
    return response;
  }

  async notify(method: string, params?: unknown, timeoutMs = 15_000, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw this.disconnectedError();
    if (signal?.aborted) {
      throw new RouterError("interrupted", "The Codex request was interrupted by the caller.", { ambiguous: this.acceptedTurn });
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const timer = setTimeout(() => finish(() => reject(new RouterError(
        "timeout",
        `Codex app-server timed out while handling ${method}.`,
        { ambiguous: this.acceptedTurn },
      ))), timeoutMs);
      timer.unref();
      const onAbort = () => finish(() => reject(new RouterError(
        "interrupted",
        "The Codex request was interrupted by the caller.",
        { ambiguous: this.acceptedTurn },
      )));
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        void this.transport.send({ method, ...(params === undefined ? {} : { params }) }).then(
          () => finish(resolve),
          (error) => finish(() => reject(new RouterError(
            "app_server_disconnected",
            `Could not send ${method} to Codex app-server.`,
            { ambiguous: this.acceptedTurn, cause: error },
          ))),
        );
      } catch (error) {
        finish(() => reject(new RouterError(
          "app_server_disconnected",
          `Could not send ${method} to Codex app-server.`,
          { ambiguous: this.acceptedTurn, cause: error },
        )));
      }
    });
  }

  private handleMessage(value: unknown): void {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      this.clearPending(pending);
      if (message.error !== undefined) {
        const payload = message.error as RpcErrorPayload;
        const detail = typeof payload?.message === "string" ? payload.message : "Unknown app-server error.";
        pending.reject(new RouterError("app_server_protocol_failed", `Codex app-server rejected the request: ${detail}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.listeners) listener(message.method, message.params);
    }
  }

  private handleClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const disconnected = this.disconnectedError(error);
    for (const listener of this.closeListeners) listener(disconnected);
    for (const pending of this.pending.values()) {
      this.clearPending(pending);
      pending.reject(disconnected);
    }
    this.pending.clear();
  }

  private disconnectedError(cause?: unknown): RouterError {
    const detail = cause instanceof Error && cause.message
      ? ` ${cause.message}`
      : "";
    return new RouterError("app_server_disconnected", `The Codex app-server connection closed before the command completed.${detail}`, {
      ambiguous: this.acceptedTurn,
      cause,
    });
  }

  private clearPending(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }
}
