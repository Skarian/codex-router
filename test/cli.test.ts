import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = resolve("dist/src/cli.js");

async function configFile(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-test-"));
  const path = join(directory, "config.toml");
  await writeFile(path, source, "utf8");
  return path;
}

test("agents list --json emits the stable bare array", async () => {
  const path = await configFile(`[[agents]]\nid = "one"\nlabel = "One"\ncwd = "/tmp"\nthread_id = "019-test"\nmodel = "gpt-test"\nreasoning = "medium"\n`);
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, "--config", path, "agents", "list", "--json"]);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), [{ id: "one", label: "One" }]);
});

test("agents list does not inspect configured working directories", async () => {
  const path = await configFile(`[[agents]]\nid = "one"\nlabel = "One"\ncwd = "/definitely/missing"\nthread_id = "019-test"\nmodel = "gpt-test"\nreasoning = "medium"\n`);
  const { stdout } = await execFileAsync(process.execPath, [CLI, "--config", path, "agents", "list", "--json"]);
  assert.deepEqual(JSON.parse(stdout), [{ id: "one", label: "One" }]);
});

test("invalid command usage exits 2", async () => {
  const path = await configFile("");
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, "--config", path, "send"]),
    (error: unknown) => (error as { code?: number }).code === 2,
  );
});
