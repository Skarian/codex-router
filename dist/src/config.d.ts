export interface AgentConfig {
    id: string;
    label: string;
    cwd: string;
    threadId: string;
    model: string;
    reasoning?: string;
}
export interface RouterConfig {
    agents: AgentConfig[];
}
export declare function defaultConfigPath(): string;
export declare function parseConfig(source: string): RouterConfig;
export declare function loadConfig(path: string): Promise<RouterConfig>;
export declare function findAgent(config: RouterConfig, id: string): AgentConfig;
