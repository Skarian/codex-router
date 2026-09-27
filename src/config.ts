import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";
import { RouterError } from "./errors.js";

export interface AgentConfig {
  id: string;
  label: string;
  cwd: string;
  threadId: string;
  model: string;
  reasoning?: string;
  sshHost?: string;
}

export interface RouterConfig {
  agents: AgentConfig[];
  gateway?: GatewayConfig;
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function defaultConfigPath(): string {
  return resolve(homedir(), ".codex-router/config.toml");
}

function requiredString(record: Record<string, unknown>, field: string, agentName: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RouterError("config_invalid", `${agentName} has an invalid ${field} field.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string, agentName: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new RouterError("config_invalid", `${agentName} has an invalid ${field} field.`);
  }
  return value;
}

export function parseConfig(source: string): RouterConfig {
  let document: Record<string, unknown>;
  try {
    document = parse(source) as Record<string, unknown>;
  } catch (error) {
    throw new RouterError("config_invalid", "The router configuration is not valid TOML.", { cause: error });
  }

  const rawAgents = document.agents ?? [];
  if (!Array.isArray(rawAgents)) {
    throw new RouterError("config_invalid", "The router configuration must contain an agents array.");
  }

  const ids = new Set<string>();
  const labels = new Set<string>();
  const threads = new Set<string>();
  const agents = rawAgents.map((value, index): AgentConfig => {
    const agentName = `Agent ${index + 1}`;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RouterError("config_invalid", `${agentName} must be a TOML table.`);
    }
    const record = value as Record<string, unknown>;
    const id = requiredString(record, "id", agentName);
    const label = requiredString(record, "label", agentName);
    const cwd = requiredString(record, "cwd", agentName);
    const threadId = requiredString(record, "thread_id", agentName);
    const model = requiredString(record, "model", agentName);
    const reasoning = optionalString(record, "reasoning", agentName);
    const sshHost = optionalString(record, "ssh_host", agentName);

    if (!ID_PATTERN.test(id)) {
      throw new RouterError("config_invalid", `${agentName} has an invalid id field.`);
    }
    if (!isAbsolute(cwd)) {
      throw new RouterError("config_invalid", `${agentName} has an invalid cwd field.`);
    }
    if (sshHost?.startsWith("-") || /\s/u.test(sshHost ?? "")) {
      throw new RouterError("config_invalid", `${agentName} has an invalid ssh_host field.`);
    }
    if (ids.has(id)) {
      throw new RouterError("config_invalid", `Agent id ${JSON.stringify(id)} is duplicated.`);
    }
    if (labels.has(label)) {
      throw new RouterError("config_invalid", `Agent label ${JSON.stringify(label)} is duplicated.`);
    }
    if (threads.has(threadId)) throw new RouterError("config_invalid", "An agent thread_id is duplicated.");
    threads.add(threadId);
    ids.add(id);
    labels.add(label);
    return {
      id,
      label,
      cwd,
      threadId,
      model,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(sshHost === undefined ? {} : { sshHost }),
    };
  });

  return { agents, ...(document.gateway === undefined ? {} : { gateway: parseGateway(document.gateway, agents) }) };
}

export async function loadConfig(path: string): Promise<RouterConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new RouterError("config_invalid", "The router configuration could not be read.", { cause: error });
  }
  return parseConfig(source);
}

export function findAgent(config: RouterConfig, id: string): AgentConfig {
  const agent = config.agents.find((candidate) => candidate.id === id);
  if (!agent) throw new RouterError("unknown_agent", `No configured agent has id ${JSON.stringify(id)}.`);
  return agent;
}

export interface SendblueConfig {
  id: string;
  apiKeyId?: string | undefined;
  apiSecretKey?: string | undefined;
  webhookSecret?: string | undefined;
  apiKeyIdEnv?: string | undefined;
  apiSecretKeyEnv?: string | undefined;
  webhookSecretEnv?: string | undefined;
}

export interface GatewayRoute {
  id: string;
  sendblueId: string;
  sender: string;
  sendblueNumber: string;
  agent: AgentConfig;
}

export interface GatewayConfig {
  listenPort: number;
  publicUrl: string;
  stateDir: string;
  sendblue: SendblueConfig[];
  routes: GatewayRoute[];
}

function parseGateway(value: unknown, agents: AgentConfig[]): GatewayConfig {
  const invalid = (): never => { throw new RouterError("config_invalid", "The gateway configuration is invalid."); };
  const table = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
    return raw as Record<string, unknown>;
  };
  const fields = (record: Record<string, unknown>, allowed: string[]) => {
    if (Object.keys(record).some((key) => !allowed.includes(key))) invalid();
  };
  const entries = (raw: unknown): Record<string, unknown>[] => {
    if (!Array.isArray(raw) || !raw.length) return invalid();
    return raw.map(table);
  };
  const id = (record: Record<string, unknown>, key: string): string => {
    const value = requiredString(record, key, "Gateway");
    if (!ID_PATTERN.test(value)) invalid();
    return value;
  };
  const env = (record: Record<string, unknown>, key: string): string => {
    const value = requiredString(record, key, "Gateway");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) invalid();
    return value;
  };
  const phone = (record: Record<string, unknown>, key: string): string => {
    const value = requiredString(record, key, "Gateway");
    if (!/^\+[1-9][0-9]{6,14}$/.test(value)) invalid();
    return value;
  };
  const record = table(value);
  fields(record, ["listen_port", "public_url", "state_dir", "sendblue", "routes"]);
  if (!Number.isInteger(record.listen_port) || Number(record.listen_port) < 1 || Number(record.listen_port) > 65535) invalid();
  const publicUrl = requiredString(record, "public_url", "Gateway");
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) invalid();
  } catch { invalid(); }
  const stateDir = optionalString(record, "state_dir", "Gateway") ?? resolve(homedir(), ".codex-router/gateway");
  if (!isAbsolute(stateDir)) invalid();
  const accounts = new Set<string>();
  const sendblue = entries(record.sendblue).map((entry) => {
    fields(entry, ["id", "api_key_id", "api_secret_key", "webhook_secret", "api_key_id_env", "api_secret_key_env", "webhook_secret_env"]);
    for (const key of ["api_key_id", "api_secret_key", "webhook_secret"]) {
      if ((entry[key] !== undefined) === (entry[`${key}_env`] !== undefined)) invalid();
      if (entry[key] !== undefined && /[\r\n]/.test(requiredString(entry, key, "Gateway"))) invalid();
    }
    const accountId = id(entry, "id");
    if (accounts.has(accountId)) invalid();
    accounts.add(accountId);
    return { id: accountId,
      apiKeyId: entry.api_key_id as string | undefined,
      apiSecretKey: entry.api_secret_key as string | undefined,
      webhookSecret: entry.webhook_secret as string | undefined,
      apiKeyIdEnv: entry.api_key_id_env === undefined ? undefined : env(entry, "api_key_id_env"),
      apiSecretKeyEnv: entry.api_secret_key_env === undefined ? undefined : env(entry, "api_secret_key_env"),
      webhookSecretEnv: entry.webhook_secret_env === undefined ? undefined : env(entry, "webhook_secret_env"),
    };
  });
  const routeIds = new Set<string>();
  const conversations = new Set<string>();
  const targets = new Set<string>();
  const routes = entries(record.routes).map((entry) => {
    fields(entry, ["id", "sendblue", "sender", "sendblue_number", "agent"]);
    const routeId = id(entry, "id");
    const sendblueId = id(entry, "sendblue");
    const agent = agents.find((agent) => agent.id === entry.agent);
    if (!agent || !accounts.has(sendblueId) || routeIds.has(routeId) || targets.has(agent.id)) return invalid();
    const sender = phone(entry, "sender");
    const sendblueNumber = phone(entry, "sendblue_number");
    const conversation = JSON.stringify([sendblueId, sender, sendblueNumber]);
    if (conversations.has(conversation)) invalid();
    conversations.add(conversation); targets.add(agent.id); routeIds.add(routeId);
    return { id: routeId, sendblueId, sender, sendblueNumber, agent };
  });
  return { listenPort: Number(record.listen_port), publicUrl: new URL(publicUrl).origin, stateDir, sendblue, routes };
}
