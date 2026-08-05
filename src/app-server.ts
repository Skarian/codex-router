import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { RouterError } from "./errors.js";
import { JsonRpcClient } from "./json-rpc.js";
import { ProxyTransport, StdioTransport, type MessageTransport } from "./transport.js";

export interface AppServerConnection {
  readonly client: JsonRpcClient;
  readonly transportKind: "proxy" | "stdio";
  close(): Promise<void>;
}

async function codexHome(): Promise<string> {
  const configured = process.env.CODEX_HOME?.trim();
  if (!configured) return join(homedir(), ".codex");
  try {
    return await realpath(configured);
  } catch (error) {
    throw new RouterError("codex_unavailable", "CODEX_HOME does not identify an accessible directory.", { cause: error });
  }
}

async function socketState(path: string): Promise<"absent" | "socket" | "other"> {
  try {
    const stat = await lstat(path);
    return stat.isSocket() ? "socket" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new RouterError("app_server_connect_failed", "The Codex control socket could not be inspected.", { cause: error });
  }
}

async function chooseTransport(): Promise<MessageTransport> {
  const socketPath = join(await codexHome(), "app-server-control", "app-server-control.sock");
  let state = await socketState(socketPath);
  if (state === "absent") state = await socketState(socketPath);
  if (state === "other") {
    throw new RouterError("app_server_connect_failed", "The Codex control-socket path exists but is not a Unix socket.");
  }
  return state === "socket" ? new ProxyTransport() : new StdioTransport();
}

export async function connectAppServer(): Promise<AppServerConnection> {
  const transport = await chooseTransport();
  try {
    await transport.start();
    const client = new JsonRpcClient(transport);
    try {
      await client.initialize();
    } catch (error) {
      if (error instanceof RouterError && error.code === "app_server_disconnected") {
        throw new RouterError(
          transport.kind === "stdio" ? "app_server_start_failed" : "app_server_protocol_failed",
          transport.kind === "stdio"
            ? "The owned Codex app-server exited before initialization completed."
            : "The Codex app-server connection closed during initialization.",
          { cause: error },
        );
      }
      throw error;
    }
    return {
      client,
      transportKind: transport.kind,
      close: () => transport.close(),
    };
  } catch (error) {
    await transport.close().catch(() => undefined);
    if (error instanceof RouterError) throw error;
    throw new RouterError(
      transport.kind === "proxy" ? "app_server_connect_failed" : "app_server_start_failed",
      transport.kind === "proxy"
        ? "Could not connect to the running Codex app-server."
        : "The owned Codex app-server could not be initialized.",
      { cause: error },
    );
  }
}
