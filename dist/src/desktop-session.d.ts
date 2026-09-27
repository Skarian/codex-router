import type { AgentConfig } from "./config.js";
import type { AdmissionIntent, TurnInput } from "./turn-session.js";
import { type ResumedThreadState, type SemanticMessage, type TurnOutcome } from "./turn-state.js";
type Row = Record<string, any>;
/** Desktop's complete-history state contains ordered turns, not app-server thread objects. */
export declare function desktopTurns(snapshot: Row): Row[];
export declare function desktopOutcome(turn: Row, uuid: string, baseline: readonly string[]): TurnOutcome | undefined;
export declare class DesktopSession {
    private readonly agent;
    private readonly ipc;
    private readonly owner;
    private readonly home;
    private readonly signal?;
    readonly backend: "desktop";
    get capabilities(): {
        steer: true;
        commentary: {
            state: "available" | "unavailable";
            reason?: string;
        };
    };
    readonly serverInfo: {
        codexHome: string;
        platformFamily: string;
        platformOs: string;
        userAgent: string;
    };
    private snapshot;
    private commentary;
    get commentaryStatus(): {
        state: "available" | "unavailable";
        reason?: string;
    };
    private revision;
    private streamError;
    private baseline;
    private boundary;
    private acceptedTurn;
    private admissionBusy;
    private disposed;
    private removeListener;
    private constructor();
    static discover(agent: AgentConfig, signal?: AbortSignal): Promise<DesktopSession | undefined>;
    get artifactBaseline(): string[];
    private history;
    resume(): Promise<ResumedThreadState>;
    admit(input: readonly TurnInput[], intent: AdmissionIntent): Promise<string>;
    private accepted;
    restore(turnId: string | undefined, intent: AdmissionIntent | undefined, baseline: readonly string[], clientUserMessageId?: string): Promise<string>;
    observe(turnId: string, emit?: (message: SemanticMessage) => void): Promise<TurnOutcome>;
    interrupt(expectedTurnId: string): Promise<void>;
    filesystem(method: "fs/getMetadata" | "fs/readDirectory" | "fs/createDirectory" | "fs/remove", params: unknown): Promise<unknown>;
    close(): Promise<void>;
}
export {};
