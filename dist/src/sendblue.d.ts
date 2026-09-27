import type { MessageListParams, MessageListResponse, MessageResponse } from "sendblue/resources/messages";
import type { GatewayConfig, GatewayRoute, SendblueConfig } from "./config.js";
import { type SendblueProvider, type IncomingMessage, type SendOutcome, type StatusCallback } from "./gateway.js";
import type { DeliveryPart } from "./gateway-state.js";
export declare function retryPolicy(status: number, headers: Headers, now?: number): {
    retryable: boolean;
    retryAfterMs?: number;
};
export type SendblueListQuery = MessageListParams;
export type SendblueListPage = MessageListResponse;
export declare class SendblueRequestError extends Error {
    readonly retryable: boolean;
    readonly retryAfterMs?: number | undefined;
    constructor(retryable: boolean, retryAfterMs?: number | undefined);
}
interface Credentials {
    apiKeyId: string;
    apiSecretKey: string;
    signingSecret?: string;
}
interface SendblueOperations {
    fetch?: typeof fetch;
    baseUrl?: string;
    requestTimeoutMs?: number;
    uploadTimeoutMs?: number;
}
export declare class Sendblue implements SendblueProvider {
    private readonly operations;
    readonly signingSecret: string;
    private readonly client;
    constructor(credentials: Credentials, operations?: SendblueOperations);
    agentInstructions(outputDirectory: string): string;
    inbound(value: unknown): IncomingMessage | undefined;
    callback(value: unknown): StatusCallback;
    private request;
    private checked;
    list(query: SendblueListQuery, signal: AbortSignal): Promise<SendblueListPage>;
    getStatus(handle: string, signal: AbortSignal): Promise<MessageResponse>;
    send(route: GatewayRoute, part: DeliveryPart, callbackUrl: string | undefined, signal: AbortSignal): Promise<SendOutcome>;
    upload(path: string, name: string, mediaType: string, signal: AbortSignal): Promise<string>;
    readReceipt(route: GatewayRoute, signal: AbortSignal): Promise<void>;
    typing(route: GatewayRoute, state: "start" | "stop", signal: AbortSignal): Promise<void>;
}
export declare function sendblueCredentials(account: SendblueConfig, env?: NodeJS.ProcessEnv): Credentials;
export declare function sendblueConnectors(config: GatewayConfig, env?: NodeJS.ProcessEnv): Map<string, Sendblue>;
export {};
