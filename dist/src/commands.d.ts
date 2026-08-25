import type { AgentConfig, RouterConfig } from "./config.js";
import { type AppServerConnection } from "./app-server.js";
import type { JsonRpcClient } from "./json-rpc.js";
interface TurnState {
    finalText?: string;
    readonly seenItemIds: Set<string>;
    readonly seenSemanticUnits: Set<string>;
}
interface Notification {
    method: string;
    params: unknown;
}
export interface SemanticMessage {
    type: "reasoning" | "commentary" | "completed";
    text: string;
}
export interface DoctorCheck {
    name: string;
    ok: boolean;
    text: string;
}
export interface RemoteDoctorOperations {
    probe(): Promise<"absent" | "socket">;
    daemonAvailable(): Promise<boolean>;
    connectProxy(): Promise<AppServerConnection>;
}
export declare function listAgents(config: RouterConfig): Array<{
    id: string;
    label: string;
}>;
export declare function formatAgentTable(config: RouterConfig): string;
export declare function inspectRemoteAppServer(agent: AgentConfig, operations: RemoteDoctorOperations): Promise<DoctorCheck[]>;
export declare function runDoctor(config: RouterConfig): Promise<DoctorCheck[]>;
export declare function waitForTurn(client: JsonRpcClient, threadId: string, turnId: string, emit: (message: SemanticMessage) => void, signal?: AbortSignal, initialNotifications?: ReadonlyArray<Notification>, state?: TurnState, deadlineMs?: number): Promise<SemanticMessage>;
export declare function findCorrelatedTurn(resumeResult: unknown, turnId: string | undefined, clientUserMessageId: string): Record<string, unknown> | undefined;
export declare function isReconnectable(error: unknown): boolean;
export declare function acceptedTurnId(result: unknown, operation: "turn/start" | "thread/resume"): string;
export interface RecoveryConnectionOperations {
    connectLocalProxy(): Promise<AppServerConnection>;
    connectRemote(sshHost: string): Promise<AppServerConnection>;
}
export declare function connectRecoveryAppServer(agent: AgentConfig, operations?: RecoveryConnectionOperations): Promise<AppServerConnection>;
export declare function sendTurn(agent: AgentConfig, text: string, emit: (message: SemanticMessage) => void, signal?: AbortSignal): Promise<{
    result: SemanticMessage;
    transportKind: "proxy" | "stdio";
}>;
export {};
