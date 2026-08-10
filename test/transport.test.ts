import assert from "node:assert/strict";
import test from "node:test";
import { codexProcessSpec } from "../src/transport.js";

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
      "-T",
      "-oBatchMode=yes",
      "-oConnectTimeout=10",
      "doordash.exe.xyz",
      "'codex' 'app-server' '--listen' 'stdio://'",
    ],
  });
});

test("remote arguments are safely quoted for the SSH shell", () => {
  assert.deepEqual(codexProcessSpec(["example", "it's here"], "server"), {
    command: "ssh",
    args: ["-T", "-oBatchMode=yes", "-oConnectTimeout=10", "server", "'codex' 'example' 'it'\"'\"'s here'"],
  });
});

test("remote proxy commands use the same SSH wrapper", () => {
  assert.deepEqual(codexProcessSpec(["app-server", "proxy"], "server"), {
    command: "ssh",
    args: ["-T", "-oBatchMode=yes", "-oConnectTimeout=10", "server", "'codex' 'app-server' 'proxy'"],
  });
});
