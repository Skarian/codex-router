import { type AppServerConnection } from "./app-server.js";
import type { AgentConfig } from "./config.js";
import { type SemanticMessage } from "./turn-state.js";
export type CancelResult = {
    type: "interrupt_requested";
    agent: string;
    turn_id: string;
} | {
    type: "already_idle";
    agent: string;
};
export interface RecoveryConnectionOperations {
    connectLocalProxy(): Promise<AppServerConnection>;
    connectRemote(sshHost: string): Promise<AppServerConnection>;
}
export interface TurnCommandOperations {
    checkDirectory(agent: AgentConfig): Promise<{
        ok: boolean;
    }>;
    connect(agent: AgentConfig): Promise<AppServerConnection>;
    clientUserMessageId(): string;
    effectAckTimeoutMs?: number;
    threadResumeTimeoutMs?: number;
    recovery?: RecoveryConnectionOperations;
    reconnectDelaysMs?: readonly number[];
}
export declare function sendTurn(agent: AgentConfig, text: string, emit: (message: SemanticMessage) => void, signal?: AbortSignal, operations?: TurnCommandOperations): Promise<{
    result: SemanticMessage;
    transportKind: "proxy" | "stdio";
}>;
export declare function cancelTurn(agent: AgentConfig, connect?: (agent: AgentConfig) => Promise<AppServerConnection>, effectAckTimeoutMs?: number): Promise<CancelResult>;
