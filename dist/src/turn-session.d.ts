import { type AppServerConnection } from "./app-server.js";
import type { AgentConfig } from "./config.js";
import { RouterError } from "./errors.js";
import { resumedThreadState, type TurnOutcome, type SemanticMessage } from "./turn-state.js";
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
export declare class TurnEndedError extends RouterError {
    constructor();
}
export interface AdmissionIntent {
    clientUserMessageId: string;
    expectedTurnId?: string;
}
export type TurnInput = {
    type: "text";
    text: string;
    text_elements: unknown[];
} | {
    type: "localImage";
    path: string;
};
/** One connection owner for concurrent observation and serialized admissions. */
export declare class TurnSession {
    private readonly agent;
    private readonly operations;
    private readonly abort;
    private readonly state;
    private connection;
    private buffered;
    private resumed;
    private resumeFlight;
    private recoveryFlight;
    private admissionQueue;
    private pending;
    private owned;
    private observation;
    private terminal;
    private closing;
    private closeFlight;
    private readonly stopCallerAbort;
    private constructor();
    static open(agent: AgentConfig, operations?: TurnCommandOperations, signal?: AbortSignal): Promise<TurnSession>;
    get transportKind(): "proxy" | "stdio";
    get serverInfo(): import("./json-rpc.js").AppServerInfo;
    get artifactBaseline(): string[];
    private checkOpen;
    resume(): Promise<ReturnType<typeof resumedThreadState>>;
    admit(input: readonly TurnInput[], intent: AdmissionIntent): Promise<string>;
    steer(input: readonly TurnInput[], intent: AdmissionIntent): Promise<string>;
    private admitOnce;
    /** Reconstruct durable work without starting or steering a turn. */
    restore(turnId: string | undefined, intent: AdmissionIntent | undefined, artifactBaseline: readonly string[]): Promise<string>;
    observe(turnId: string, emit?: (message: SemanticMessage) => void): Promise<TurnOutcome>;
    private observeOwned;
    private recover;
    private reconnect;
    close(): Promise<void>;
}
export declare function sendTurn(agent: AgentConfig, text: string, emit: (message: SemanticMessage) => void, signal?: AbortSignal, operations?: TurnCommandOperations): Promise<{
    result: SemanticMessage;
    transportKind: "proxy" | "stdio";
}>;
export declare function cancelTurn(agent: AgentConfig, connect?: (agent: AgentConfig) => Promise<AppServerConnection>, effectAckTimeoutMs?: number): Promise<CancelResult>;
