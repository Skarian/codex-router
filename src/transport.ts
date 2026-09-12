import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import { createInterface } from "node:readline";
import WebSocket, { type ClientOptions } from "ws";
import { RouterError } from "./errors.js";

export type TransportKind = "proxy" | "stdio";
type MessageListener = (message: unknown) => void;
type CloseListener = (error?: Error) => void;

export interface MessageTransport {
  readonly kind: TransportKind;
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  onMessage(listener: MessageListener): () => void;
  onClose(listener: CloseListener): () => void;
  close(): Promise<void>;
}

export interface ProcessSpec {
  command: string;
  args: string[];
}

const STDERR_TAIL_BYTES = 16 * 1024;
const STDERR_DIAGNOSTIC_BYTES = 1_024;
const SHUTDOWN_TERM_GRACE_MS = 500;
const stderrTails = new WeakMap<ChildProcessWithoutNullStreams, string>();

export interface TransportShutdownTimings {
  eofGraceMs: number;
  termGraceMs: number;
}

function remoteCommand(args: string[]): string {
  return args.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(" ");
}

export function sshProcessSpec(sshHost: string, args: string[]): ProcessSpec {
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

abstract class BaseTransport implements MessageTransport {
  abstract readonly kind: TransportKind;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly closeListeners = new Set<CloseListener>();

  abstract start(): Promise<void>;
  abstract send(message: unknown): Promise<void>;
  abstract close(): Promise<void>;

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  protected emitMessage(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }

  protected emitClose(error?: Error): void {
    for (const listener of this.closeListeners) listener(error);
  }
}

export function codexProcessSpec(args: string[], sshHost?: string): ProcessSpec {
  return sshHost === undefined
    ? { command: "codex", args }
    : sshProcessSpec(sshHost, ["codex", ...args]);
}

function spawnCodex(args: string[], sshHost?: string): ChildProcessWithoutNullStreams {
  const spec = codexProcessSpec(args, sshHost);
  const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
  stderrTails.set(child, "");
  child.stderr.on("data", (chunk: Buffer | string) => {
    const next = `${stderrTails.get(child) ?? ""}${chunk.toString()}`;
    stderrTails.set(child, Buffer.byteLength(next, "utf8") <= STDERR_TAIL_BYTES
      ? next
      : Buffer.from(next).subarray(-STDERR_TAIL_BYTES).toString("utf8"));
  });
  return child;
}

export function boundedProcessDiagnostic(stderr: string): string | undefined {
  const clean = stderr.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const bytes = Buffer.from(clean);
  return bytes.length <= STDERR_DIAGNOSTIC_BYTES
    ? clean
    : bytes.subarray(bytes.length - STDERR_DIAGNOSTIC_BYTES).toString("utf8");
}

export function safeSshDiagnostic(stderr: string): string | undefined {
  const diagnostic = boundedProcessDiagnostic(stderr);
  if (!diagnostic) return undefined;
  return /^(ssh:|connection (?:closed|reset)|broken pipe|kex_exchange_identification:)/i.test(diagnostic)
    ? diagnostic
    : undefined;
}

function processError(message: string, child: ChildProcessWithoutNullStreams, sshHost?: string): Error {
  const diagnostic = boundedProcessDiagnostic(stderrTails.get(child) ?? "");
  const safeDiagnostic = sshHost === undefined ? undefined : safeSshDiagnostic(diagnostic ?? "");
  return new Error(`${message}${safeDiagnostic ? ` ${safeDiagnostic}` : ""}`, {
    cause: diagnostic === undefined ? undefined : new Error(diagnostic),
  });
}

function processExitError(label: string, child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null, sshHost?: string): Error {
  return processError(`${label} exited (${code ?? signal ?? "unknown"}).`, child, sshHost);
}

function waitForSpawn(child: ChildProcessWithoutNullStreams, code: "codex_unavailable" | "app_server_start_failed"): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new RouterError(code, "The Codex app-server process could not be started.", { cause: error })));
  });
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs?: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    if (hasExited(child)) {
      finish(true);
      return;
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
    }
  });
}

export async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  timings: TransportShutdownTimings,
): Promise<void> {
  if (await waitForChildExit(child, timings.eofGraceMs)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, timings.termGraceMs)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child);
}

export class StdioTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  private child?: ChildProcessWithoutNullStreams;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(private readonly shutdownTimings: TransportShutdownTimings = {
    eofGraceMs: 2_000,
    termGraceMs: SHUTDOWN_TERM_GRACE_MS,
  }) {
    super();
  }

  async start(): Promise<void> {
    const child = spawnCodex(["app-server", "--listen", "stdio://"]);
    this.child = child;
    await waitForSpawn(child, "app_server_start_failed");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        this.emitMessage(JSON.parse(line));
      } catch (error) {
        this.emitClose(new RouterError("app_server_protocol_failed", "The owned app-server emitted invalid JSON.", { cause: error }));
      }
    });
    child.once("exit", (code, signal) => {
      if (!this.closing) this.emitClose(processExitError("Owned app-server", child, code, signal));
    });
  }

  async send(message: unknown): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) throw new RouterError("app_server_disconnected", "The owned app-server is not connected.");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    child.stdin.end();
    await terminateChild(child, this.shutdownTimings);
  }
}

export class ProxyTransport extends BaseTransport {
  readonly kind = "proxy" as const;
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly sshHost?: string,
    private readonly shutdownTimings: TransportShutdownTimings = {
      eofGraceMs: 1_000,
      termGraceMs: SHUTDOWN_TERM_GRACE_MS,
    },
  ) {
    super();
  }

  async start(): Promise<void> {
    const child = spawnCodex(["app-server", "proxy"], this.sshHost);
    this.child = child;
    await waitForSpawn(child, "codex_unavailable");
    const duplex = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const websocketOptions = {
      // Node's HTTP types require net.Socket here, while ws intentionally
      // accepts a generic Duplex and feature-detects socket-only methods.
      createConnection: () => duplex as unknown as import("node:net").Socket,
      closeTimeout: 500,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
      maxPayload: 100 * 1024 * 1024,
    } as unknown as ClientOptions;
    const socket = new WebSocket("ws://localhost/rpc", websocketOptions);
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.emitClose(new RouterError("app_server_protocol_failed", "The app-server emitted an unexpected binary frame."));
        return;
      }
      try {
        this.emitMessage(JSON.parse(data.toString()));
      } catch (error) {
        this.emitClose(new RouterError("app_server_protocol_failed", "The app-server emitted invalid JSON.", { cause: error }));
      }
    });
    socket.on("error", (error: Error & { code?: string }) => {
      if (error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
        this.emitClose(new RouterError("output_too_large", "The app-server output exceeds the 100 MiB envelope."));
      } else if (!this.closing) this.emitClose(error);
    });
    socket.on("close", () => {
      if (!this.closing) {
        this.emitClose(processError("The app-server proxy connection closed.", child, this.sshHost));
      }
    });
    child.once("exit", (code, signal) => {
      if (!this.closing) this.emitClose(processExitError("The app-server proxy", child, code, signal, this.sshHost));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", (error) => reject(new RouterError("app_server_connect_failed", "Could not connect to the running Codex app-server.", { cause: error })));
    });
  }

  async send(message: unknown): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new RouterError("app_server_disconnected", "The app-server proxy is not connected.");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) => error ? reject(error) : resolve());
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    else if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    const child = this.child;
    if (child) {
      child.stdin.end();
      await terminateChild(child, this.shutdownTimings);
    }
  }
}
