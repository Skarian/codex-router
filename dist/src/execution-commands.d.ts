import type { AgentConfig } from "./config.js";
import { type ExecutionSession } from "./execution-session.js";
import type { CancelResult } from "./turn-session.js";
import { type SemanticMessage } from "./turn-state.js";
type OpenSession = (agent: AgentConfig, signal: AbortSignal) => Promise<ExecutionSession>;
/** Commands use the same owner discovery as gateway turns, without gateway state. */
export declare function sendTurn(agent: AgentConfig, text: string, emit: (message: SemanticMessage) => void, signal?: AbortSignal, open?: OpenSession): Promise<{
    result: SemanticMessage;
    transportKind: import("./execution-session.js").ExecutionBackend;
}>;
export declare function cancelTurn(agent: AgentConfig, open?: OpenSession): Promise<CancelResult>;
export {};
