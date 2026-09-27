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
    apiKeyId?: string | undefined;
    apiSecretKey?: string | undefined;
    webhookSecret?: string | undefined;
    apiKeyIdEnv?: string | undefined;
    apiSecretKeyEnv?: string | undefined;
    webhookSecretEnv?: string | undefined;
}
export interface GatewayRoute {
    id: string;
    sendblueId: string;
    sender: string;
    sendblueNumber: string;
    agent: AgentConfig;
}
export interface GatewayConfig {
    listenPort: number;
    publicUrl: string;
    stateDir: string;
    sendblue: SendblueConfig[];
    routes: GatewayRoute[];
}
