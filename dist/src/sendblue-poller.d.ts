/** Outbound-only intake. Provider offsets are reconciled by overlapping bounded sweeps. */
export declare const POLL_OVERLAP_MS: number;
export declare const POLL_STEP_MS: number;
export declare const POLL_HORIZON_MS: number;
export interface SendbluePollState {
    activationAtMs: number;
    completedThroughMs: number;
    routeActivationAtMs: Record<string, number>;
}
export interface SendbluePollRoute {
    id: string;
    sender: string;
    sendblueNumber: string;
}
export interface SendbluePollQuery {
    is_outbound: 'false';
    message_type: 'message';
    status: 'RECEIVED';
    sendblue_number: string;
    updated_at_gte: string;
    updated_at_lte: string;
    order_by: 'updatedAt';
    order_direction: 'asc';
    offset: number;
    limit: number;
}
export interface SendbluePollStatus {
    state: 'running' | 'idle' | 'degraded' | 'blocked';
    code?: string;
    nextRetryAt?: number;
}
export interface SendbluePollOptions {
    routes: SendbluePollRoute[];
    state(): SendbluePollState;
    checkpoint(completedThroughMs: number): Promise<void>;
    list(query: SendbluePollQuery, signal: AbortSignal): Promise<unknown>;
    /** Must resolve only after message admission and duplicate identity are durable. */
    receive(value: unknown): Promise<void>;
    intervalMs?: number;
    now?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    onStatus?: (status: SendbluePollStatus) => void;
}
export declare class SendbluePoller {
    private readonly options;
    private readonly now;
    private readonly wait;
    private nextRequestAt;
    private sweeping;
    private running;
    constructor(options: SendbluePollOptions);
    private status;
    sweep(signal: AbortSignal): Promise<{
        caughtUp: boolean;
        completedThroughMs: number;
    }>;
    run(signal: AbortSignal): Promise<void>;
}
