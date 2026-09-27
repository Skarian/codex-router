import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, rm, writeFile, readFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { preparePrivateDirectory, assertPrivatePath, validateExistingPrivatePaths, syncDirectory } from "../src/platform-storage.js";
import { GatewayStore } from "../src/gateway-state.js";
import { readGatewayStatus, startDiagnostics } from "../src/gateway-diagnostics.js";
import { copyLocal } from "../src/gateway-files.js";
const execute = promisify(execFile);

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "router-native-storage-")));
  return { parent, root: join(parent, "private"), close: () => rm(parent, { recursive: true, force: true }) };
}

test("private native storage supports durable snapshots, exclusive ownership and live diagnostics", async () => {
  const f = await fixture(); let store: GatewayStore | undefined;
  try {
    store = await GatewayStore.open(f.root);
    await store.transaction(state => { state.polling = {}; });
    assert.equal(JSON.parse(await readFile(join(f.root, "state.json"), "utf8")).version, 2);
    await assert.rejects(GatewayStore.open(f.root), { code: "gateway_running" });
    const diagnostics = startDiagnostics(f.root, () => ({ ready: true, polling: [], routes: [], unresolved: [] }));
    try {
      await diagnostics.refresh();
      assert.equal((await readGatewayStatus(f.root)).runtime.state, "live");
    } finally { diagnostics.close(); }
    await store.close(); store = undefined;
    assert.equal((await readGatewayStatus(f.root)).runtime.state, "stopped");
    store = await GatewayStore.open(f.root);
    assert.deepEqual(store.snapshot().polling, {});
  } finally { await store?.close(); await f.close(); }
});

test("private roots reject links and refuse to create missing read-only status directories", async () => {
  const f = await fixture();
  try {
    const missing = join(f.parent, "missing");
    assert.equal((await readGatewayStatus(missing)).runtime.state, "unavailable");
    await assert.rejects(readFile(join(missing, "status.json")), { code: "ENOENT" });
    await preparePrivateDirectory(f.root);
    const outside = join(f.parent, "outside"); await mkdir(outside);
    const link = join(f.root, "link"); await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(assertPrivatePath(link, true));
    await preparePrivateDirectory(f.root, false); // Unrelated children are not root inputs.
    await assert.rejects(validateExistingPrivatePaths([link]));
  } finally { await f.close(); }
});

test("native file publication flushes writable bytes and keeps exclusive destinations", async () => {
  const f = await fixture();
  try {
    await preparePrivateDirectory(f.root);
    const source = join(f.root, "source.bin"), destination = join(f.root, "copy.bin");
    const content = Buffer.alloc(1024 * 1024, 123); await writeFile(source, content, { mode: 0o600 });
    await copyLocal(source, destination, new AbortController().signal);
    assert.deepEqual(await readFile(destination), content);
    await assert.rejects(copyLocal(source, destination, new AbortController().signal));
    assert.deepEqual(await readFile(destination), content);
    await syncDirectory(f.root);
  } finally { await f.close(); }
});

test("startup rejects an existing child made readable outside the trusted principals", async () => {
  const f = await fixture();
  try {
    await preparePrivateDirectory(f.root);
    const child = join(f.root, "state.json"); await writeFile(child, "{}", { mode: 0o600 });
    if (process.platform === "win32") {
      await execute("icacls.exe", [child, "/grant", "*S-1-1-0:R"], { windowsHide: true });
      await preparePrivateDirectory(f.root, false);
      await assert.rejects(validateExistingPrivatePaths([child]), { code: "state_invalid" });
    } else {
      await chmod(child, 0o644);
      await assert.rejects(assertPrivatePath(child, false), { code: "state_invalid" });
    }
  } finally { await f.close(); }
});

