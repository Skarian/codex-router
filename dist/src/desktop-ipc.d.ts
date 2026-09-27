import { type Socket } from "node:net";
import { RouterError } from "./errors.js";
export declare const DESKTOP_FRAME_LIMIT: number;
export declare function record(value: unknown): Record<string, any>;
export declare class DesktopResponseError extends RouterError {
    readonly response: Record<string, any>;
    constructor(response: Record<string, any>);
}
/** A client only: never creates the Desktop broker or advertises thread ownership. */
export declare class DesktopIpc {
    private readonly socket;
    private readonly signal?;
    private readonly timeoutMs;
    clientId: string;
    private buffer;
    private failure;
    private readonly pending;
    private readonly listeners;
    private readonly abort;
    constructor(socket: Socket, signal?: AbortSignal | undefined, timeoutMs?: number);
    static connect(home: string, signal?: AbortSignal): Promise<DesktopIpc | undefined>;
    get closed(): boolean;
    initialize(): Promise<void>;
    onFrame(listener: (frame: Record<string, any>) => void): () => void;
    request(method: string, params: unknown, version: number, owner?: string): Promise<Record<string, any>>;
    follow(owner: string, threadId: string, following: boolean): void;
    private send;
    private receive;
    private fail;
    close(): void;
}
