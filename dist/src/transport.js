import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { RouterError } from "./errors.js";
const STDERR_TAIL_BYTES = 16 * 1024;
const STDERR_DIAGNOSTIC_BYTES = 1_024;
const stderrTails = new WeakMap();
function remoteCommand(args) {
    return args.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(" ");
}
export function sshProcessSpec(sshHost, args) {
    return {
        command: "ssh",
        args: [
            "-T",
            "-oBatchMode=yes",
            "-oConnectTimeout=10",
            "-oServerAliveInterval=15",
            "-oServerAliveCountMax=4",
            sshHost,
            remoteCommand(args),
        ],
    };
}
class BaseTransport {
    messageListeners = new Set();
    closeListeners = new Set();
    onMessage(listener) {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
    }
    onClose(listener) {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }
    emitMessage(message) {
        for (const listener of this.messageListeners)
            listener(message);
    }
    emitClose(error) {
        for (const listener of this.closeListeners)
            listener(error);
    }
}
export function codexProcessSpec(args, sshHost) {
    return sshHost === undefined
        ? { command: "codex", args }
        : sshProcessSpec(sshHost, ["codex", ...args]);
}
function spawnCodex(args, sshHost) {
    const spec = codexProcessSpec(args, sshHost);
    const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
    stderrTails.set(child, "");
    child.stderr.on("data", (chunk) => {
        const next = `${stderrTails.get(child) ?? ""}${chunk.toString()}`;
        stderrTails.set(child, Buffer.byteLength(next, "utf8") <= STDERR_TAIL_BYTES
            ? next
            : Buffer.from(next).subarray(-STDERR_TAIL_BYTES).toString("utf8"));
    });
    return child;
}
export function boundedProcessDiagnostic(stderr) {
    const clean = stderr.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\s+/g, " ").trim();
    if (!clean)
        return undefined;
    const bytes = Buffer.from(clean);
    return bytes.length <= STDERR_DIAGNOSTIC_BYTES
        ? clean
        : bytes.subarray(bytes.length - STDERR_DIAGNOSTIC_BYTES).toString("utf8");
}
export function safeSshDiagnostic(stderr) {
    const diagnostic = boundedProcessDiagnostic(stderr);
    if (!diagnostic)
        return undefined;
    return /^(ssh:|connection (?:closed|reset)|broken pipe|kex_exchange_identification:)/i.test(diagnostic)
        ? diagnostic
        : undefined;
}
function processError(message, child, sshHost) {
    const diagnostic = boundedProcessDiagnostic(stderrTails.get(child) ?? "");
    const safeDiagnostic = sshHost === undefined ? undefined : safeSshDiagnostic(diagnostic ?? "");
    return new Error(`${message}${safeDiagnostic ? ` ${safeDiagnostic}` : ""}`, {
        cause: diagnostic === undefined ? undefined : new Error(diagnostic),
    });
}
function processExitError(label, child, code, signal, sshHost) {
    return processError(`${label} exited (${code ?? signal ?? "unknown"}).`, child, sshHost);
}
function waitForSpawn(child, code) {
    return new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error) => reject(new RouterError(code, "The Codex app-server process could not be started.", { cause: error })));
    });
}
async function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null)
        return;
    await new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            resolve();
        }, timeoutMs);
        timer.unref();
        child.once("exit", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}
export class StdioTransport extends BaseTransport {
    sshHost;
    kind = "stdio";
    child;
    closing = false;
    constructor(sshHost) {
        super();
        this.sshHost = sshHost;
    }
    async start() {
        const child = spawnCodex(["app-server", "--listen", "stdio://"], this.sshHost);
        this.child = child;
        await waitForSpawn(child, "app_server_start_failed");
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on("line", (line) => {
            try {
                this.emitMessage(JSON.parse(line));
            }
            catch (error) {
                this.emitClose(new RouterError("app_server_protocol_failed", "The owned app-server emitted invalid JSON.", { cause: error }));
            }
        });
        child.once("exit", (code, signal) => {
            if (!this.closing)
                this.emitClose(processExitError("Owned app-server", child, code, signal, this.sshHost));
        });
    }
    async send(message) {
        const child = this.child;
        if (!child?.stdin.writable)
            throw new RouterError("app_server_disconnected", "The owned app-server is not connected.");
        await new Promise((resolve, reject) => {
            child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
        });
    }
    async close() {
        const child = this.child;
        if (!child)
            return;
        this.closing = true;
        child.stdin.end();
        await waitForExit(child, 2_000);
    }
}
export class ProxyTransport extends BaseTransport {
    sshHost;
    kind = "proxy";
    child;
    socket;
    closing = false;
    constructor(sshHost) {
        super();
        this.sshHost = sshHost;
    }
    async start() {
        const child = spawnCodex(["app-server", "proxy"], this.sshHost);
        this.child = child;
        await waitForSpawn(child, "codex_unavailable");
        const duplex = Duplex.from({ readable: child.stdout, writable: child.stdin });
        const websocketOptions = {
            // Node's HTTP types require net.Socket here, while ws intentionally
            // accepts a generic Duplex and feature-detects socket-only methods.
            createConnection: () => duplex,
            closeTimeout: 500,
            perMessageDeflate: false,
            handshakeTimeout: 5_000,
            maxPayload: 4 * 1024 * 1024,
        };
        const socket = new WebSocket("ws://localhost/rpc", websocketOptions);
        this.socket = socket;
        socket.on("message", (data, isBinary) => {
            if (isBinary) {
                this.emitClose(new RouterError("app_server_protocol_failed", "The app-server emitted an unexpected binary frame."));
                return;
            }
            try {
                this.emitMessage(JSON.parse(data.toString()));
            }
            catch (error) {
                this.emitClose(new RouterError("app_server_protocol_failed", "The app-server emitted invalid JSON.", { cause: error }));
            }
        });
        socket.on("close", () => {
            if (!this.closing) {
                this.emitClose(processError("The app-server proxy connection closed.", child, this.sshHost));
            }
        });
        child.once("exit", (code, signal) => {
            if (!this.closing)
                this.emitClose(processExitError("The app-server proxy", child, code, signal, this.sshHost));
        });
        await new Promise((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", (error) => reject(new RouterError("app_server_connect_failed", "Could not connect to the running Codex app-server.", { cause: error })));
        });
    }
    async send(message) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new RouterError("app_server_disconnected", "The app-server proxy is not connected.");
        }
        await new Promise((resolve, reject) => {
            socket.send(JSON.stringify(message), (error) => error ? reject(error) : resolve());
        });
    }
    async close() {
        this.closing = true;
        const socket = this.socket;
        if (socket && socket.readyState === WebSocket.OPEN)
            socket.close();
        else if (socket && socket.readyState !== WebSocket.CLOSED)
            socket.terminate();
        const child = this.child;
        if (child) {
            child.stdin.end();
            await waitForExit(child, 1_000);
        }
    }
}
//# sourceMappingURL=transport.js.map