import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentConfig, RouterConfig } from "./config.js";
import { RouterError } from "./errors.js";
import { connectAppServer } from "./app-server.js";
import type { JsonRpcClient } from "./json-rpc.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

export interface SemanticMessage {
  type: "reasoning" | "commentary" | "completed";
  text: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  text: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bounded(text: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
    throw new RouterError("output_too_large", "Codex produced a message too large for the router output contract.");
  }
  return text;
}

export function listAgents(config: RouterConfig): Array<{ id: string; label: string }> {
  return config.agents.map(({ id, label }) => ({ id, label }));
}

export function formatAgentTable(config: RouterConfig): string {
  const rows = [["ID", "LABEL"], ...config.agents.map(({ id, label }) => [id, label])];
  const width = Math.max(...rows.map(([id]) => id?.length ?? 0));
  return rows.map(([id, label]) => `${id?.padEnd(width)}  ${label}`).join("\n");
}

async function checkDirectory(agent: AgentConfig): Promise<DoctorCheck> {
  try {
    const info = await stat(agent.cwd);
    return info.isDirectory()
      ? { name: `agent:${agent.id}:cwd`, ok: true, text: "Working directory is accessible." }
      : { name: `agent:${agent.id}:cwd`, ok: false, text: "Working directory is not a directory." };
  } catch {
    return { name: `agent:${agent.id}:cwd`, ok: false, text: "Working directory is not accessible." };
  }
}

export async function runDoctor(config: RouterConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [{ name: "config", ok: true, text: "Configuration is valid." }];
  try {
    const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 5_000 });
    checks.push({ name: "codex", ok: true, text: stdout.trim() || "Codex executable is available." });
  } catch {
    checks.push({ name: "codex", ok: false, text: "Codex executable is unavailable." });
  }
  checks.push(...await Promise.all(config.agents.map(checkDirectory)));

  let connection: Awaited<ReturnType<typeof connectAppServer>> | undefined;
  try {
    connection = await connectAppServer();
    checks.push({ name: "app-server", ok: true, text: `App-server initialized over ${connection.transportKind}.` });
    for (const agent of config.agents) {
      try {
        await connection.client.request("thread/read", { threadId: agent.threadId, includeTurns: false });
        checks.push({ name: `agent:${agent.id}:thread`, ok: true, text: "Task exists." });
      } catch {
        checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task is unavailable." });
      }
    }
  } catch {
    checks.push({ name: "app-server", ok: false, text: "App-server is unavailable." });
    for (const agent of config.agents) {
      checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task was not checked." });
    }
  } finally {
    await connection?.close().catch(() => undefined);
  }
  return checks;
}

export function waitForTurn(
  client: JsonRpcClient,
  threadId: string,
  turnId: string,
  emit: (message: SemanticMessage) => void,
  signal?: AbortSignal,
  initialNotifications: ReadonlyArray<{ method: string; params: unknown }> = [],
): Promise<SemanticMessage> {
  let finalText: string | undefined;
  const timeoutMs = Number.parseInt(process.env.CODEX_ROUTER_TURN_TIMEOUT_MS ?? "", 10) || DEFAULT_TURN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new RouterError("timeout", "The Codex turn did not finish before the router timeout.", { ambiguous: true }));
    }, timeoutMs);
    timer.unref();
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      unsubscribe();
      unsubscribeClose();
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new RouterError("interrupted", "The Codex turn was interrupted by the caller.", { ambiguous: true })));
    const unsubscribeClose = client.onClose((error) => finish(() => reject(error)));
    const handleNotification = (method: string, rawParams: unknown) => {
      try {
        const params = object(rawParams);
        if (!params || params.threadId !== threadId) return;
        if (method === "item/completed" && params.turnId === turnId) {
          const item = object(params.item);
          if (!item) return;
          if (item.type === "reasoning" && Array.isArray(item.summary)) {
            const text = bounded(item.summary.filter((part): part is string => typeof part === "string").join("\n\n"));
            if (text) emit({ type: "reasoning", text });
          }
          if (item.type === "agentMessage" && typeof item.text === "string") {
            if (item.phase === "commentary") emit({ type: "commentary", text: bounded(item.text) });
            if (item.phase === "final_answer") finalText = bounded(item.text);
          }
          return;
        }
        if (method !== "turn/completed") return;
        const turn = object(params.turn);
        if (!turn || turn.id !== turnId) return;
        if (turn.status === "completed" && finalText !== undefined) {
          const result: SemanticMessage = { type: "completed", text: finalText };
          finish(() => resolve(result));
        } else if (turn.status === "interrupted") {
          finish(() => reject(new RouterError("interrupted", "The Codex turn was interrupted.")));
        } else {
          finish(() => reject(new RouterError("turn_failed", "The Codex turn failed before producing a final response.")));
        }
      } catch (error) {
        finish(() => reject(error instanceof RouterError
          ? error
          : new RouterError("app_server_protocol_failed", "Codex app-server emitted an invalid turn event.", { cause: error })));
      }
    };
    const unsubscribe = client.onNotification(handleNotification);
    for (const notification of initialNotifications) handleNotification(notification.method, notification.params);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function sendTurn(
  agent: AgentConfig,
  text: string,
  emit: (message: SemanticMessage) => void,
  signal?: AbortSignal,
): Promise<{ result: SemanticMessage; transportKind: "proxy" | "stdio" }> {
  const directory = await checkDirectory(agent);
  if (!directory.ok) throw new RouterError("working_directory_invalid", `${agent.label}'s working directory is unavailable.`);
  const connection = await connectAppServer();
  try {
    let resumeResult: unknown;
    try {
      resumeResult = await connection.client.request("thread/resume", { threadId: agent.threadId });
    } catch (error) {
      throw new RouterError("thread_unavailable", `${agent.label}'s Codex task could not be resumed.`, { cause: error });
    }
    const thread = object(object(resumeResult)?.thread);
    const status = object(thread?.status);
    if (status?.type === "active") {
      throw new RouterError("agent_busy", `${agent.label} is already working. Try again after the current turn finishes.`);
    }

    connection.client.markTurnAccepted();
    const buffered: Array<{ method: string; params: unknown }> = [];
    const stopBuffering = connection.client.onNotification((method, params) => {
      if (buffered.length === 64) buffered.shift();
      buffered.push({ method, params });
    });
    const started = await connection.client.request("turn/start", {
      threadId: agent.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd: agent.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: agent.model,
      ...(agent.reasoning === undefined ? {} : { effort: agent.reasoning }),
      summary: "auto",
    });
    const turn = object(object(started)?.turn);
    if (typeof turn?.id !== "string") {
      throw new RouterError("app_server_protocol_failed", "Codex app-server returned an invalid turn/start response.");
    }
    const resultPromise = waitForTurn(connection.client, agent.threadId, turn.id, emit, signal, buffered);
    stopBuffering();
    const result = await resultPromise;
    return { result, transportKind: connection.transportKind };
  } finally {
    await connection.close().catch(() => undefined);
  }
}
