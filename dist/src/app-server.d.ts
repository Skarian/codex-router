import { JsonRpcClient } from "./json-rpc.js";
import { sshProcessSpec } from "./transport.js";
export type RemoteSocketState = "absent" | "socket";
export interface AppServerConnection {
    readonly client: JsonRpcClient;
    readonly transportKind: "proxy" | "stdio";
    close(): Promise<void>;
}
export declare function remoteControlSocketState(sshHost: string): Promise<RemoteSocketState>;
export declare function parseRemoteControlSocketState(stdout: string): RemoteSocketState;
export declare function parseDaemonStartResult(stdout: string): Record<string, unknown>;
export declare function remoteDaemonStartSpec(sshHost: string): ReturnType<typeof sshProcessSpec>;
export declare function remoteDaemonAvailable(sshHost: string): Promise<boolean>;
export interface RemoteProxyOperations {
    probe(): Promise<RemoteSocketState>;
    startDaemon(): Promise<void>;
    connectProxy(): Promise<AppServerConnection>;
}
export declare function ensureRemoteProxy(operations: RemoteProxyOperations): Promise<AppServerConnection>;
export declare function connectExistingProxy(sshHost?: string): Promise<AppServerConnection>;
export declare function connectExistingRemoteProxy(sshHost: string): Promise<AppServerConnection>;
export declare function connectAppServer(sshHost?: string): Promise<AppServerConnection>;
