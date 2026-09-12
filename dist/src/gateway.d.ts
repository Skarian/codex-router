import type { GatewayConfig, GatewayRoute } from "./config.js";
import { TurnSession } from "./turn-session.js";
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
export interface GatewayConnector {
    readonly signingSecret: string;
    inbound(value: unknown): IncomingMessage | undefined;
    callback(value: unknown): StatusCallback;
    send(route: GatewayRoute, part: DeliveryPart, callbackUrl: string, signal: AbortSignal): Promise<SendOutcome>;
    upload(path: string, name: string, mediaType: string, signal: AbortSignal): Promise<string>;
    typing(route: GatewayRoute, state: "start" | "stop", signal: AbortSignal): Promise<void>;
}
export type GatewaySession = Pick<TurnSession, "resume" | "admit" | "steer" | "observe" | "restore" | "close" | "artifactBaseline" | "serverInfo" | "filesystem">;
export interface GatewayFiles {
    cleanup(state: GatewayState): Promise<void>;
    release?(route: GatewayRoute, active: CodexWork | Delivery, session?: GatewaySession): Promise<void>;
    reconcile(route: GatewayRoute, state: GatewayState, session: GatewaySession, signal: AbortSignal): Promise<void>;
    prepareBatch(route: GatewayRoute, batch: Batch, session: GatewaySession, signal: AbortSignal): Promise<Batch>;
    publication(route: GatewayRoute, publicationId: string, session: GatewaySession, signal: AbortSignal): Promise<string>;
    delivery(route: GatewayRoute, work: CodexWork, outcome: TurnOutcome, session: GatewaySession, connector: GatewayConnector, signal: AbortSignal): Promise<DeliveryPart[]>;
}
export interface GatewayOperations {
    connector(id: string): GatewayConnector;
    files: GatewayFiles;
    openSession?(route: GatewayRoute, signal: AbortSignal): Promise<GatewaySession>;
    now?(): number;
}
export declare function delay(ms: number, signal: AbortSignal): Promise<void>;
export declare class Gateway {
    readonly config: GatewayConfig;
    readonly store: GatewayStore;
    readonly operations: GatewayOperations;
    ready: boolean;
    private readonly abort;
    private readonly workers;
    private readonly live;
    private readonly cleanups;
    private readonly lineStarts;
    private readonly now;
    constructor(config: GatewayConfig, store: GatewayStore, operations: GatewayOperations);
    start(): Promise<void>;
    receive(accountId: string, message: IncomingMessage): Promise<void>;
    private typing;
    wake(routeId: string): void;
    private session;
    private observe;
    private step;
    private freeze;
    private release;
    private currentPart;
    callbackState(account: string, partId: string, token: string): "stale" | "unauthorized" | "current";
    callback(account: string, partId: string, token: string, callback: StatusCallback): Promise<boolean>;
    private settle;
    private lineSlot;
    private sendPart;
    idle(): Promise<void>;
    errors(): string[];
    close(): Promise<void>;
}
export declare function secretEqual(left: string, right: string): boolean;
