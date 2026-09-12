export type FailureCode = "app_server_connect_failed" | "app_server_disconnected" | "app_server_protocol_failed" | "app_server_start_failed" | "codex_unavailable" | "config_invalid" | "gateway_running" | "effect_not_found" | "state_invalid" | "storage_failed" | "input_invalid" | "interrupted" | "output_too_large" | "thread_unavailable" | "timeout" | "turn_failed" | "unknown_agent" | "working_directory_invalid";
export declare class RouterError extends Error {
    readonly code: FailureCode;
    readonly ambiguous: boolean;
    constructor(code: FailureCode, message: string, options?: {
        ambiguous?: boolean;
        cause?: unknown;
    });
}
export declare function asRouterError(error: unknown): RouterError;
export declare function failedMessage(error: RouterError): Record<string, unknown>;
