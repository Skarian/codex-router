import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("cancel rejects stdin and stream modes before connecting", async () => {
  const path = await configFile(`[[agents]]\nid = "one"\nlabel = "One"\ncwd = "/tmp"\nthread_id = "019-test"\nmodel = "gpt-test"\n`);
  for (const flag of ["--stdin", "--stream"]) {
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, "--config", path, "cancel", "one", flag]),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        return failure.code === 2 && failure.stderr?.includes("cancel AGENT_ID [--json]") === true;
      },
    );
  }
});

test("closed stdout exits cleanly without an EPIPE stack", async () => {
  const path = await configFile(`[[agents]]\nid = "one"\nlabel = "One"\ncwd = "/tmp"\nthread_id = "019-test"\nmodel = "gpt-test"\n`);
  const child = spawn(process.execPath, [CLI, "--config", path, "agents", "list", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.destroy();
  const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once("exit", (...args) => resolve(args)));
  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'/);
});

test("stream EPIPE aborts observation, reaps owned app-server, and never resends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-epipe-"));
  const fakeCodex = join(directory, "codex");
  const pidPath = join(directory, "child.pid");
  const startsPath = join(directory, "starts.txt");
  const home = join(directory, "codex-home");
  await mkdir(home);
  await writeFile(fakeCodex, `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
process.on("SIGTERM", () => {});
let buffer = "";
let resumes = 0;
let clientId = null;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (typeof message.id !== "number") continue;
    if (message.method === "initialize") send({ id: message.id, result: {} });
    else if (message.method === "thread/resume") {
      resumes += 1;
      if (resumes === 1) send({ id: message.id, result: { thread: { status: { type: "idle" }, turns: [] } } });
      else {
        send({ id: message.id, result: { thread: { status: { type: "active" }, turns: [{ id: "turn", status: "inProgress", items: [{ id: "user", type: "userMessage", clientId }] }] } } });
        setTimeout(() => send({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "one", type: "agentMessage", phase: "commentary", text: "first" } } }), 10);
        setTimeout(() => send({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "two", type: "agentMessage", phase: "commentary", text: "second" } } }), 40);
      }
    } else if (message.method === "turn/start") {
      clientId = message.params.clientUserMessageId;
      appendFileSync(process.env.FAKE_CODEX_STARTS, "1\\n");
      send({ id: message.id, result: { turn: { id: "turn", status: "inProgress" } } });
    }
  }
});
setInterval(() => {}, 1000);
`, "utf8");
  await chmod(fakeCodex, 0o755);
  const config = await configFile(`[[agents]]\nid = "one"\nlabel = "One"\ncwd = "${directory}"\nthread_id = "thread"\nmodel = "gpt-test"\n`);
  const child = spawn("/bin/sh", ["-c", "printf 'work\\n' | \"$ROUTER_NODE\" \"$ROUTER_CLI\" --config \"$ROUTER_CONFIG\" send one --stdin --stream | head -n 1"], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      CODEX_HOME: home,
      FAKE_CODEX_PID: pidPath,
      FAKE_CODEX_STARTS: startsPath,
      ROUTER_NODE: process.execPath,
      ROUTER_CLI: CLI,
      ROUTER_CONFIG: config,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stream EPIPE probe timed out")), 7_000);
    child.once("exit", (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'/);
  assert.equal((await readFile(startsPath, "utf8")).trim(), "1");
  const appServerPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
  assert.throws(() => process.kill(appServerPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
});
