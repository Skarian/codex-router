import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GatewayStore } from "../src/gateway-state.js";
import { readGatewayStatus, startDiagnostics } from "../src/gateway-diagnostics.js";
const execute = promisify(execFile);

test("native status ignores unrelated temp churn and validates the consumed snapshot", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "router-status-native-")));
  const root = join(parent, "private");
  const store = await GatewayStore.open(root);
  const diagnostic = startDiagnostics(root, () => ({ ready: true, polling: [], routes: [], unresolved: [] }), { intervalMs: 25 });
  let running = true;
  const churn = (async () => {
    let i = 0;
    while (running) {
      const path = join(root, `unrelated-${i++}.tmp`);
      await writeFile(path, "temporary", { mode: 0o600 });
      await rm(path);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })();
  try {
    await diagnostic.refresh();
    for (let i = 0; i < 5; i++) assert.equal((await readGatewayStatus(root)).runtime.state, "live");
    await diagnostic.refresh();
    diagnostic.close();
    const path = join(root, "status.json");
    if (process.platform === "win32") await execute("icacls.exe", [path, "/grant", "*S-1-1-0:R"], { windowsHide: true });
    else await chmod(path, 0o644);
    assert.equal((await readGatewayStatus(root)).runtime.state, "unavailable");
  } finally {
    running = false;
    await churn;
    diagnostic.close();
    await store.close();
    await rm(parent, { recursive: true, force: true });
  }
});


test("snapshot freshness uses observation time and preserves age boundaries", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "router-status-clock-")));
  const root = join(parent, "private");
  const store = await GatewayStore.open(root);
  const diagnostic = startDiagnostics(root, () => ({ ready: true, polling: [], routes: [], unresolved: [] }), { intervalMs: 60000 });
  try {
    await diagnostic.refresh();
    diagnostic.close();
    const path = join(root, "status.json");
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    let now = snapshot.capturedAt - 1;
    let calls = 0;
    const pending = readGatewayStatus(root, () => { calls++; return now; });
    assert.equal(calls, 0);
    now = snapshot.capturedAt;
    assert.equal((await pending).runtime.state, "live");
    assert.equal(calls, 1);
    for (const [age, expected] of [[15000, "live"], [15001, "stale"], [-1, "stale"]] as const) {
      assert.equal((await readGatewayStatus(root, () => snapshot.capturedAt + age)).runtime.state, expected);
    }
  } finally {
    diagnostic.close();
    await store.close();
    await rm(parent, { recursive: true, force: true });
  }
});
