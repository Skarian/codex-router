import assert from "node:assert/strict";
import test from "node:test";
import { boundedProcessDiagnostic, codexProcessSpec, safeSshDiagnostic } from "../src/transport.js";

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
  assert.deepEqual(codexProcessSpec(["app-server", "--listen", "stdio://"], "doordash.exe.xyz"), {
    command: "ssh",
    args: [
      ...SSH_OPTIONS,
      "doordash.exe.xyz",
      "'codex' 'app-server' '--listen' 'stdio://'",
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
