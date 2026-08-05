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
    initialize(): Promise<void>;
    request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
    notify(method: string, params?: unknown): Promise<void>;
    private handleMessage;
    private handleClose;
    private disconnectedError;
}
export {};
