import assert from "node:assert/strict";
import test from "node:test";
import { getAgent, listAgents } from "../src/agent-catalog.js";
import type { AgentConfig } from "../src/config.js";
import { RouterError } from "../src/errors.js";

test("catalog discovery exposes only public labels and preserves configured order", () => {
  const agents: AgentConfig[] = [
    { id: "remote", label: "Remote", cwd: "/private/work", threadId: "private-chat", model: "configured", sshHost: "private-host" },
    { id: "local", label: "Local", cwd: "/private/other", threadId: "another-chat", model: "configured" },
  ];
  const listed = listAgents(agents);
  assert.deepEqual(listed, [{ id: "remote", label: "Remote" }, { id: "local", label: "Local" }]);
  listed[0]!.label = "edited";
  assert.equal(getAgent(agents, "remote").label, "Remote");
  assert.throws(() => getAgent(agents, "missing"), error => error instanceof RouterError && error.code === "unknown_agent");
  assert.deepEqual(listAgents([]), []);
});
