import type { AgentConfig } from "./config.js";
import { DesktopSession } from "./desktop-session.js";
import { RouterError } from "./errors.js";
import { TurnSession, type AdmissionIntent } from "./turn-session.js";

export type ExecutionBackend = "desktop" | "proxy" | "stdio";
export interface ExecutionBinding {
  backend: ExecutionBackend;
  host: string;
  codexHome: string;
  threadId: string;
}
export type ExecutionSession = Pick<TurnSession,
  "resume" | "admit" | "observe" | "close" | "artifactBaseline" | "serverInfo" | "filesystem"> & {
  readonly backend?: ExecutionBackend;
  interrupt?(expectedTurnId: string): Promise<void>;
  readonly capabilities?: { readonly steer: boolean; readonly commentary?: { state: "available" | "unavailable"; reason?: string } };
  restore(turnId: string | undefined, intent: AdmissionIntent | undefined, artifactBaseline: readonly string[], clientUserMessageId?: string): Promise<string>;
};

export function executionBinding(agent: AgentConfig, session: ExecutionSession): ExecutionBinding {
  const codexHome = session.serverInfo.codexHome;
  if (!codexHome) throw new RouterError("app_server_protocol_failed", "The execution host did not identify its Codex home.");
  return { backend: session.backend ?? "stdio", host: agent.sshHost ?? "local", codexHome, threadId: agent.threadId };
}

export function verifyExecutionBinding(expected: ExecutionBinding, actual: ExecutionBinding): void {
  if (expected.host !== actual.host || expected.codexHome !== actual.codexHome || expected.threadId !== actual.threadId) {
    throw new RouterError("state_invalid", "The recovered session does not match the stored execution target.");
  }
  // Desktop recovery needs its persisted input boundary. Do not downgrade it to
  // the direct adapter, whose recovery contract does not implement that boundary.
  if (expected.backend === "desktop" && actual.backend !== "desktop") {
    throw new RouterError("thread_busy", "Waiting for the Desktop owner to recover admitted work.");
  }
}

interface SessionDiscovery {
  desktop(agent: AgentConfig, signal: AbortSignal): Promise<ExecutionSession | undefined>;
  direct(agent: AgentConfig, signal: AbortSignal): Promise<ExecutionSession>;
}
const discovery: SessionDiscovery = {
  desktop: (agent, signal) => DesktopSession.discover(agent, signal),
  direct: (agent, signal) => TurnSession.open(agent, undefined, signal),
};
export async function openExecutionSession(agent: AgentConfig, signal: AbortSignal, binding?: ExecutionBinding,
  operations: SessionDiscovery = discovery): Promise<ExecutionSession> {
  if (!agent.sshHost) {
    const desktop = await operations.desktop(agent, signal);
    if (desktop) return desktop;
    if (binding?.backend === "desktop") throw new RouterError("thread_busy", "Waiting for the Desktop owner to recover admitted work.");
  }
  return operations.direct(agent, signal);
}
