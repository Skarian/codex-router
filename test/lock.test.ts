import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RouterError } from "../src/errors.js";
import { acquireAgentLock } from "../src/lock.js";

test("acquireAgentLock rejects a concurrent invocation and releases cleanly", async () => {
  const originalHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), "codex-router-home-"));
  try {
    const first = await acquireAgentLock("/tmp/config", "agent");
    await assert.rejects(
      acquireAgentLock("/tmp/config", "agent"),
      (error: unknown) => error instanceof RouterError && error.code === "agent_busy",
    );
    await first.release();
    const second = await acquireAgentLock("/tmp/config", "agent");
    await second.release();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
