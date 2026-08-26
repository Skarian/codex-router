import assert from "node:assert/strict";
import test from "node:test";
import { inspectRemoteAppServer } from "../src/doctor.js";
import type { AgentConfig } from "../src/config.js";

const REMOTE_AGENT: AgentConfig = {
  id: "remote",
  label: "Remote",
  sshHost: "server",
  cwd: "/work",
  threadId: "thread",
  model: "model",
};

test("remote doctor reports startup readiness without starting or connecting", async () => {
  const calls: string[] = [];
  const checks = await inspectRemoteAppServer(REMOTE_AGENT, {
    probe: async () => { calls.push("probe"); return "absent"; },
    daemonAvailable: async () => { calls.push("capability"); return true; },
    connectProxy: async () => { calls.push("connect"); throw new Error("must not connect"); },
  });
  assert.deepEqual(calls, ["probe", "capability"]);
  assert.equal(checks[0]?.ok, true);
  assert.match(checks[0]?.text ?? "", /first send will start it/);
  assert.deepEqual(checks[1], { name: "agent:remote:thread", ok: false, text: "Task was not checked." });
});
