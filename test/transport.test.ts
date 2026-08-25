import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { boundedProcessDiagnostic, codexProcessSpec, ProxyTransport, safeSshDiagnostic, StdioTransport, terminateChild } from "../src/transport.js";

const SSH_OPTIONS = [
  "-T",
  "-oBatchMode=yes",
  "-oConnectTimeout=10",
  "-oServerAliveInterval=15",
  "-oServerAliveCountMax=4",
];

test("local Codex commands spawn Codex directly", () => {
  assert.deepEqual(codexProcessSpec(["app-server", "--listen", "stdio://"]), {
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
  });
});

test("remote Codex commands are wrapped with SSH", () => {
  assert.deepEqual(codexProcessSpec(["--version"], "doordash.exe.xyz"), {
    command: "ssh",
    args: [
      ...SSH_OPTIONS,
      "doordash.exe.xyz",
      "'codex' '--version'",
    ],
  });
});

test("remote arguments are safely quoted for the SSH shell", () => {
  assert.deepEqual(codexProcessSpec(["example", "it's here"], "server"), {
    command: "ssh",
    args: [...SSH_OPTIONS, "server", "'codex' 'example' 'it'\"'\"'s here'"],
  });
});

test("remote proxy commands use the same SSH wrapper", () => {
  assert.deepEqual(codexProcessSpec(["app-server", "proxy"], "server"), {
    command: "ssh",
    args: [...SSH_OPTIONS, "server", "'codex' 'app-server' 'proxy'"],
  });
});

test("process diagnostics are flattened and bounded", () => {
  const diagnostic = boundedProcessDiagnostic(`\u001b[31merror\u001b[0m\n${"x".repeat(2_000)}`);
  assert.ok(diagnostic);
  assert.equal(diagnostic.includes("\u001b"), false);
  assert.equal(diagnostic.includes("\n"), false);
  assert.ok(Buffer.byteLength(diagnostic) <= 1_024);
});

test("only recognizable SSH diagnostics are safe for user-facing failures", () => {
  assert.equal(safeSshDiagnostic("ssh: connect to host example: Operation timed out"), "ssh: connect to host example: Operation timed out");
  assert.equal(safeSshDiagnostic("remote Codex internal diagnostic with a path"), undefined);
});

test("child shutdown waits for EOF, then TERM, then SIGKILL as needed", async () => {
  const eofChild = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await once(eofChild, "spawn");
  eofChild.stdin.end();
  await terminateChild(eofChild, { eofGraceMs: 100, termGraceMs: 100 });
  assert.equal(eofChild.exitCode, 0);

  const termChild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await once(termChild.stdout, "data");
  termChild.stdin.end();
  await terminateChild(termChild, { eofGraceMs: 10, termGraceMs: 100 });
  assert.equal(termChild.exitCode, 0);

  const killChild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await once(killChild.stdout, "data");
  const pid = killChild.pid;
  killChild.stdin.end();
  await terminateChild(killChild, { eofGraceMs: 10, termGraceMs: 10 });
  assert.equal(killChild.signalCode, "SIGKILL");
  assert.throws(() => process.kill(pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
});

test("transport close is idempotent for concurrent callers", async () => {
  for (const transport of [new StdioTransport(), new ProxyTransport()]) {
    const first = transport.close();
    const second = transport.close();
    assert.equal(first, second);
    await Promise.all([first, second]);
  }
});
