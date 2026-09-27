import { sendblueCredentials } from "./sendblue.js";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentConfig, RouterConfig } from "./config.js";
import {
  connectAppServer,
  connectExistingRemoteProxy,
  remoteControlSocketState,
  remoteDaemonAvailable,
  type AppServerConnection,
} from "./app-server.js";
import { codexProcessSpec, sshProcessSpec } from "./transport.js";

const execFileAsync = promisify(execFile);
const REMOTE_COMMAND_TIMEOUT_MS = 15_000;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  text: string;
}

export interface RemoteDoctorOperations {
  probe(): Promise<"absent" | "socket">;
  daemonAvailable(): Promise<boolean>;
  connectProxy(): Promise<AppServerConnection>;
}

export async function inspectRemoteAppServer(agent: AgentConfig, operations: RemoteDoctorOperations): Promise<DoctorCheck[]> {
  const state = await operations.probe();
  if (state === "absent") {
    const daemonAvailable = await operations.daemonAvailable();
    return [
      {
        name: `agent:${agent.id}:app-server`,
        ok: daemonAvailable,
        text: daemonAvailable
          ? "Persistent app-server is not running; the first send will start it."
          : "Persistent app-server is not running, and this Codex installation does not support durable daemon startup.",
      },
      { name: `agent:${agent.id}:thread`, ok: false, text: "Task was not checked." },
    ];
  }

  let connection: AppServerConnection | undefined;
  try {
    connection = await operations.connectProxy();
    const checks: DoctorCheck[] = [{
      name: `agent:${agent.id}:app-server`,
      ok: true,
      text: "Persistent app-server initialized over SSH proxy.",
    }];
    try {
      await connection.client.request("thread/read", { threadId: agent.threadId, includeTurns: false });
      checks.push({ name: `agent:${agent.id}:thread`, ok: true, text: "Task exists." });
    } catch {
      checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task is unavailable." });
    }
    return checks;
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

export async function checkAgentDirectory(agent: AgentConfig): Promise<DoctorCheck> {
  if (agent.sshHost !== undefined) {
    try {
      const spec = sshProcessSpec(agent.sshHost, ["test", "-d", agent.cwd]);
      await execFileAsync(spec.command, spec.args, { timeout: REMOTE_COMMAND_TIMEOUT_MS });
      return { name: `agent:${agent.id}:cwd`, ok: true, text: "Working directory is accessible." };
    } catch {
      return { name: `agent:${agent.id}:cwd`, ok: false, text: "Working directory is not accessible." };
    }
  }
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
  if (config.gateway) {
    checks.push({ name: "gateway:config", ok: true, text: "Gateway routes and connector references are valid." });
    for (const account of config.gateway.sendblue) {
      let present = true;
      try { sendblueCredentials(account); } catch { present = false; }
      checks.push({ name: `gateway:${account.id}:credentials`, ok: present,
        text: present ? "Gateway credentials are present. Credentials were not tested." : "One or more gateway credentials are missing or invalid." });
    }
  }
  const localAgents = config.agents.filter(({ sshHost }) => sshHost === undefined);
  const remoteAgents = config.agents.filter(({ sshHost }) => sshHost !== undefined);
  if (localAgents.length > 0 || config.agents.length === 0) {
    try {
      const spec = codexProcessSpec(["--version"]);
      const { stdout } = await execFileAsync(spec.command, spec.args, { timeout: 5_000 });
      checks.push({ name: "codex", ok: true, text: stdout.trim() || "Codex executable is available." });
    } catch {
      checks.push({ name: "codex", ok: false, text: "Codex executable is unavailable." });
    }
  }
  checks.push(...await Promise.all(config.agents.map(checkAgentDirectory)));

  for (const agent of remoteAgents) {
    try {
      const spec = codexProcessSpec(["--version"], agent.sshHost);
      const { stdout } = await execFileAsync(spec.command, spec.args, { timeout: REMOTE_COMMAND_TIMEOUT_MS });
      checks.push({ name: `agent:${agent.id}:codex`, ok: true, text: stdout.trim() || "Codex executable is available." });
    } catch {
      checks.push({ name: `agent:${agent.id}:codex`, ok: false, text: "Codex executable is unavailable." });
    }
  }

  if (localAgents.length > 0 || config.agents.length === 0) {
    let connection: Awaited<ReturnType<typeof connectAppServer>> | undefined;
    try {
      connection = await connectAppServer();
      checks.push({ name: "app-server", ok: true, text: `App-server initialized over ${connection.transportKind}.` });
      for (const agent of localAgents) {
        try {
          await connection.client.request("thread/read", { threadId: agent.threadId, includeTurns: false });
          checks.push({ name: `agent:${agent.id}:thread`, ok: true, text: "Task exists." });
        } catch {
          checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task is unavailable." });
        }
      }
    } catch {
      checks.push({ name: "app-server", ok: false, text: "App-server is unavailable." });
      for (const agent of localAgents) {
        checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task was not checked." });
      }
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  for (const agent of remoteAgents) {
    try {
      checks.push(...await inspectRemoteAppServer(agent, {
        probe: () => remoteControlSocketState(agent.sshHost!),
        daemonAvailable: () => remoteDaemonAvailable(agent.sshHost!),
        connectProxy: () => connectExistingRemoteProxy(agent.sshHost!),
      }));
    } catch {
      checks.push({ name: `agent:${agent.id}:app-server`, ok: false, text: "App-server is unavailable over SSH." });
      checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task was not checked." });
    }
  }
  return checks;
}
