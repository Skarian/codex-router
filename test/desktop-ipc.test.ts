import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopIpc, DesktopResponseError, DESKTOP_FRAME_LIMIT } from "../src/desktop-ipc.js";
function frame(value: unknown): Buffer { const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); }
async function fixture(run: (client: DesktopIpc, server: Socket) => Promise<void>, timeout = 100) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-ipc-"));
  const server = createServer(); const path = join(directory, "s");
  await new Promise<void>(resolve => server.listen(path, resolve));
  const accepted = new Promise<Socket>(resolve => server.once("connection", resolve));
  const client = new DesktopIpc(connect(path), undefined, timeout); const peer = await accepted;
  try { await run(client, peer); } finally { client.close(); peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}
function next(peer: Socket): Promise<any> { return new Promise(resolve => { let bytes = Buffer.alloc(0); const listener = (chunk: Buffer) => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) { peer.off("data", listener); resolve(JSON.parse(bytes.subarray(4).toString())); } }; peer.on("data", listener); }); }
test("Desktop IPC accepts fragmented frames and correlates owner replies", async () => fixture(async (client, peer) => {
  const wire = next(peer); const result = client.request("history", {}, 1, "owner"); const request = await wire;
  const bytes = frame({ type: "response", requestId: request.requestId, method: "history", handledByClientId: "owner", resultType: "success", result: { revision: 4 } });
  peer.write(bytes.subarray(0, 2)); peer.write(bytes.subarray(2, 7)); peer.write(bytes.subarray(7));
  assert.equal((await result).result.revision, 4);
}));
test("Desktop IPC fails oversized frames before allocating advertised body", async () => fixture(async (client, peer) => {
  const rejected = assert.rejects(client.request("history", {}, 1), /invalid frame/);
  const header = Buffer.alloc(4); header.writeUInt32LE(DESKTOP_FRAME_LIMIT + 1); peer.write(header); await rejected;
}));
test("Desktop IPC rejects response from a different owner", async () => fixture(async (client, peer) => {
  const wire = next(peer); const rejected = assert.rejects(client.request("history", {}, 1, "owner"), /identity/); const request = await wire;
  peer.write(frame({ type: "response", requestId: request.requestId, method: "history", handledByClientId: "other", resultType: "success", result: {} })); await rejected;
}));
test("Desktop IPC timeout is not definite owner absence", async () => fixture(async client => {
  await assert.rejects(client.request("thread-owner-discovery", {}, 1), (error: any) => error.code === "timeout");
}, 20));

import { mkdir, symlink } from "node:fs/promises";
test("Desktop discovery distinguishes missing socket from a broken alias", async () => {
  if (process.platform === "win32") return;
  const home = await mkdtemp(join(tmpdir(), "desktop-endpoint-"));
  try {
    await mkdir(join(home, "ipc"), { mode: 0o700 });
    assert.equal(await DesktopIpc.connect(home), undefined);
    await symlink(join(home, "missing-socket"), join(home, "ipc", "ipc.sock"));
    await assert.rejects(DesktopIpc.connect(home), (error: any) => error.code === "app_server_connect_failed");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop broker no-client response need not include a method", async () => fixture(async (client, peer) => {
  const wire = next(peer); const rejected = assert.rejects(client.request("thread-owner-discovery", {}, 1), (error: any) => error.response?.error === "no-client-found");
  const request = await wire;
  peer.write(frame({ type: "response", requestId: request.requestId, resultType: "error", error: "no-client-found" }));
  await rejected;
}));

for (const brokerError of ["no-client-found", "client-disconnected", "unsupported-version"]) {
  test(`Desktop broker ${brokerError} preserves availability versus protocol errors`, async () => fixture(async (client, peer) => {
    const wire = next(peer);
    const rejected = assert.rejects(client.request("thread-follower-load-complete-history", {}, 1, "owner"), (error: unknown) => {
      assert.ok(error instanceof DesktopResponseError);
      assert.equal(error.response.error, brokerError);
      assert.equal(error.code, brokerError === "unsupported-version" ? "app_server_protocol_failed" : "app_server_disconnected");
      return true;
    });
    const request = await wire;
    peer.write(frame({ type: "response", requestId: request.requestId, resultType: "error", error: brokerError }));
    await rejected;
  }));
}
