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
}

export interface RouterConfig {
  agents: AgentConfig[];
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function defaultConfigPath(): string {
  return resolve(homedir(), ".codex-router.toml");
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

    if (!ID_PATTERN.test(id)) {
      throw new RouterError("config_invalid", `${agentName} has an invalid id field.`);
    }
    if (!isAbsolute(cwd)) {
      throw new RouterError("config_invalid", `${agentName} has an invalid cwd field.`);
    }
    if (ids.has(id)) {
      throw new RouterError("config_invalid", `Agent id ${JSON.stringify(id)} is duplicated.`);
    }
    if (labels.has(label)) {
      throw new RouterError("config_invalid", `Agent label ${JSON.stringify(label)} is duplicated.`);
    }
    ids.add(id);
    labels.add(label);
    return { id, label, cwd, threadId, model, ...(reasoning === undefined ? {} : { reasoning }) };
  });

  return { agents };
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
