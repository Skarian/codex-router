export declare const GATEWAY_OWNER_FILE = "owner.json";
/** Local-filesystem exclusion belongs to the kernel, not PID or heartbeat age.
 * Never unlink/replace the sentinel: all processes must lock the same file. */
export declare function acquireGatewayLock(directory: string): Promise<() => Promise<void>>;
