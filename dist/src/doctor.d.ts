import type { AgentConfig, RouterConfig } from "./config.js";
import { type AppServerConnection } from "./app-server.js";
export interface DoctorCheck {
    name: string;
    ok: boolean;
    text: string;
}
export interface RemoteDoctorOperations {
    probe(): Promise<"absent" | "socket">;
    daemonAvailable(): Promise<boolean>;
    connectProxy(): Promise<AppServerConnection>;
}
export declare function inspectRemoteAppServer(agent: AgentConfig, operations: RemoteDoctorOperations): Promise<DoctorCheck[]>;
export declare function checkAgentDirectory(agent: AgentConfig): Promise<DoctorCheck>;
export declare function runDoctor(config: RouterConfig): Promise<DoctorCheck[]>;
