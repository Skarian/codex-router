import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RouterError } from "./errors.js";
import { JsonRpcClient } from "./json-rpc.js";
import { ProxyTransport, sshProcessSpec, StdioTransport } from "./transport.js";
const execFileAsync = promisify(execFile);
async function codexHome() {
    const configured = process.env.CODEX_HOME?.trim();
    if (!configured)
        return join(homedir(), ".codex");
    try {
        return await realpath(configured);
    }
    catch (error) {
        throw new RouterError("codex_unavailable", "CODEX_HOME does not identify an accessible directory.", { cause: error });
    }
}
async function socketState(path) {
    try {
        const stat = await lstat(path);
        return stat.isSocket() ? "socket" : "other";
    }
    catch (error) {
        if (error.code === "ENOENT")
            return "absent";
        throw new RouterError("app_server_connect_failed", "The Codex control socket could not be inspected.", { cause: error });
    }
}
async function remoteControlSocketExists(sshHost) {
    const script = 'codex_home=${CODEX_HOME:-"$HOME/.codex"}; socket="$codex_home/app-server-control/app-server-control.sock"; if test -S "$socket"; then printf socket; elif test -e "$socket"; then printf other; else printf absent; fi';
    const spec = sshProcessSpec(sshHost, ["sh", "-c", script]);
    try {
        const { stdout } = await execFileAsync(spec.command, spec.args, { timeout: 10_000 });
        return parseRemoteControlSocketState(stdout);
    }
    catch (error) {
        if (error instanceof RouterError)
            throw error;
        throw new RouterError("app_server_connect_failed", "The remote Codex control socket could not be inspected over SSH.", { cause: error });
    }
}
export function parseRemoteControlSocketState(stdout) {
    const state = stdout.trim();
    if (state === "socket")
        return true;
    if (state === "absent")
        return false;
    if (state === "other") {
        throw new RouterError("app_server_connect_failed", "The remote Codex control-socket path exists but is not a Unix socket.");
    }
    throw new RouterError("app_server_protocol_failed", "The remote Codex control-socket probe returned an invalid response.");
}
async function chooseTransport(sshHost) {
    if (sshHost !== undefined) {
        return await remoteControlSocketExists(sshHost)
            ? new ProxyTransport(sshHost)
            : new StdioTransport(sshHost);
    }
    const socketPath = join(await codexHome(), "app-server-control", "app-server-control.sock");
    let state = await socketState(socketPath);
    if (state === "absent")
        state = await socketState(socketPath);
    if (state === "other") {
        throw new RouterError("app_server_connect_failed", "The Codex control-socket path exists but is not a Unix socket.");
    }
    return state === "socket" ? new ProxyTransport() : new StdioTransport();
}
export async function connectAppServer(sshHost, requiredTransportKind) {
    const transport = requiredTransportKind === "proxy"
        ? new ProxyTransport(sshHost)
        : await chooseTransport(sshHost);
    try {
        await transport.start();
        const client = new JsonRpcClient(transport);
        try {
            await client.initialize();
        }
        catch (error) {
            if (error instanceof RouterError && error.code === "app_server_disconnected") {
                throw new RouterError(transport.kind === "stdio" ? "app_server_start_failed" : "app_server_protocol_failed", transport.kind === "stdio"
                    ? "The owned Codex app-server exited before initialization completed."
                    : "The Codex app-server connection closed during initialization.", { cause: error });
            }
            throw error;
        }
        return {
            client,
            transportKind: transport.kind,
            close: () => transport.close(),
        };
    }
    catch (error) {
        await transport.close().catch(() => undefined);
        if (error instanceof RouterError)
            throw error;
        throw new RouterError(transport.kind === "proxy" ? "app_server_connect_failed" : "app_server_start_failed", transport.kind === "proxy"
            ? "Could not connect to the running Codex app-server."
            : "The owned Codex app-server could not be initialized.", { cause: error });
    }
}
//# sourceMappingURL=app-server.js.map