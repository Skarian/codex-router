export interface AgentConfig {
    id: string;
    label: string;
    cwd: string;
    threadId: string;
    model: string;
    reasoning?: string;
    sshHost?: string;
}
export interface RouterConfig {
    agents: AgentConfig[];
    gateway?: GatewayConfig;
}
export declare function defaultConfigPath(): string;
export declare function parseConfig(source: string): RouterConfig;
export declare function loadConfig(path: string): Promise<RouterConfig>;
export declare function findAgent(config: RouterConfig, id: string): AgentConfig;
export interface SendblueConfig {
    id: string;
    mode?: "poll" | "webhook";
    pollStart?: string;
    pollIntervalMs?: number;
    batchQuietMs?: number;
    apiKeyId?: string | undefined;
    apiSecretKey?: string | undefined;
    webhookSecret?: string | undefined;
    apiKeyIdEnv?: string | undefined;
    apiSecretKeyEnv?: string | undefined;
    webhookSecretEnv?: string | undefined;
}
export interface HttpsConfig {
    id: string;
    bearerToken?: string;
    bearerTokenEnv?: string;
}
export type SourceBinding = {
    kind: "sendblue";
    id: string;
    accountId: string;
    sender: string;
    sendblueNumber: string;
} | {
    kind: "https";
    id: string;
    accountId: string;
};
export interface GatewayRoute {
    id: string;
    sendblueId?: string;
    sender?: string;
    sendblueNumber?: string;
    httpsId?: string;
    agent: AgentConfig;
}
/** Derive source bindings from the configured route. */
export declare function routeSources(route: GatewayRoute): SourceBinding[];
export interface GatewayConfig {
    listenPort: number;
    listenHost?: string;
    tls?: {
        certPath: string;
        keyPath: string;
    };
    publicUrl?: string;
    stateDir: string;
    sendblue: SendblueConfig[];
    https?: HttpsConfig[];
    maxRequests?: number;
    retainedBytes?: number;
    routes: GatewayRoute[];
}
