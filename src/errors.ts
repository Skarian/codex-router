export type FailureCode =
  | "app_server_connect_failed"
  | "app_server_disconnected"
  | "app_server_protocol_failed"
  | "app_server_start_failed"
  | "codex_unavailable"
  | "config_invalid"
  | "gateway_running"
  | "effect_not_found"
  | "state_invalid"
  | "storage_failed"
  | "input_invalid"
  | "interrupted"
  | "output_too_large"
  | "thread_unavailable"
  | "timeout"
  | "turn_failed"
  | "unknown_agent"
  | "working_directory_invalid";

export class RouterError extends Error {
  readonly code: FailureCode;
  readonly ambiguous: boolean;

  constructor(code: FailureCode, message: string, options?: { ambiguous?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RouterError";
    this.code = code;
    this.ambiguous = options?.ambiguous ?? false;
  }
}

export function asRouterError(error: unknown): RouterError {
  if (error instanceof RouterError) return error;
  return new RouterError("turn_failed", "Codex Router failed unexpectedly.", { cause: error });
}

export function failedMessage(error: RouterError): Record<string, unknown> {
  return {
    type: "failed",
    code: error.code,
    text: error.message,
    ...(error.ambiguous ? { ambiguous: true } : {}),
  };
}
