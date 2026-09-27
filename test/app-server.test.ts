import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  connectLocalAppServer,
  localControlSocketState,
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

test("an existing proxy failure never starts a competing owned server", async () => {
  for (const code of ["app_server_connect_failed", "app_server_protocol_failed", "timeout", "codex_unavailable"] as const) {
    const calls: string[] = [];
    await assert.rejects(
      connectLocalAppServer({
        probe: async () => "socket",
        connectProxy: async () => { calls.push("proxy"); throw new RouterError(code, "failed"); },
        connectStdio: async () => { calls.push("stdio"); return connection(); },
      }),
      (error: unknown) => error instanceof RouterError && error.code === code,
    );
    assert.deepEqual(calls, ["proxy"]);
  }
});

test("local socket discovery accepts protected rendezvous symlinks and rejects unsafe endpoints", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "cr-sock-"));
  const endpoint = join(directory, "owner.sock");
  const alias = join(directory, "control.sock");
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    await chmod(endpoint, 0o600);
    await symlink(endpoint, alias);
    assert.equal(await localControlSocketState(endpoint), "socket");
    assert.equal(await localControlSocketState(alias), "socket");
    await chmod(endpoint, 0o666);
    await assert.rejects(localControlSocketState(alias), { code: "app_server_connect_failed" });
    await chmod(endpoint, 0o600);
    await chmod(directory, 0o777);
    await assert.rejects(localControlSocketState(alias), { code: "app_server_connect_failed" });
    await chmod(directory, 0o700);
    await symlink(join(directory, "missing"), join(directory, "broken"));
    await assert.rejects(localControlSocketState(join(directory, "broken")), { code: "app_server_connect_failed" });
    await writeFile(join(directory, "file"), "not a socket");
    await symlink(join(directory, "file"), join(directory, "file-link"));
    assert.equal(await localControlSocketState(join(directory, "file-link")), "other");
    assert.equal(await localControlSocketState(join(directory, "absent")), "absent");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
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
