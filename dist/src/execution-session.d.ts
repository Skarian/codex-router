import type { AgentConfig } from "./config.js";
import { TurnSession, type AdmissionIntent } from "./turn-session.js";
export type ExecutionBackend = "desktop" | "proxy" | "stdio";
export interface ExecutionBinding {
    backend: ExecutionBackend;
    host: string;
    codexHome: string;
    threadId: string;
}
export type ExecutionSession = Pick<TurnSession, "resume" | "admit" | "observe" | "close" | "artifactBaseline" | "serverInfo" | "filesystem"> & {
    readonly backend?: ExecutionBackend;
    interrupt?(expectedTurnId: string): Promise<void>;
    readonly capabilities?: {
        readonly steer: boolean;
        readonly commentary?: {
            state: "available" | "unavailable";
            reason?: string;
        };
    };
    restore(turnId: string | undefined, intent: AdmissionIntent | undefined, artifactBaseline: readonly string[], clientUserMessageId?: string): Promise<string>;
};
export declare function executionBinding(agent: AgentConfig, session: ExecutionSession): ExecutionBinding;
export declare function verifyExecutionBinding(expected: ExecutionBinding, actual: ExecutionBinding): void;
interface SessionDiscovery {
    desktop(agent: AgentConfig, signal: AbortSignal): Promise<ExecutionSession | undefined>;
    direct(agent: AgentConfig, signal: AbortSignal): Promise<ExecutionSession>;
}
export declare function openExecutionSession(agent: AgentConfig, signal: AbortSignal, binding?: ExecutionBinding, operations?: SessionDiscovery): Promise<ExecutionSession>;
export {};
