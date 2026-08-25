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
interface ResumedThreadState {
    thread: Record<string, unknown>;
    activeTurn?: Record<string, unknown>;
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
export type CancelResult = {
    type: "interrupt_requested";
    agent: string;
    turn_id: string;
} | {
    type: "already_idle";
    agent: string;
};
export interface TurnCommandOperations {
    checkDirectory(agent: AgentConfig): Promise<DoctorCheck>;
    connect(agent: AgentConfig): Promise<AppServerConnection>;
    clientUserMessageId(): string;
}
export interface RemoteDoctorOperations {
    probe(): Promise<"absent" | "socket">;
    daemonAvailable(): Promise<boolean>;
    connectProxy(): Promise<AppServerConnection>;
}
export declare function resumedThreadState(resumeResult: unknown): ResumedThreadState;
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
export declare function acceptedSteerTurnId(result: unknown, expectedTurnId: string): string;
export interface RecoveryConnectionOperations {
    connectLocalProxy(): Promise<AppServerConnection>;
    connectRemote(sshHost: string): Promise<AppServerConnection>;
}
export declare function connectRecoveryAppServer(agent: AgentConfig, operations?: RecoveryConnectionOperations): Promise<AppServerConnection>;
export declare function sendTurn(agent: AgentConfig, text: string, emit: (message: SemanticMessage) => void, signal?: AbortSignal, operations?: TurnCommandOperations): Promise<{
    result: SemanticMessage;
    transportKind: "proxy" | "stdio";
}>;
export declare function cancelTurn(agent: AgentConfig, connect?: (agent: AgentConfig) => Promise<AppServerConnection>): Promise<CancelResult>;
export {};
