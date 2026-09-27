import assert from "node:assert/strict";
import test from "node:test";
import { openExecutionSession, verifyExecutionBinding, type ExecutionSession, type ExecutionBinding } from "../src/execution-session.js";
import { RouterError } from "../src/errors.js";

const agent = { id: "one", label: "One", cwd: "/tmp", threadId: "target", model: "test" };
const signal = new AbortController().signal;
const desktop = { backend: "desktop" } as ExecutionSession;
const direct = { backend: "stdio" } as ExecutionSession;
const binding: ExecutionBinding = { backend: "desktop", host: "local", codexHome: "/home/codex", threadId: "target" };

test("exact Desktop owner wins; definitive absence selects direct execution", async () => {
  let connects = 0;
  const operations = { desktop: async () => desktop as ExecutionSession | undefined, direct: async () => { connects++; return direct; } };
  assert.equal(await openExecutionSession(agent, signal, undefined, operations), desktop);
  assert.equal(connects, 0);
  operations.desktop = async () => undefined;
  assert.equal(await openExecutionSession(agent, signal, undefined, operations), direct);
  assert.equal(connects, 1);
});

test("discovery uncertainty never launches a second execution server", async () => {
  let connects = 0;
  for (const code of ["timeout", "app_server_protocol_failed", "app_server_connect_failed"] as const) {
    await assert.rejects(openExecutionSession(agent, signal, undefined, {
      desktop: async () => { throw new RouterError(code, "discovery failed"); },
      direct: async () => { connects++; return direct; },
    }), (error: unknown) => error instanceof RouterError && error.code === code);
  }
  assert.equal(connects, 0);
});

test("SSH never probes an unrelated local Desktop", async () => {
  let probes = 0;
  assert.equal(await openExecutionSession({ ...agent, sshHost: "server" }, signal, undefined, {
    desktop: async () => { probes++; return desktop; }, direct: async () => direct,
  }), direct);
  assert.equal(probes, 0);
});

test("admitted Desktop work waits for Desktop instead of falling back to owned execution", async () => {
  let connects = 0;
  await assert.rejects(openExecutionSession(agent, signal, binding, {
    desktop: async () => undefined, direct: async () => { connects++; return direct; },
  }), (error: unknown) => error instanceof RouterError && error.code === "thread_busy");
  assert.equal(connects, 0);
});

test("logical recovery target must match and Desktop cannot downgrade its output boundary", () => {
  assert.doesNotThrow(() => verifyExecutionBinding(binding, { ...binding }));
  for (const changed of [{ host: "elsewhere" }, { codexHome: "/other/home" }, { threadId: "other" }]) {
    assert.throws(() => verifyExecutionBinding(binding, { ...binding, ...changed }),
      (error: unknown) => error instanceof RouterError && error.code === "state_invalid");
  }
  assert.throws(() => verifyExecutionBinding(binding, { ...binding, backend: "stdio" }),
    (error: unknown) => error instanceof RouterError && error.code === "thread_busy");
});
