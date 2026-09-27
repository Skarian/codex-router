import type { IncomingMessage, ServerResponse } from "node:http";
import { Gateway } from "./gateway.js";
import type { HttpsConfig } from "./config.js";
export declare const HTTPS_BODY_LIMIT: number;
export declare class HttpFailure extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code?: string);
}
export declare function httpsCredentials(accounts: readonly HttpsConfig[]): Map<string, string>;
export declare function handleHttps(gateway: Gateway, tokens: ReadonlyMap<string, string>, request: IncomingMessage, response: ServerResponse, body: () => Promise<string>): Promise<boolean>;
