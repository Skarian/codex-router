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

function spawnCodex(args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
  // Codex writes diagnostics to stderr. Drain it so a full pipe cannot block
  // protocol progress; normal router output deliberately does not expose it.
  child.stderr.resume();
  return child;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams, code: "codex_unavailable" | "app_server_start_failed"): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new RouterError(code, "The Codex app-server process could not be started.", { cause: error })));
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
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
  readonly kind = "stdio" as const;
  private child?: ChildProcessWithoutNullStreams;
  private closing = false;

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
      if (!this.closing) this.emitClose(new Error(`Owned app-server exited (${code ?? signal ?? "unknown"}).`));
    });
  }

  async send(message: unknown): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) throw new RouterError("app_server_disconnected", "The owned app-server is not connected.");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    child.stdin.end();
    await waitForExit(child, 2_000);
  }
}

export class ProxyTransport extends BaseTransport {
  readonly kind = "proxy" as const;
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private closing = false;

  async start(): Promise<void> {
    const child = spawnCodex(["app-server", "proxy"]);
    this.child = child;
    await waitForSpawn(child, "codex_unavailable");
    const duplex = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const websocketOptions = {
      // Node's HTTP types require net.Socket here, while ws intentionally
      // accepts a generic Duplex and feature-detects socket-only methods.
      createConnection: () => duplex as unknown as import("node:net").Socket,
      closeTimeout: 500,
      perMessageDeflate: false,
      handshakeTimeout: 5_000,
      maxPayload: 4 * 1024 * 1024,
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
    socket.on("close", () => {
      if (!this.closing) this.emitClose(new Error("The app-server proxy connection closed."));
    });
    child.once("exit", (code, signal) => {
      if (!this.closing) this.emitClose(new Error(`The app-server proxy exited (${code ?? signal ?? "unknown"}).`));
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

  async close(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    else if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    const child = this.child;
    if (child) {
      child.stdin.end();
      await waitForExit(child, 1_000);
    }
  }
}
