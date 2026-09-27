import writeFileAtomic from "write-file-atomic";
import * as v from "valibot";
import { unresolved } from "./gateway-state.js";
import type { ProcessingStatus } from "./gateway.js";
import type { SendbluePollStatus } from "./sendblue-poller.js";
declare const snapshotSchema: v.StrictObjectSchema<{
    readonly owner: v.StrictObjectSchema<{
        readonly pid: v.SchemaWithPipe<readonly [v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>, v.MinValueAction<number, 1, undefined>]>;
        readonly host: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MaxLengthAction<string, 256, undefined>]>;
        readonly token: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MaxLengthAction<string, 256, undefined>]>;
    }, undefined>;
    readonly capturedAt: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
    readonly ready: v.BooleanSchema<undefined>;
    readonly polling: v.ArraySchema<v.StrictObjectSchema<{
        readonly accountId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MaxLengthAction<string, 256, undefined>]>;
        readonly state: v.PicklistSchema<["running", "idle", "degraded", "blocked"], undefined>;
        readonly code: v.OptionalSchema<v.SchemaWithPipe<readonly [v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MaxLengthAction<string, 256, undefined>]>, v.RegexAction<string, undefined>]>, undefined>;
        readonly lastSuccessAt: v.OptionalSchema<v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>, undefined>;
        readonly nextRetryAt: v.OptionalSchema<v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>, undefined>;
    }, undefined>, undefined>;
    readonly routes: v.ArraySchema<v.StrictObjectSchema<{
        readonly routeId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MaxLengthAction<string, 256, undefined>]>;
        readonly state: v.PicklistSchema<["idle", "running", "retrying", "blocked", "unresolved"], undefined>;
        readonly code: v.OptionalSchema<v.SchemaWithPipe<readonly [v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MaxLengthAction<string, 256, undefined>]>, v.RegexAction<string, undefined>]>, undefined>;
    }, undefined>, undefined>;
    readonly unresolved: v.ArraySchema<v.StrictObjectSchema<{
        readonly routeId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MaxLengthAction<string, 256, undefined>]>;
        readonly effectId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MaxLengthAction<string, 256, undefined>]>;
        readonly kind: v.PicklistSchema<["codex_admission", "send"], undefined>;
    }, undefined>, undefined>;
}, undefined>;
type Snapshot = v.InferOutput<typeof snapshotSchema>;
export interface DiagnosticView {
    ready: boolean;
    polling: Array<SendbluePollStatus & {
        accountId: string;
        lastSuccessAt?: number;
    }>;
    routes: ProcessingStatus[];
    unresolved: ReturnType<typeof unresolved>["unresolved"];
}
/** Disposable diagnostics only; never opens, reclaims or changes the canonical writer lock. */
export interface GatewayStatus {
    unresolved: DiagnosticView["unresolved"];
    runtime: {
        state: "live" | "stale" | "stopped" | "unavailable";
        capturedAt?: number;
        ready?: boolean;
        polling?: Snapshot["polling"];
        routes?: Snapshot["routes"];
    };
}
export declare function readGatewayStatus(directory: string, clock?: () => number): Promise<GatewayStatus>;
/** At most one write, on a fixed cadence. Message processing never awaits diagnostic I/O. */
export declare function startDiagnostics(directory: string, view: () => DiagnosticView, options?: {
    intervalMs?: number;
    write?: typeof writeFileAtomic;
    report?: (failed: boolean) => void;
}): {
    refresh: () => Promise<void>;
    close(): void;
};
export {};
