import type { AgentConfig } from "./config.js";
import { RouterError } from "./errors.js";

export interface AgentSummary { id: string; label: string }

/** Discovery never exposes execution settings or private filesystem paths. */
export function listAgents(agents: readonly AgentConfig[]): AgentSummary[] {
  return agents.map(({ id, label }) => ({ id, label }));
}

export function getAgent(agents: readonly AgentConfig[], id: string): AgentConfig {
  const agent = agents.find(candidate => candidate.id === id);
  if (!agent) throw new RouterError("unknown_agent", `No configured agent has id ${JSON.stringify(id)}.`);
  return agent;
}
