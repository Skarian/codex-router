import type { JsonRpcClient } from "./json-rpc.js";
export interface TurnState {
    finalText?: string;
    readonly seenItemIds: Set<string>;
    readonly seenSemanticUnits: Set<string>;
}
export interface Notification {
    method: string;
    params: unknown;
}
export interface ResumedThreadState {
    thread: Record<string, unknown>;
    activeTurn?: Record<string, unknown>;
}
export interface SemanticMessage {
    type: "reasoning" | "commentary" | "completed";
    text: string;
}
export declare function resumedThreadState(resumeResult: unknown): ResumedThreadState;
export declare function waitForTurn(client: JsonRpcClient, threadId: string, turnId: string, emit: (message: SemanticMessage) => void, signal?: AbortSignal, initialNotifications?: ReadonlyArray<Notification>, state?: TurnState): Promise<SemanticMessage>;
export declare function applyTurnItems(turn: Record<string, unknown>, state: TurnState, emit: (message: SemanticMessage) => void): void;
export declare function baselineTurnItems(turn: Record<string, unknown>, state: TurnState): void;
export declare function findCorrelatedTurn(resumeResult: unknown, turnId: string | undefined, clientUserMessageId: string): Record<string, unknown> | undefined;
export declare function terminalResult(turn: Record<string, unknown>, state: TurnState): SemanticMessage | undefined;
export declare function acceptedTurnId(result: unknown, operation: "turn/start" | "thread/resume"): string;
export declare function acceptedSteerTurnId(result: unknown, expectedTurnId: string): string;