test("native file plane publishes attachments and releases only its own files", async () => {
  const f = await fixture();
  try {
    await preparePrivateDirectory(f.root);
    const home = join(f.root, "codex"), spool = join(f.root, "spool"); await mkdir(home); await mkdir(spool, { mode: 0o700 });
    const { GatewayFilePlane } = await import("../src/gateway-files.js");
    const { lstat, readdir } = await import("node:fs/promises");
    const session: import("../src/gateway.js").GatewaySession = {
      serverInfo: { codexHome: home, platformFamily: process.platform === "win32" ? "windows" : "unix", platformOs: process.platform }, artifactBaseline: [],
      async resume() { return { thread: {} }; }, async admit() { return "turn"; }, async restore() { return "turn"; }, async close() {},
      async observe() { return { turnId: "turn", status: "completed", imageGenerations: [] }; },
      async filesystem(method, params) {
        const p = params as { path: string; recursive?: boolean; force?: boolean };
        if (method === "fs/createDirectory") { await mkdir(p.path, { recursive: p.recursive ?? false }); return {}; }
        if (method === "fs/remove") { await rm(p.path, { recursive: p.recursive ?? false, force: p.force ?? false }); return {}; }
        if (method === "fs/readDirectory") return { entries: (await readdir(p.path, { withFileTypes: true })).map(e => ({ fileName: e.name, isFile: e.isFile() })) };
        const s = await lstat(p.path); return { isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink() };
      },
    };
    const route: import("../src/config.js").GatewayRoute = { id: "route", agent: { id: "agent", label: "Agent", cwd: f.root, threadId: "thread", model: "test" } };
    const uploads: string[] = [];
    const connector: import("../src/gateway.js").SendblueProvider = {
      signingSecret: "test", inbound() { return undefined; }, callback() { return { status: "SENT" }; }, async typing() {},
      async send() { return { status: "accepted", providerHandle: "test" }; },
      async upload(path, name) { assert.equal(await readFile(path, "utf8"), "published bytes"); uploads.push(name); return "https://example.com/file"; },
    };
    const files = new GatewayFilePlane(spool), state = { version: 2 as const, routes: {} }, signal = new AbortController().signal;
    await files.cleanup(state); await files.reconcile(route, state, session, signal);
    const publication = await files.publication(route, "publication", session, signal);
    await writeFile(join(publication, "attachment.txt"), "published bytes", { mode: 0o600 });
    const work: import("../src/gateway-state.js").CodexWork = { kind: "codex", ownerBatchId: "batch", joinedBatchIds: [], batches: [], publicationIds: ["publication"], artifactBaseline: [] };
    const parts = await files.delivery(route, work, { turnId: "turn", status: "completed", finalText: "answer", imageGenerations: [] }, session, connector, signal);
    assert.deepEqual(uploads, ["attachment.txt"]); assert.deepEqual(parts.map(p => p.payload.kind), ["text", "media"]);
    if (process.platform === "win32") {
      const published = join(publication, "attachment.txt");
      await execute("icacls.exe", [published, "/grant", "*S-1-1-0:R"], { windowsHide: true });
      const rejected = await files.delivery(route, work, { turnId: "turn", status: "completed", finalText: "answer", imageGenerations: [] }, session, connector, signal);
      assert.equal(uploads.length, 1);
      assert.ok(rejected.some(part => part.payload.kind === "text" && part.payload.text.includes("response directory is unavailable or unsafe")));
      assert.ok(rejected.every(part => part.payload.kind !== "media"));
      const retained = parts.find(part => part.payload.kind === "media")!.payload;
      assert.equal(retained.kind, "media");
      if (retained.kind === "media") {
        await execute("icacls.exe", [retained.localPath, "/grant", "*S-1-1-0:R"], { windowsHide: true });
        // cleanup consumes retained media references; unrelated state fields are immaterial here.
        const retainedState = { version: 2, routes: { route: { queue: [], active: { kind: "delivery", parts } } } } as unknown as import("../src/gateway-state.js").GatewayState;
        await assert.rejects(files.cleanup(retainedState), { code: "state_invalid" });
      }
    }
    await files.release(route, work, session);
    await assert.rejects(lstat(publication), { code: "ENOENT" });
    await files.release(route, { kind: "delivery", sourceId: "sendblue:account", id: "delivery", batchIds: [], parts });
    assert.deepEqual(await readdir(join(spool, "outbox")), []);
  } finally { await f.close(); }
});


test("unsafe canonical state releases ownership and unsafe sentinel refuses acquisition", async () => {
  const f = await fixture();
  const grant = async (path: string, unsafe: boolean) => {
    if (process.platform === "win32") await execute("icacls.exe", unsafe ? [path, "/grant", "*S-1-1-0:R"] : [path, "/remove:g", "*S-1-1-0"], { windowsHide: true });
    else await chmod(path, unsafe ? 0o644 : 0o600);
  };
  try {
    const initial = await GatewayStore.open(f.root);
    await initial.transaction(state => { state.polling = {}; }); await initial.close();
    for (const name of ["state.json", "lock"]) {
      const path = join(f.root, name); await grant(path, true);
      await assert.rejects(GatewayStore.open(f.root), { code: "state_invalid" });
      await grant(path, false);
      const reopened = await GatewayStore.open(f.root); await reopened.close();
    }
  } finally { await f.close(); }
});

test("private inherited roots ignore unrelated temporary file churn", async () => {
  const f = await fixture();
  try {
    await preparePrivateDirectory(f.root);
    const nested = join(f.root, "nested"); await mkdir(nested, { mode: 0o700 });
    const changing = join(nested, "unrelated.tmp"); let stopped = false;
    const churn = (async () => { while (!stopped) { await writeFile(changing, "temporary", { mode: 0o600 }); await rm(changing); } })();
    try {
      await preparePrivateDirectory(nested, false);
      await validateExistingPrivatePaths([join(nested, "absent.json")]);
    } finally { stopped = true; await churn; }
  } finally { await f.close(); }
});
