import { JsonRpcClient } from "./json-rpc.js";
export interface AppServerConnection {
    readonly client: JsonRpcClient;
    readonly transportKind: "proxy" | "stdio";
    close(): Promise<void>;
}
export declare function connectAppServer(): Promise<AppServerConnection>;
