import type { JsonRpcClient } from "./json-rpc.js";
export interface TurnState {
    inputUuid?: string | undefined;
    inputSeen?: boolean;
    excludedCommentaryIds?: Set<string>;
    finalText?: string;
    imageGenerations?: Map<string, TurnOutcome["imageGenerations"][number]>;
    artifactBaseline?: ReadonlySet<string>;
    readonly seenItemIds: Set<string>;
    readonly seenSemanticUnits: Set<string>;
}
export interface TurnOutcome {
    turnId: string;
    status: "completed" | "failed" | "interrupted";
    finalText?: string;
    imageGenerations: Array<{
        id: string;
        savedPath?: string;
        result?: string;
    }>;
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
    readonly itemId?: string;
    readonly turnId?: string;
}
/** Native metadata stays internal; CLI JSON remains exactly type and text. */
export declare function semanticMessage(type: SemanticMessage["type"], text: string, itemId?: string, turnId?: string): SemanticMessage;
export declare function emitSafely(emit: (message: SemanticMessage) => void, message: SemanticMessage): void;
export declare function scopeCommentary(turn: Record<string, unknown>, state: TurnState, uuid: string): void;
export declare function resumedThreadState(resumeResult: unknown): ResumedThreadState;
export declare function waitForOutcome(client: JsonRpcClient, threadId: string, turnId: string, emit: (message: SemanticMessage) => void, signal?: AbortSignal, initialNotifications?: ReadonlyArray<Notification>, state?: TurnState): Promise<TurnOutcome>;
export declare function textResult(outcome: TurnOutcome): SemanticMessage;
export declare function terminalOutcome(turn: Record<string, unknown>, state: TurnState): TurnOutcome | undefined;
export declare function applyTurnItems(turn: Record<string, unknown>, state: TurnState, emit: (message: SemanticMessage) => void): void;
/** Active resumes can contain partial text, but completed native images are stable items. */
export declare function applyResumedImages(turn: Record<string, unknown>, state: TurnState): void;
export declare function baselineTurnItems(turn: Record<string, unknown>, state: TurnState): void;
export declare function findCorrelatedTurn(resumeResult: unknown, turnId: string | undefined, clientUserMessageId: string): Record<string, unknown> | undefined;
export declare function acceptedTurnId(result: unknown, operation: "turn/start" | "thread/resume"): string;
export declare function acceptedSteerTurnId(result: unknown, expectedTurnId: string): string;
