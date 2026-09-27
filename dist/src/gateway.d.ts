import type { GatewayConfig, GatewayRoute } from "./config.js";
import { type ExecutionSession } from "./execution-session.js";
import type { Submission } from "./gateway-connector.js";
import { ProgressHub } from "./gateway-progress.js";
import type { Receipt } from "./gateway-state.js";
import type { TurnOutcome } from "./turn-state.js";
import { GatewayStore, type Batch, type CodexWork, type Delivery, type DeliveryPart, type GatewayState } from "./gateway-state.js";
export type SendOutcome = {
    status: "accepted";
    providerHandle: string;
} | {
    status: "rejected" | "uncertain";
    retryable: boolean;
    retryAfterMs?: number;
};
export interface IncomingMessage {
    messageHandle: string;
    sender: string;
    sendblueNumber: string;
    providerTimeMs: number;
    text: string;
    attachment?: {
        sourceUrl: string;
        name: string;
    };
}
export interface StatusCallback {
    status: string;
    providerHandle?: string;
}
export interface SendblueProvider {
    readonly signingSecret: string;
    agentInstructions?(outputDirectory: string): string;
    readReceipt?(route: GatewayRoute, signal: AbortSignal): Promise<void>;
    inbound(value: unknown): IncomingMessage | undefined;
    callback(value: unknown): StatusCallback;
    send(route: GatewayRoute, part: DeliveryPart, callbackUrl: string | undefined, signal: AbortSignal): Promise<SendOutcome>;
    upload(path: string, name: string, mediaType: string, signal: AbortSignal): Promise<string>;
    typing(route: GatewayRoute, state: "start" | "stop", signal: AbortSignal): Promise<void>;
}
export type GatewaySession = ExecutionSession;
export interface ProcessingStatus {
    routeId: string;
    state: "idle" | "running" | "retrying" | "blocked" | "unresolved";
    code?: string;
}
export interface GatewayFiles {
    cleanup(state: GatewayState): Promise<void>;
    release?(route: GatewayRoute, active: CodexWork | Delivery, session?: GatewaySession): Promise<void>;
    reconcile(route: GatewayRoute, state: GatewayState, session: GatewaySession, signal: AbortSignal): Promise<void>;
    prepareBatch(route: GatewayRoute, batch: Batch, session: GatewaySession, signal: AbortSignal): Promise<Batch>;
    publication(route: GatewayRoute, publicationId: string, session: GatewaySession, signal: AbortSignal): Promise<string>;
    delivery(route: GatewayRoute, work: CodexWork, outcome: TurnOutcome, session: GatewaySession, connector: SendblueProvider, signal: AbortSignal): Promise<DeliveryPart[]>;
}
export interface GatewayOperations {
    connector(id: string): SendblueProvider;
    files: GatewayFiles;
    openSession?(route: GatewayRoute, signal: AbortSignal): Promise<GatewaySession>;
    now?(): number;
    retryDelayMs?(attempt: number): number;
}
export declare function delay(ms: number, signal: AbortSignal): Promise<void>;
export declare class Gateway {
    readonly config: GatewayConfig;
    readonly store: GatewayStore;
    readonly operations: GatewayOperations;
    ready: boolean;
    readonly progress: ProgressHub;
    private readonly adapters;
    private readonly abort;
    private readonly workers;
    private readonly live;
    private readonly cleanups;
    private readonly lineStarts;
    private readonly now;
    constructor(config: GatewayConfig, store: GatewayStore, operations: GatewayOperations);
    /** Scheduling and file cleanup need identities and work, never retained response text. */
    private executionState;
    start(): Promise<void>;
    private source;
    private activeSource;
    receive(accountId: string, message: IncomingMessage): Promise<void>;
    submit(routeId: string, submission: Submission): Promise<Receipt>;
    request(routeId: string, sourceId: string, requestId: string): {
        blocked_by?: string;
        commentary?: {
            state: "available" | "unavailable";
            reason?: string;
        };
        processing?: {
            state: string;
            code: string | undefined;
        };
        turn_id?: string;
        result?: {
            status: "interrupted" | "failed" | "completed";
            text: string;
            notices: string[];
        };
        expires_at?: number | undefined;
        request_id: string;
        status: string;
    } | undefined;
    requestKey(routeId: string, sourceId: string, requestId: string): string;
    private notifyWork;
    private readReceipt;
    private typing;
    wake(routeId: string): void;
    private retry;
    private failure;
    private session;
    private observe;
    private step;
    private finish;
    private release;
    private currentPart;
    callbackState(account: string, partId: string, token: string): "stale" | "unauthorized" | "current";
    callback(account: string, partId: string, token: string, callback: StatusCallback): Promise<boolean>;
    private settle;
    private lineSlot;
    private sendPart;
    idle(): Promise<void>;
    processingStatus(): ProcessingStatus[];
    errors(): string[];
    close(): Promise<void>;
}
export declare function secretEqual(left: string, right: string): boolean;
export declare class SubmissionFailure extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string);
}
