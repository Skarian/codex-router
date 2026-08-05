import type { AgentConfig, RouterConfig } from "./config.js";
import type { JsonRpcClient } from "./json-rpc.js";
export interface SemanticMessage {
    type: "reasoning" | "commentary" | "completed";
    text: string;
}
export interface DoctorCheck {
    name: string;
    ok: boolean;
    text: string;
}
export declare function listAgents(config: RouterConfig): Array<{
    id: string;
    label: string;
}>;
export declare function formatAgentTable(config: RouterConfig): string;
export declare function runDoctor(config: RouterConfig): Promise<DoctorCheck[]>;
export declare function waitForTurn(client: JsonRpcClient, threadId: string, turnId: string, emit: (message: SemanticMessage) => void, signal?: AbortSignal): Promise<SemanticMessage>;
export declare function sendTurn(agent: AgentConfig, text: string, emit: (message: SemanticMessage) => void, signal?: AbortSignal): Promise<{
    result: SemanticMessage;
    transportKind: "proxy" | "stdio";
}>;
