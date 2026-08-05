export class RouterError extends Error {
    code;
    ambiguous;
    constructor(code, message, options) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = "RouterError";
        this.code = code;
        this.ambiguous = options?.ambiguous ?? false;
    }
}
export function asRouterError(error) {
    if (error instanceof RouterError)
        return error;
    return new RouterError("turn_failed", "Codex Router failed unexpectedly.", { cause: error });
}
export function failedMessage(error) {
    return {
        type: "failed",
        code: error.code,
        text: error.message,
        ...(error.ambiguous ? { ambiguous: true } : {}),
    };
}
//# sourceMappingURL=errors.js.map