import { type GatewayConfig, type GatewayRoute, type SourceBinding } from "./config.js";
import type { SendblueProvider, GatewayFiles, GatewaySession, IncomingMessage, SendOutcome } from "./gateway.js";
import type { Batch, CodexWork, DeliveryPart } from "./gateway-state.js";
import type { SourcePolicy, CompletionPlan } from "./gateway-connector.js";
import type { TurnOutcome } from "./turn-state.js";
export interface SourceAdapter {
    readonly binding: SourceBinding;
    readonly policy: SourcePolicy;
    prepare(batch: Batch, session: GatewaySession, signal: AbortSignal): Promise<Batch>;
    instructions(session: GatewaySession, signal: AbortSignal): Promise<{
        publicationId?: string;
        instructions?: string;
    }>;
    complete(work: CodexWork, outcome: TurnOutcome, session: GatewaySession, signal: AbortSignal): Promise<CompletionPlan>;
    typing?(active: boolean, signal: AbortSignal): Promise<void>;
    readReceipt?(signal: AbortSignal): Promise<void>;
    outbound?: {
        line: string;
        maxPerSecond: number;
        callbackUrl(partId: string, token: string): string | undefined;
        send(part: DeliveryPart, callbackUrl: string | undefined, signal: AbortSignal): Promise<SendOutcome>;
    };
}
/** Static composition: provider-specific behavior stops at this boundary. */
export declare function sourceAdapters(config: GatewayConfig, route: GatewayRoute, files: GatewayFiles, connector: (id: string) => SendblueProvider): SourceAdapter[];
export declare function matchIncoming(config: GatewayConfig, accountId: string, message: IncomingMessage): {
    route: GatewayRoute;
    sourceId: string;
} | undefined;
