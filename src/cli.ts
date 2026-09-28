#!/usr/bin/env node
import { getAgent, listAgents } from "./agent-catalog.js";
import { readGatewayStatus } from "./gateway-diagnostics.js";
import { resolve } from "node:path";
import { defaultConfigPath, loadConfig } from "./config.js";
import type { RouterConfig } from "./config.js";
import { runGateway } from "./gateway-server.js";
import { runDoctor } from "./doctor.js";
import { failedMessage, asRouterError, RouterError } from "./errors.js";
import { cancelTurn, sendTurn } from "./execution-commands.js";
import { runtimeBindings } from "./gateway-adapters.js";
import { GatewayStore, bindTargets, unresolved, resolveEffect } from "./gateway-state.js";
import type { SemanticMessage } from "./turn-state.js";

interface ParsedArgs {
  configPath: string;
  command: string[];
  json: boolean;
  stream: boolean;
  stdin: boolean;
}

let stdoutClosed = false;
let activeAbortController: AbortController | undefined;

function handleStdoutError(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") throw error;
  stdoutClosed = true;
  process.exitCode = 0;
  activeAbortController?.abort();
}

process.stdout.on("error", handleStdoutError);

function usage(): string {
  return [
    "Usage:",
    "  codex-router [--config PATH] agents list [--json]",
    "  codex-router [--config PATH] doctor [--json]",
    "  codex-router [--config PATH] send AGENT_ID --stdin [--json | --stream]",
    "  codex-router [--config PATH] cancel AGENT_ID [--json]",
    "  codex-router [--config PATH] gateway",
    "  codex-router [--config PATH] gateway status [--json]",
    "  codex-router [--config PATH] gateway polling-reset ACCOUNT_ID SINCE_UTC [--json]",
    "  codex-router [--config PATH] gateway resolve AGENT_ID EFFECT_ID failed [--json]",
    "  codex-router [--config PATH] gateway resolve AGENT_ID EFFECT_ID accepted HANDLE [--json]",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  let configPath = defaultConfigPath();
  let json = false;
  let stream = false;
  let stdin = false;
  const command: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[++index];
      if (!value) throw new RouterError("input_invalid", "--config requires a path.");
      configPath = resolve(value);
    } else if (arg === "--json") json = true;
    else if (arg === "--stream") stream = true;
    else if (arg === "--stdin") stdin = true;
    else if (arg?.startsWith("-")) throw new RouterError("input_invalid", `Unknown option ${arg}.`);
    else if (arg) command.push(arg);
  }
  if (json && stream) throw new RouterError("input_invalid", "--json and --stream are mutually exclusive.");
  return { configPath, command, json, stream, stdin };
}

function printJson(value: unknown): void {
  writeStdout(`${JSON.stringify(value)}\n`);
}

function writeStdout(text: string): void {
  if (stdoutClosed) return;
  try {
    process.stdout.write(text);
  } catch (error) {
    handleStdoutError(error as NodeJS.ErrnoException);
  }
}

