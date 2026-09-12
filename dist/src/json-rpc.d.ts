import { RouterError } from "./errors.js";
import type { MessageTransport } from "./transport.js";
export interface RpcErrorPayload {
    code?: number;
    message?: string;
    data?: unknown;
}
export declare class RpcRequestError extends RouterError {
    readonly payload: RpcErrorPayload;
    constructor(payload: RpcErrorPayload);
}
export interface AppServerInfo {
    codexHome?: string;
    platformFamily?: string;
    platformOs?: string;
    userAgent?: string;
}
type NotificationListener = (method: string, params: unknown) => void;
type ClientCloseListener = (error: RouterError) => void;
export declare class JsonRpcClient {
    private readonly transport;
    private nextId;
    readonly serverInfo: AppServerInfo;
    get isClosed(): boolean;
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
