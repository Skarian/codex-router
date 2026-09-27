import type { GatewayConfig, GatewayRoute, SendblueConfig } from "./config.js";
import { type GatewayConnector, type IncomingMessage, type SendOutcome, type StatusCallback } from "./gateway.js";
import type { DeliveryPart } from "./gateway-state.js";
export declare function retryPolicy(status: number, headers: Headers, now?: number): {
    retryable: boolean;
    retryAfterMs?: number;
};
interface Credentials {
    apiKeyId: string;
    apiSecretKey: string;
    signingSecret: string;
}
interface SendblueOperations {
    fetch?: typeof fetch;
    baseUrl?: string;
    requestTimeoutMs?: number;
    uploadTimeoutMs?: number;
}
export declare class Sendblue implements GatewayConnector {
    private readonly operations;
    readonly signingSecret: string;
    private readonly headers;
    constructor(credentials: Credentials, operations?: SendblueOperations);
    inbound(value: unknown): IncomingMessage | undefined;
    callback(value: unknown): StatusCallback;
    private request;
    send(route: GatewayRoute, part: DeliveryPart, callbackUrl: string, signal: AbortSignal): Promise<SendOutcome>;
    upload(path: string, name: string, mediaType: string, signal: AbortSignal): Promise<string>;
    typing(route: GatewayRoute, state: "start" | "stop", signal: AbortSignal): Promise<void>;
}
export declare function sendblueCredentials(account: SendblueConfig, env?: NodeJS.ProcessEnv): Credentials;
export declare function sendblueConnectors(config: GatewayConfig, env?: NodeJS.ProcessEnv): Map<string, Sendblue>;
export {};
