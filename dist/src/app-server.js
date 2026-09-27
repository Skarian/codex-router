import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { RouterError } from "./errors.js";
import { JsonRpcClient } from "./json-rpc.js";
import { ProxyTransport, sshProcessSpec, StdioTransport } from "./transport.js";
const execFileAsync = promisify(execFile);
const REMOTE_PROBE_TIMEOUT_MS = 15_000;
const REMOTE_DAEMON_START_TIMEOUT_MS = 30_000;
const REMOTE_COMMAND_MAX_BUFFER = 64 * 1024;
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
export async function localControlSocketState(path) {
    let entry;
    try {
        entry = await lstat(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return "absent";
        throw new RouterError("app_server_connect_failed", "The Codex control socket could not be inspected.", { cause: error });
    }
    if (!entry.isSocket() && !entry.isSymbolicLink())
        return "other";
    try {
        const resolved = await realpath(path);
        const endpoint = await stat(resolved);
        if (!endpoint.isSocket())
            return "other";
        const uid = process.getuid?.();
        const parents = await Promise.all([stat(dirname(path)), stat(dirname(resolved))]);
        if (uid === undefined || entry.uid !== uid || endpoint.uid !== uid || (endpoint.mode & 0o077) !== 0
            || parents.some((parent) => !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022) !== 0)) {
            throw new RouterError("app_server_connect_failed", "The Codex control socket must belong to the current user and have protected permissions.");
        }
        return "socket";
    }
    catch (error) {
        if (error instanceof RouterError)
            throw error;
        // A broken rendezvous is not proof that no server owns this host.
        throw new RouterError("app_server_connect_failed", "The Codex control socket could not be resolved safely.", { cause: error });
    }
}
export async function remoteControlSocketState(sshHost) {
    const script = 'codex_home=${CODEX_HOME:-"$HOME/.codex"}; socket="$codex_home/app-server-control/app-server-control.sock"; if test -S "$socket"; then printf socket; elif test -e "$socket" || test -L "$socket"; then printf other; else printf absent; fi';
    const spec = sshProcessSpec(sshHost, ["sh", "-c", script]);
    try {
        const { stdout } = await execFileAsync(spec.command, spec.args, {
            timeout: REMOTE_PROBE_TIMEOUT_MS,
            maxBuffer: REMOTE_COMMAND_MAX_BUFFER,
        });
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
    if (state === "socket" || state === "absent")
        return state;
    if (state === "other") {
        throw new RouterError("app_server_connect_failed", "The remote Codex control-socket path exists but is not a Unix socket.");
    }
    throw new RouterError("app_server_protocol_failed", "The remote Codex control-socket probe returned an invalid response.");
}
export function parseDaemonStartResult(stdout) {
    try {
        const result = JSON.parse(stdout.trim());
        if (result === null || typeof result !== "object" || Array.isArray(result))
            throw new Error("Expected a JSON object.");
        return result;
    }
    catch (error) {
        throw new RouterError("app_server_protocol_failed", "The remote Codex daemon returned an invalid lifecycle response.", { cause: error });
    }
}
export function remoteDaemonStartSpec(sshHost) {
    return sshProcessSpec(sshHost, ["codex", "app-server", "daemon", "start"]);
}
async function startRemoteDaemon(sshHost) {
    const spec = remoteDaemonStartSpec(sshHost);
    try {
        const { stdout } = await execFileAsync(spec.command, spec.args, {
            timeout: REMOTE_DAEMON_START_TIMEOUT_MS,
            maxBuffer: REMOTE_COMMAND_MAX_BUFFER,
        });
        parseDaemonStartResult(stdout);
    }
    catch (error) {
        if (error instanceof RouterError)
            throw error;
        const exitCode = error.code;
        if (exitCode === 127) {
            throw new RouterError("codex_unavailable", "The remote Codex executable is unavailable to noninteractive SSH sessions.", { cause: error });
        }
        if (exitCode === 255) {
            throw new RouterError("app_server_connect_failed", "The remote Codex daemon could not be reached over SSH.", { cause: error });
        }
        throw new RouterError("app_server_start_failed", "The persistent remote Codex app-server could not be started. On the remote host, install or update standalone Codex with `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, then retry.", { cause: error });
    }
}
export async function remoteDaemonAvailable(sshHost) {
    const script = 'codex_home=${CODEX_HOME:-"$HOME/.codex"}; if test -x "$codex_home/packages/standalone/current/codex" && codex app-server daemon start --help >/dev/null 2>&1; then printf available; else printf unavailable; fi';
    const spec = sshProcessSpec(sshHost, ["sh", "-c", script]);
    try {
        const { stdout } = await execFileAsync(spec.command, spec.args, {
            timeout: REMOTE_PROBE_TIMEOUT_MS,
            maxBuffer: REMOTE_COMMAND_MAX_BUFFER,
        });
        const result = stdout.trim();
        if (result === "available")
            return true;
        if (result === "unavailable")
            return false;
        throw new RouterError("app_server_protocol_failed", "The remote Codex daemon capability probe returned an invalid response.");
    }
    catch (error) {
        if (error instanceof RouterError)
            throw error;
        throw new RouterError("app_server_connect_failed", "The remote Codex daemon capability could not be inspected over SSH.", { cause: error });
    }
}
async function connectTransport(transport) {
    try {
        await transport.start();
        const client = new JsonRpcClient(transport);
        try {
            await client.initialize();
        }
        catch (error) {
            if (error instanceof RouterError && error.code === "app_server_disconnected") {
                throw new RouterError(transport.kind === "stdio" ? "app_server_start_failed" : "app_server_connect_failed", transport.kind === "stdio"
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
export async function connectLocalAppServer(operations) {
    const defaults = operations ?? {
        probe: async () => {
            const socketPath = join(await codexHome(), "app-server-control", "app-server-control.sock");
            return localControlSocketState(socketPath);
        },
        connectProxy: () => connectTransport(new ProxyTransport()),
        connectStdio: () => connectTransport(new StdioTransport()),
    };
    let state = await defaults.probe();
    if (state === "absent")
        state = await defaults.probe();
    if (state === "other") {
        throw new RouterError("app_server_connect_failed", "The Codex control-socket path exists but is not a Unix socket.");
    }
    if (state === "absent")
        return defaults.connectStdio();
    return defaults.connectProxy();
}
export async function ensureRemoteProxy(operations) {
    const state = await operations.probe();
    if (state === "socket") {
        try {
            return await operations.connectProxy();
        }
        catch {
            // A socket inode is only a hint. One idempotent daemon start may repair
            // stale managed state, but the router never removes or restarts anything.
        }
    }
    await operations.startDaemon();
    if (await operations.probe() !== "socket") {
        throw new RouterError("app_server_start_failed", "The remote Codex daemon started without exposing its control socket.");
    }
    return operations.connectProxy();
}
export async function connectExistingProxy(sshHost) {
    return connectTransport(new ProxyTransport(sshHost));
}
export async function connectExistingRemoteProxy(sshHost) {
    return connectExistingProxy(sshHost);
}
export async function connectAppServer(sshHost) {
    if (sshHost === undefined)
        return connectLocalAppServer();
    return ensureRemoteProxy({
        probe: () => remoteControlSocketState(sshHost),
        startDaemon: () => startRemoteDaemon(sshHost),
        connectProxy: () => connectExistingRemoteProxy(sshHost),
    });
}
//# sourceMappingURL=app-server.js.map