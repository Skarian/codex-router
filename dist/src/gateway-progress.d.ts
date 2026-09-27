import type { ServerResponse } from "node:http";
export type ProgressStatus = Record<string, unknown>;
export interface ProgressMessage {
    id: string;
    kind: "commentary" | "terminal";
    text: string;
    metadata?: ProgressStatus;
}
export interface ProgressSnapshot {
    status: ProgressStatus;
    terminal?: ProgressMessage;
}
export interface ProgressFrame {
    id: string;
    event: "status" | "commentary" | "terminal" | "reset";
    data: string;
    end: boolean;
}
export interface ProgressLimits {
    requestBytes?: number;
    requestMessages?: number;
    globalBytes?: number;
    globalStreams?: number;
    accountStreams?: number;
    heartbeatMs?: number;
    drainTimeoutMs?: number;
    writableBytes?: number;
}
declare const defaults: {
    requestBytes: number;
    requestMessages: number;
    globalBytes: number;
    globalStreams: number;
    accountStreams: number;
    heartbeatMs: number;
    drainTimeoutMs: number;
    writableBytes: number;
};
/** Fragments only complete messages. Metadata is serialized JSON carried in field=metadata parts. */
export declare function encodeProgressFrames(epoch: string, sequence: number, event: ProgressFrame["event"], message: {
    id: string;
    text: string;
    metadata?: ProgressStatus;
}): ProgressFrame[];
export interface ProgressSubscription {
    read(): ProgressFrame | undefined;
    close(): void;
}
/** Volatile progress only. The caller owns durable results and admission/observation identity. */
export declare class ProgressHub {
    readonly limits: typeof defaults;
    private readonly nonce;
    private generation;
    private states;
    private bytes;
    private closed;
    private streams;
    private streamClosers;
    constructor(limits?: ProgressLimits);
    private state;
    private signal;
    notify(key: string): void;
    /** Returns false for a duplicate retained item. Native observation dedup remains authoritative after eviction. */
    publish(key: string, message: ProgressMessage): boolean;
    reset(key: string): void;
    private removeFirst;
    private trim;
    /** Snapshot, cursor validation and listener registration are synchronous. onAvailable is only a wake signal. */
    subscribe(key: string, options: {
        cursor?: string;
        snapshot: () => ProgressSnapshot;
    }, onAvailable: () => void): ProgressSubscription;
    /** Stream slots are acquired before sending HTTP headers. */
    acquireStream(account: string, close: () => void): (() => void) | undefined;
    get retainedBytes(): number;
    get requestCount(): number;
    close(): void;
}
/** Returns false on stream-capacity rejection; the caller sends its normal HTTP error. */
export declare function writeProgressStream(options: {
    hub: ProgressHub;
    requestKey: string;
    accountId: string;
    response: ServerResponse;
    cursor?: string;
    snapshot: () => ProgressSnapshot;
}): boolean;
export {};
