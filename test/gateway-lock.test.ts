import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { GatewayStore } from "../src/gateway-state.js";
import { preparePrivateDirectory } from "../src/platform-storage.js";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "router-kernel-lock-test-")));
  const root = join(directory, "state"); await preparePrivateDirectory(root);
  const worker = join(directory, "worker.mjs");
  await writeFile(worker, `import {GatewayStore} from ${JSON.stringify(new URL("../src/gateway-state.js", import.meta.url).href)};
import {createRequire} from 'node:module';import {open} from 'node:fs/promises';import {join} from 'node:path';
let store,file;
try {
 if(process.argv[3]==='before-metadata') { file=await open(join(process.argv[2],'lock'),'a+',0o600); const {tryLock}=createRequire(${JSON.stringify(new URL("../src/gateway-lock.js", import.meta.url).href)})('fs-native-extensions'); if(!tryLock(file.fd))throw Error('busy'); }
 else {store=await GatewayStore.open(process.argv[2]);await store.transaction(s=>{s.polling={}});}
 process.send({acquired:true});process.on('message',async()=>{await store?.close();await file?.close();process.disconnect();});
} catch(e) {process.send({acquired:false,code:e.code,message:e.message});process.disconnect();}
`);
  const children = new Set<ChildProcess>();
  function start(mode = "store") {
    const child = fork(worker, [root, mode], { stdio: ["ignore", "ignore", "inherit", "ipc"] }); children.add(child);
    const exited = new Promise<void>(resolve => child.once("exit", () => { children.delete(child); resolve(); }));
    const result = new Promise<{ acquired: boolean; code?: string }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("lock child timed out")); }, 20000);
      child.once("message", value => { clearTimeout(timer); resolve(value as { acquired: boolean; code?: string }); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    return { child, result, exited, async stop(kill = false) { if (child.exitCode !== null || child.signalCode !== null) return; if (kill) child.kill("SIGKILL"); else child.send("close"); await exited; } };
  }
  return { root, start, async close() { for (const child of children) child.kill("SIGKILL"); await Promise.all([...children].map(child => new Promise<void>(resolve => child.once("exit", () => resolve())))); await rm(directory, { recursive: true, force: true }); } };
}

test("kernel lock rejects a second handle and retains one sentinel across clean reopen", async () => {
  const f = await fixture(); let store: GatewayStore | undefined;
  try {
    store = await GatewayStore.open(f.root); const identity = await lstat(join(f.root, "lock"));
    await assert.rejects(GatewayStore.open(f.root), { code: "gateway_running" });
    await store.close(); store = undefined;
    assert.equal((await lstat(join(f.root, "lock"))).ino, identity.ino);
    await assert.rejects(readFile(join(f.root, "owner.json")), { code: "ENOENT" });
    store = await GatewayStore.open(f.root);
    assert.equal((await lstat(join(f.root, "lock"))).ino, identity.ino);
  } finally { await store?.close(); await f.close(); }
});

test("canonical startup failure releases the kernel handle; stale metadata does not block admission", async () => {
  const f = await fixture(); let store: GatewayStore | undefined;
  try {
    await writeFile(join(f.root, "state.json"), "invalid", { mode: 0o600 });
    await assert.rejects(GatewayStore.open(f.root), { code: "state_invalid" });
    await writeFile(join(f.root, "state.json"), JSON.stringify({ version: 2, routes: {} }), { mode: 0o600 });
    await writeFile(join(f.root, "owner.json"), "truncated-owner", { mode: 0o600 });
    store = await GatewayStore.open(f.root);
    assert.equal(JSON.parse(await readFile(join(f.root, "owner.json"), "utf8")).pid, process.pid);
  } finally { await store?.close(); await f.close(); }
});

test("a non-file lock path is rejected without deleting its contents", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "lock"), { mode: 0o700 });
    await writeFile(join(f.root, "lock", "untouched"), "", { mode: 0o600 });
    await assert.rejects(GatewayStore.open(f.root), { code: "state_invalid" });
    assert.ok((await lstat(join(f.root, "lock"))).isDirectory());
    assert.equal(await readFile(join(f.root, "lock", "untouched"), "utf8"), "");
  } finally { await f.close(); }
});

test("process death before owner metadata or after a durable write releases the same lock", async () => {
  const f = await fixture();
  try {
    for (const mode of ["before-metadata", "store", "store"]) {
      const child = f.start(mode); assert.equal((await child.result).acquired, true);
      await assert.rejects(GatewayStore.open(f.root), { code: "gateway_running" });
      await child.stop(true);
      const successor = await GatewayStore.open(f.root);
      if (mode === "store") assert.deepEqual(successor.snapshot().polling, {});
      await successor.close();
    }
  } finally { await f.close(); }
});

test("simultaneous processes admit only one writer until its handle closes", async () => {
  const f = await fixture();
  try {
    const contenders = Array.from({ length: 6 }, () => f.start());
    const results = await Promise.all(contenders.map(child => child.result));
    assert.equal(results.filter(result => result.acquired).length, 1);
    assert.ok(results.filter(result => !result.acquired).every(result => result.code === "gateway_running"));
    await contenders[results.findIndex(result => result.acquired)]!.stop();
    const next = await GatewayStore.open(f.root); await next.close();
  } finally { await f.close(); }
});
