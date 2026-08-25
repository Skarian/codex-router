import { RouterError } from "./errors.js";
import type { MessageTransport } from "./transport.js";
type NotificationListener = (method: string, params: unknown) => void;
type ClientCloseListener = (error: RouterError) => void;
export declare class JsonRpcClient {
    private readonly transport;
    private nextId;
    private readonly pending;
    private readonly listeners;
    private readonly closeListeners;
    private acceptedTurn;
    private closed;
    constructor(transport: MessageTransport);
    markTurnAccepted(): void;
    onNotification(listener: NotificationListener): () => void;
    onClose(listener: ClientCloseListener): () => void;
    initialize(timeoutMs?: number): Promise<void>;
    request(method: string, params?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
    notify(method: string, params?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<void>;
    private handleMessage;
    private handleClose;
    private disconnectedError;
    private clearPending;
}
export {};