function formatAgentTable(config: RouterConfig): string {
  const rows = [["ID", "LABEL"], ...listAgents(config.agents).map(({ id, label }) => [id, label])];
  const width = Math.max(...rows.map(([id]) => id?.length ?? 0));
  return rows.map(([id, label]) => `${id?.padEnd(width)}  ${label}`).join("\n");
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (text.length === 0) throw new RouterError("input_invalid", "No transcript text was provided on stdin.");
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    throw new RouterError("input_invalid", "Transcript text exceeds the 64 KiB input limit.");
  }
  return text;
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${asRouterError(error).message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  const [first, second, third] = parsed.command;
  try {
    const config = await loadConfig(parsed.configPath);
    if (first === "gateway" && second === undefined && !parsed.stdin && !parsed.stream && !parsed.json) {
      if (!config.gateway) throw new RouterError("config_invalid", "The gateway configuration is missing.");
      const abort = new AbortController();
      activeAbortController = abort;
      const stop = () => abort.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try { await runGateway(config.gateway, abort.signal); }
      finally {
        process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
        activeAbortController = undefined;
      }
      return;
    }
    if (first === "gateway" && second === "polling-reset" && !parsed.stdin && !parsed.stream) {
      const [, , accountId, since, extra] = parsed.command;
      const time = since ? Date.parse(since) : NaN;
      const account = config.gateway?.sendblue.find(account => account.id === accountId && account.mode !== "webhook");
      if (!account || !config.gateway || !since || extra !== undefined || !Number.isSafeInteger(time)
        || new Date(time).toISOString() !== since || time > Date.now() || time < Date.now() - 29 * 86400000) {
        throw new RouterError("input_invalid", "Use a polling account and a UTC timestamp within the last 29 days, for example 2026-09-27T00:00:00.000Z.");
      }
      const store = await GatewayStore.open(config.gateway.stateDir);
      try {
        await store.transaction(state => {
          bindTargets(state, runtimeBindings(config.gateway!));
          (state.polling ??= {})[accountId!] = { activationAtMs: time, completedThroughMs: time,
            routeActivationAtMs: Object.fromEntries(account.conversations.map(conversation => [conversation.id, time])) };
        });
        if (parsed.json) printJson({ account: accountId, pollingFrom: since });
        else writeStdout(`Polling for ${accountId} will resume from ${since}. Existing message receipts were retained.\n`);
      } finally { await store.close(); }
      return;
    }
    if (first === "gateway" && (second === "status" || second === "resolve") && !parsed.stdin && !parsed.stream) {
      const [, , routeId, effectId, resolution, handle, extra] = parsed.command;
      if ((second === "status" && third !== undefined) || (second === "resolve" &&
        (!routeId || !effectId || extra !== undefined || (resolution !== "failed" && resolution !== "accepted")
          || (resolution === "failed" && handle !== undefined) || (resolution === "accepted" && !handle)))) {
        throw new RouterError("input_invalid", "Invalid gateway command usage.");
      }
      if (!config.gateway) throw new RouterError("config_invalid", "The gateway configuration is missing.");
      if (second === "status") {
        const status = await readGatewayStatus(config.gateway.stateDir);
        if (parsed.json) printJson(status);
        else {
          writeStdout(`Gateway status: ${status.runtime.state}.\n`);
          if (status.runtime.polling) for (const poll of status.runtime.polling) writeStdout(`${poll.accountId}: ${poll.state}${poll.code ? ` (${poll.code})` : ""}\n`);
          if (status.runtime.agents) for (const route of status.runtime.agents) writeStdout(`${route.agentId}: ${route.state}${route.code ? ` (${route.code})` : ""}\n`);
          if (status.runtime.deliveries) for (const delivery of status.runtime.deliveries) writeStdout(`${delivery.agentId}: delivery ${delivery.state} (${delivery.destinationId})\n`);
          for (const effect of status.unresolved) writeStdout(`${effect.agentId}  ${effect.kind}  ${effect.effectId}\n`);
        }
        if (["unavailable", "stale"].includes(status.runtime.state)) process.exitCode = 1;
        return;
      }
      const store = await GatewayStore.open(config.gateway.stateDir);
      try {
        bindTargets(store.snapshot(), runtimeBindings(config.gateway));
          const result = await store.transaction((state) => resolveEffect(state, routeId!, effectId!, resolution as "accepted" | "failed", handle));
          if (parsed.json) printJson(result);
          else writeStdout(`Resolved ${effectId} as ${resolution}.\n`);
      } finally { await store.close(); }
      return;
    }
    if (first === "agents" && second === "list" && third === undefined && !parsed.stdin && !parsed.stream) {
      if (parsed.json) printJson(listAgents(config.agents));
      else writeStdout(`${formatAgentTable(config)}\n`);
      return;
    }
    if (first === "doctor" && second === undefined && !parsed.stdin && !parsed.stream) {
      const checks = await runDoctor(config);
      const ok = checks.every((check) => check.ok);
      if (parsed.json) printJson({ ok, checks });
      else for (const check of checks) writeStdout(`${check.ok ? "OK" : "FAIL"}  ${check.name}  ${check.text}\n`);
      if (!ok) process.exitCode = 1;
      return;
    }
    if (first === "send" && second && third === undefined && parsed.stdin) {
      const agent = getAgent(config.agents, second);
      const text = await readStdin();
      const abortController = new AbortController();
      activeAbortController = abortController;
      const onSignal = () => {
        process.exitCode = 1;
        abortController.abort();
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const emit = (message: SemanticMessage) => {
          if (parsed.stream && message.type !== "completed") printJson(message);
        };
        const { result } = await sendTurn(agent, text, emit, abortController.signal);
        if (parsed.json || parsed.stream) printJson(result);
        else writeStdout(`${result.text}\n`);
      } finally {
        if (activeAbortController === abortController) activeAbortController = undefined;
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
      return;
    }
    if (first === "cancel" && second && third === undefined && !parsed.stdin && !parsed.stream) {
      const agent = getAgent(config.agents, second);
      const result = await cancelTurn(agent);
      if (parsed.json) printJson(result);
      else if (result.type === "interrupt_requested") writeStdout(`Interrupt requested for ${agent.label}.\n`);
      else writeStdout(`${agent.label} is already idle.\n`);
      return;
    }
    throw new RouterError("input_invalid", "Invalid command usage.");
  } catch (error) {
    if (stdoutClosed) {
      process.exitCode = 0;
      return;
    }
    const failure = asRouterError(error);
    if (parsed.json || parsed.stream) printJson(failedMessage(failure));
    else process.stderr.write(`${failure.message}\n`);
    process.exitCode = failure.code === "input_invalid" ? 2 : 1;
    if (failure.code === "input_invalid") process.stderr.write(`${usage()}\n`);
  }
}

await main();
