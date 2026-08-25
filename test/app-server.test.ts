import assert from "node:assert/strict";
import test from "node:test";
import {
  connectLocalAppServer,
  ensureRemoteProxy,
  parseDaemonStartResult,
  parseRemoteControlSocketState,
  remoteDaemonStartSpec,
  type AppServerConnection,
  type RemoteSocketState,
} from "../src/app-server.js";
import { RouterError } from "../src/errors.js";
import type { JsonRpcClient } from "../src/json-rpc.js";

test("remote socket probe distinguishes only an absent or live socket", () => {
  assert.equal(parseRemoteControlSocketState("socket\n"), "socket");
  assert.equal(parseRemoteControlSocketState("absent\n"), "absent");
  assert.throws(
    () => parseRemoteControlSocketState("other\n"),
    (error: unknown) => error instanceof RouterError && error.code === "app_server_connect_failed",
  );
  assert.throws(
    () => parseRemoteControlSocketState("ssh warning\n"),
    (error: unknown) => error instanceof RouterError && error.code === "app_server_protocol_failed",
  );
});

test("daemon lifecycle output must be exactly one JSON object", () => {
  assert.deepEqual(parseDaemonStartResult('{"status":"started"}\n'), { status: "started" });
  for (const invalid of ["", "[]", "null", "warning\n{\"status\":\"started\"}"]) {
    assert.throws(
      () => parseDaemonStartResult(invalid),
      (error: unknown) => error instanceof RouterError && error.code === "app_server_protocol_failed",
    );
  }
});

test("remote daemon start uses only the idempotent start command", () => {
  const spec = remoteDaemonStartSpec("server");
  assert.equal(spec.command, "ssh");
  assert.equal(spec.args.at(-2), "server");
  assert.equal(spec.args.at(-1), "'codex' 'app-server' 'daemon' 'start'");
  assert.equal(spec.args.join(" ").includes("bootstrap"), false);
  assert.equal(spec.args.join(" ").includes("remote-control"), false);
  assert.equal(spec.args.join(" ").includes("restart"), false);
});

function connection(): AppServerConnection {
  return { client: {} as JsonRpcClient, transportKind: "proxy", close: async () => undefined };
}

test("existing remote socket connects without touching daemon lifecycle", async () => {
  const calls: string[] = [];
  const result = await ensureRemoteProxy({
    probe: async () => { calls.push("probe"); return "socket"; },
    startDaemon: async () => { calls.push("start"); },
    connectProxy: async () => { calls.push("connect"); return connection(); },
  });
  assert.equal(result.transportKind, "proxy");
  assert.deepEqual(calls, ["probe", "connect"]);
});

test("absent remote socket starts daemon, re-probes, then connects proxy", async () => {
  const calls: string[] = [];
  const states: RemoteSocketState[] = ["absent", "socket"];
  const result = await ensureRemoteProxy({
    probe: async () => { calls.push("probe"); return states.shift() ?? "socket"; },
    startDaemon: async () => { calls.push("start"); },
    connectProxy: async () => { calls.push("connect"); return connection(); },
  });
  assert.equal(result.transportKind, "proxy");
  assert.deepEqual(calls, ["probe", "start", "probe", "connect"]);
});

test("unusable socket receives one safe daemon-start repair attempt", async () => {
  const calls: string[] = [];
  let connects = 0;
  await ensureRemoteProxy({
    probe: async () => { calls.push("probe"); return "socket"; },
    startDaemon: async () => { calls.push("start"); },
    connectProxy: async () => {
      calls.push("connect");
      if (connects++ === 0) throw new RouterError("app_server_connect_failed", "stale");
      return connection();
    },
  });
  assert.deepEqual(calls, ["probe", "connect", "start", "probe", "connect"]);
});

test("daemon start must expose a socket before proxy connection", async () => {
  await assert.rejects(
    ensureRemoteProxy({
      probe: async () => "absent",
      startDaemon: async () => undefined,
      connectProxy: async () => connection(),
    }),
    (error: unknown) => error instanceof RouterError && error.code === "app_server_start_failed",
  );
});

test("local app-server falls back to owned stdio only for an unreachable socket proxy", async () => {
  const fallbackCalls: string[] = [];
  const fallback = await connectLocalAppServer({
    probe: async () => "socket",
    connectProxy: async () => {
      fallbackCalls.push("proxy");
      throw new RouterError("app_server_connect_failed", "stale socket");
    },
    connectStdio: async () => {
      fallbackCalls.push("stdio");
      return { ...connection(), transportKind: "stdio" };
    },
  });
  assert.equal(fallback.transportKind, "stdio");
  assert.deepEqual(fallbackCalls, ["proxy", "stdio"]);

  for (const code of ["app_server_protocol_failed", "timeout", "codex_unavailable"] as const) {
    const calls: string[] = [];
    await assert.rejects(
      connectLocalAppServer({
        probe: async () => "socket",
        connectProxy: async () => {
          calls.push("proxy");
          throw new RouterError(code, "definite failure");
        },
        connectStdio: async () => {
          calls.push("stdio");
          return { ...connection(), transportKind: "stdio" };
        },
      }),
      (error: unknown) => error instanceof RouterError && error.code === code,
    );
    assert.deepEqual(calls, ["proxy"]);
  }
});

test("local app-server uses stdio directly when the socket is absent", async () => {
  const calls: string[] = [];
  const states = ["absent", "absent"] as const;
  let probe = 0;
  const result = await connectLocalAppServer({
    probe: async () => states[probe++] ?? "absent",
    connectProxy: async () => { calls.push("proxy"); return connection(); },
    connectStdio: async () => { calls.push("stdio"); return { ...connection(), transportKind: "stdio" }; },
  });
  assert.equal(result.transportKind, "stdio");
  assert.deepEqual(calls, ["stdio"]);
});
