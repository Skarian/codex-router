import type { GatewayRoute } from "./config.js";
import { type GatewayConnector, type GatewayFiles, type GatewaySession } from "./gateway.js";
import { type Batch, type CodexWork, type Delivery, type DeliveryPart, type GatewayState } from "./gateway-state.js";
import type { TurnOutcome } from "./turn-state.js";
export declare function safeFilename(value: string): string;
export declare function inspectLocal(path: string): Promise<{
    size: number;
    identity: string;
}>;
export declare function copyLocal(source: string, destination: string, signal: AbortSignal): Promise<void>;
export declare function hashFile(path: string, signal?: AbortSignal): Promise<string>;
export declare class GatewayFilePlane implements GatewayFiles {
    readonly directory: string;
    private readonly reconciled;
    private root;
    constructor(directory: string);
    private spool;
    private home;
    cleanup(state: GatewayState): Promise<void>;
    reconcile(route: GatewayRoute, state: GatewayState, session: GatewaySession, signal: AbortSignal): Promise<void>;
    private directoryOnHost;
    private reconcileHost;
    prepareBatch(route: GatewayRoute, batch: Batch, session: GatewaySession, signal: AbortSignal): Promise<Batch>;
    publication(route: GatewayRoute, id: string, session: GatewaySession, signal: AbortSignal): Promise<string>;
    delivery(route: GatewayRoute, work: CodexWork, outcome: TurnOutcome, session: GatewaySession, connector: GatewayConnector, signal: AbortSignal): Promise<DeliveryPart[]>;
    release(route: GatewayRoute, active: CodexWork | Delivery, session?: GatewaySession): Promise<void>;
}
