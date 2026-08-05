export interface AgentLock {
    release(): Promise<void>;
}
export declare function acquireAgentLock(configPath: string, agentId: string): Promise<AgentLock>;
