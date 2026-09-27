import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, readdir, lstat, readFile, writeFile, rm, symlink, open, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouterError } from "../src/errors.js";
import { randomUUID } from "node:crypto";
import { GatewayFilePlane, copyLocal, hashFile, inspectLocal } from "../src/gateway-files.js";
import type { GatewaySession, SendblueProvider } from "../src/gateway.js";
import type { GatewayRoute } from "../src/config.js";
import type { CodexWork, GatewayState, Batch } from "../src/gateway-state.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gateway-files-")));
  const home = join(root, "codex"); const spool = join(root, "state"); await mkdir(home); await mkdir(spool, { mode: 0o700 });
  const route: GatewayRoute = { id: "route", sendblueId: "account", sender: "+15125550100", sendblueNumber: "+15125550200", agent: { id: "one", label: "One", cwd: root, threadId: "thread", model: "test" } };
  const session: GatewaySession = {
    serverInfo: { codexHome: home, platformFamily: "unix", platformOs: "macos" }, artifactBaseline: [],
    async resume() { return { thread: {} }; }, async admit() { return "turn"; },
    async observe() { return { turnId: "turn", status: "completed", imageGenerations: [] }; }, async restore() { return "turn"; }, async close() {},
    async filesystem(method, params) {
      const p = params as { path: string; recursive?: boolean; force?: boolean };
      if (method === "fs/createDirectory") { await mkdir(p.path, { recursive: p.recursive ?? false }); return {}; }
      if (method === "fs/remove") { await rm(p.path, { recursive: p.recursive ?? false, force: p.force ?? false }); return {}; }
      if (method === "fs/readDirectory") return { entries: (await readdir(p.path, { withFileTypes: true })).map((entry) => ({ fileName: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() })) };
      const stat = await lstat(p.path); return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymlink: stat.isSymbolicLink(), modifiedAtMs: stat.mtimeMs, createdAtMs: stat.birthtimeMs };
    },
  };
  const uploads: Array<{ path: string; name: string; mediaType: string }> = [];
  const connector: SendblueProvider = { signingSecret: "secret", inbound() { return undefined; }, callback() { return { status: "SENT" }; }, async send() { return { status: "accepted", providerHandle: "handle" }; }, async typing() {},
    async upload(path, name, mediaType) { uploads.push({ path, name, mediaType }); return `https://cdn.example/${uploads.length}`; },
  };
  const files = new GatewayFilePlane(spool); const state: GatewayState = { version: 2, routes: {} }; const signal = new AbortController().signal;
  await files.cleanup(state); await files.reconcile(route, state, session, signal);
  const id = randomUUID(); const publication = await files.publication(route, id, session, signal);
  const work: CodexWork = { kind: "codex", ownerBatchId: "batch", joinedBatchIds: [], batches: [], turnId: "turn", publicationIds: [id], artifactBaseline: [] };
  return { root, home, spool, route, session, uploads, connector, files, publication, work, signal, async close() { await rm(root, { recursive: true, force: true }); } };
}

test("published and native artifacts deduplicate by bytes and preserve outside native sources", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.publication, "published.png"), PNG);
    const outside = join(f.root, "native.png"); await writeFile(outside, PNG);
    const parts = await f.files.delivery(f.route, f.work, { turnId: "turn", status: "completed", imageGenerations: [{ id: "image", savedPath: outside }] }, f.session, f.connector, f.signal);
    assert.equal(parts.length, 1); assert.equal(parts[0]!.payload.kind, "media"); assert.equal(f.uploads.length, 1);
    await f.files.release(f.route, f.work, f.session);
    assert.deepEqual(await readFile(outside), PNG);
    assert.deepEqual(await readFile(f.uploads[0]!.path), PNG);
    await f.files.release(f.route, { kind: "delivery", sourceId: "sendblue:account", id: "delivery", batchIds: [], parts });
    await assert.rejects(lstat(f.uploads[0]!.path));
  } finally { await f.close(); }
});

test("all uploads finish before text freezes and an upload failure adds an omission before media", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.publication, "a.txt"), "first"); await writeFile(join(f.publication, "b.txt"), "second");
    const upload = f.connector.upload;
    f.connector.upload = async (...args) => { if (args[1] === "b.txt") throw new Error("rejected"); return upload(...args); };
    const parts = await f.files.delivery(f.route, f.work, { turnId: "turn", status: "completed", finalText: "Answer", imageGenerations: [] }, f.session, f.connector, f.signal);
    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.payload.kind, "text");
    if (parts[0]!.payload.kind === "text") assert.match(parts[0]!.payload.text, /b\.txt.*upload failed/);
    assert.equal(parts[1]!.payload.kind, "media");
    if (parts[1]!.payload.kind === "media") assert.equal(parts[1]!.payload.mediaUrl, "https://cdn.example/1");
  } finally { await f.close(); }
});

test("native saved-path failures produce omissions without falling back to base64 or following symlinks", async () => {
  const f = await fixture();
  try {
    const original = join(f.root, "original.png"); await writeFile(original, PNG);
    const link = join(f.root, "link.png"); await symlink(original, link);
    const parts = await f.files.delivery(f.route, f.work, { turnId: "turn", status: "completed", imageGenerations: [{ id: "image", savedPath: link, result: PNG.toString("base64") }] }, f.session, f.connector, f.signal);
    assert.equal(f.uploads.length, 0); assert.equal(parts[0]!.payload.kind, "text");
    if (parts[0]!.payload.kind === "text") assert.match(parts[0]!.payload.text, /unsafe file/);
    assert.deepEqual(await readFile(original), PNG);
    await assert.rejects(inspectLocal(link));
  } finally { await f.close(); }
});

test("terminal outcomes cover base64-only, empty, failed, interrupted, and admission notices", async () => {
  const f = await fixture();
  try {
    const image = await f.files.delivery(f.route, f.work, { turnId: "turn", status: "completed", imageGenerations: [{ id: "native", result: PNG.toString("base64") }] }, f.session, f.connector, f.signal);
    assert.equal(image.length, 1); assert.equal(image[0]!.payload.kind, "media");
    for (const [status, text] of [["completed", "Codex finished without a response."], ["failed", "Codex could not finish this request."], ["interrupted", "Codex stopped before finishing this request."]] as const) {
      const parts = await f.files.delivery(f.route, { ...f.work, admissionFailed: true }, { turnId: "turn", status, imageGenerations: [] }, f.session, f.connector, f.signal);
      if (parts[0]!.payload.kind !== "text") assert.fail("expected text");
      assert.ok(parts[0]!.payload.text.startsWith(text)); assert.match(parts[0]!.payload.text, /It was not sent again/);
    }
  } finally { await f.close(); }
});

test("long Unicode text respects the provider bound without splitting surrogate pairs", async () => {
  const f = await fixture();
  try {
    const text = "😀".repeat(20000);
    const parts = await f.files.delivery(f.route, f.work, { turnId: "turn", status: "completed", finalText: text, imageGenerations: [] }, f.session, f.connector, f.signal);
    const chunks = parts.map((part) => { if (part.payload.kind !== "text") assert.fail("expected text"); return part.payload.text; });
    assert.equal(chunks.join(""), text); assert.ok(chunks.every((chunk) => chunk.length < 18996 && Buffer.from(chunk).toString("utf8") === chunk));
  } finally { await f.close(); }
});

test("streamed copies preserve zero-byte and large opaque files and do not overwrite destinations", async () => {
  const f = await fixture();
  try {
    for (const size of [0, 32 * 1024 * 1024]) {
      const source = join(f.root, `source-${size}`); const destination = join(f.root, `copy-${size}`);
      const file = await open(source, "w", 0o600); await file.truncate(size); await file.close();
      await copyLocal(source, destination, f.signal);
      assert.equal((await inspectLocal(destination)).size, size); assert.equal(await hashFile(source), await hashFile(destination));
      await assert.rejects(copyLocal(source, destination, f.signal));
    }
  } finally { await f.close(); }
});

test("connector-limit artifacts are omitted before upload", async () => {
  const f = await fixture();
  try {
    const source = await open(join(f.publication, "large.bin"), "w", 0o600); await source.truncate(100000001); await source.close();
    const parts = await f.files.delivery(f.route, f.work, { turnId: "turn", status: "completed", imageGenerations: [] }, f.session, f.connector, f.signal);
    assert.equal(f.uploads.length, 0);
    if (parts[0]!.payload.kind !== "text") assert.fail("expected notice");
    assert.match(parts[0]!.payload.text, /connector limit/);
  } finally { await f.close(); }
});

test("inbound preparation streams bytes and preserves advertised-image mismatches as ordinary files", async (t) => {
  const f = await fixture();
  t.mock.method(globalThis, "fetch", async () => new Response("ordinary text", { headers: { "content-type": "image/png" } }));
  try {
    const now = Date.now();
    const batch: Batch = { sourceId: "sendblue:account", id: "batch", openedAtMs: now, quietDeadlineMs: now, maximumDeadlineMs: now, events: [{ messageHandle: "full-handle", providerTimeMs: now, receiptSequence: 0, text: "", attachment: { state: "pending", sourceUrl: "https://provider.example/media", name: "../../photo.png" } }] };
    const result = await f.files.prepareBatch(f.route, batch, f.session, f.signal);
    const attachment = result.events[0]!.attachment;
    if (attachment?.state !== "ready") assert.fail("attachment omitted");
    assert.equal(attachment.inputKind, "file"); assert.equal(attachment.name, ".._.._photo.png");
    assert.equal(await readFile(attachment.localPath, "utf8"), "ordinary text");
    assert.equal(await readFile(attachment.hostPath, "utf8"), "ordinary text");
    assert.equal("sourceUrl" in attachment, false);
  } finally { await f.close(); }
});

test("restart cleanup preserves active inputs and publications across routes until ownership transfers", async () => {
  const f = await fixture();
  try {
    const one = join(f.spool, "inbox", "one"); const two = join(f.spool, "inbox", "two");
    const hostOne = join(f.home, "codex-router-gateway/inbox/one"); const hostTwo = join(f.home, "codex-router-gateway/inbox/two");
    for (const path of [one, two, hostOne, hostTwo]) await writeFile(path, "input");
    const secondId = randomUUID(); const secondPublication = await f.files.publication(f.route, secondId, f.session, f.signal);
    const batch = (id: string, localPath: string, hostPath: string): Batch => ({ id, sourceId: "sendblue:account", openedAtMs: 0, quietDeadlineMs: 1, maximumDeadlineMs: 2, events: [{ messageHandle: id, providerTimeMs: 0, receiptSequence: 0, text: "", attachment: { state: "ready", name: "input", mediaType: "text/plain", inputKind: "file", localPath, hostPath } }] });
    const route = (work: CodexWork) => ({ binding: { sources: [{ kind: "sendblue" as const, id: "sendblue:account", accountId: "account", sender: "+15125550100", sendblueNumber: "+15125550200" }], target: { sshHost: null, threadId: "thread", cwd: f.root } }, nextSequence: 1, queue: [], receipts: [], active: work });
    const state: GatewayState = { version: 2, routes: {
      one: route({ ...f.work, batches: [batch("one", one, hostOne)] }),
      two: route({ ...f.work, publicationIds: [secondId], batches: [batch("two", two, hostTwo)] }),
    } };
    const restart = new GatewayFilePlane(f.spool); await restart.cleanup(state); await restart.reconcile(f.route, state, f.session, f.signal);
    for (const path of [one, two, hostOne, hostTwo, f.publication, secondPublication]) await lstat(path);
    const output = join(f.spool, "outbox", "frozen"); await writeFile(output, "output");
    state.routes.one!.active = { kind: "delivery", sourceId: "sendblue:account", id: "frozen", batchIds: ["one"], parts: [{ id: "part", status: "ready", payload: { kind: "media", localPath: output, name: "output", mediaType: "text/plain", mediaUrl: "https://cdn.example/frozen" } }] };
    const afterFreeze = new GatewayFilePlane(f.spool); await afterFreeze.cleanup(state); await afterFreeze.reconcile(f.route, state, f.session, f.signal);
    for (const path of [one, hostOne, f.publication]) await assert.rejects(lstat(path));
    for (const path of [two, hostTwo, secondPublication, output]) await lstat(path);
  } finally { await f.close(); }
});

test("local spool write failures block artifact preparation instead of becoming omissions", async () => {
  const { chmod } = await import("node:fs/promises"); const f = await fixture();
  try {
    await writeFile(join(f.publication, "output.txt"), "output"); await chmod(join(f.spool, "outbox"), 0o500);
    await assert.rejects(f.files.delivery(f.route, f.work, { turnId: "turn", status: "completed", imageGenerations: [] }, f.session, f.connector, f.signal),
      (error: unknown) => (error as { code?: string }).code === "storage_failed");
    assert.equal(f.uploads.length, 0); assert.equal(await readFile(join(f.publication, "output.txt"), "utf8"), "output");
  } finally { await chmod(join(f.spool, "outbox"), 0o700); await f.close(); }
});

test("a source change during a streamed copy rejects the output", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "changing"); const destination = join(f.root, "destination");
    const fd = await open(source, "w", 0o600); await fd.truncate(128 * 1024 * 1024); await fd.close();
    const copy = copyLocal(source, destination, f.signal);
    const rejected = assert.rejects(copy, /changing_file/);
    for (let i = 0; i < 200; i++) {
      if ((await readdir(f.root)).some((name) => name.startsWith("destination.part-"))) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const changed = await open(source, "r+"); await changed.write(Buffer.from("changed"), 0, 7, 0); await changed.close();
    // Some filesystems reuse one timestamp tick for consecutive writes.
    const changedTime = new Date(Date.now() + 1000);
    await utimes(source, changedTime, changedTime);
    await rejected; await assert.rejects(lstat(destination));
  } finally { await f.close(); }
});

test("native multipart streams exact file bytes with fs.openAsBlob", async () => {
  const { openAsBlob } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { Readable } = await import("node:stream");
  const f = await fixture();
  const expected = Buffer.alloc(1024 * 1024, 0xab);
  const path = join(f.root, "multipart.bin"); await writeFile(path, expected);
  let received = false;
  let failure: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      const parsed = new Request("http://localhost/upload", {
        method: "POST", headers: { "content-type": request.headers["content-type"]! },
        body: Readable.toWeb(request), duplex: "half",
      } as RequestInit);
      const form = await parsed.formData(); const file = form.get("file") as File;
      assert.equal(file.name, "multipart.bin"); assert.equal(file.type, "application/octet-stream");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), expected);
      received = true; response.end("ok");
    })().catch((error) => { failure = error; response.statusCode = 500; response.end(); });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const data = new FormData(); data.set("file", await openAsBlob(path, { type: "application/octet-stream" }), "multipart.bin");
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/upload`, { method: "POST", body: data });
    assert.equal(await response.text(), "ok"); assert.equal(failure, undefined); assert.equal(received, true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.close(); }
});

test("missing or unsafe publication preserves text and native artifacts", async () => {
  for (const replacement of ["missing", "symlink"]) {
    const f = await fixture();
    try {
      await rm(f.publication, { recursive: true });
      if (replacement === "symlink") await symlink(f.root, f.publication);
      const native = join(f.root, "native.png"); await writeFile(native, PNG);
      const parts = await f.files.delivery(f.route, f.work, { turnId: "turn", status: "completed", finalText: "Answer", imageGenerations: [{ id: "native", savedPath: native }] }, f.session, f.connector, f.signal);
      assert.equal(parts.length, 2);
      assert.equal(parts[0]!.payload.kind, "text");
      if (parts[0]!.payload.kind === "text") assert.match(parts[0]!.payload.text, /^Answer\n\nFiles omitted:/);
      assert.equal(parts[1]!.payload.kind, "media");
      assert.deepEqual(await readFile(native), PNG);
    } finally { await f.close(); }
  }
});


test("release cleans publication files after its execution session closes", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.publication, "result.txt"), "ready");
    f.session.filesystem = async () => { throw new Error("session is closed"); };
    await f.files.release(f.route, f.work, f.session);
    await assert.rejects(lstat(f.publication), { code: "ENOENT" });
    await f.files.release(f.route, f.work, f.session);
  } finally { await f.close(); }
});

test("release refuses publication symlinks without deleting their target", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside");
    await mkdir(outside); await writeFile(join(outside, "keep.txt"), "keep");
    await rm(f.publication, { recursive: true }); await symlink(outside, f.publication);
    await assert.rejects(f.files.release(f.route, f.work, f.session));
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
  } finally { await f.close(); }
});


test("concurrent reconciliation shares a failure and a healthy retry preserves retained publications", async () => {
  const f = await fixture();
  try {
    const files = new GatewayFilePlane(f.spool);
    let rejectRequest!: (error: Error) => void; let failedCalls = 0;
    const failedSession: GatewaySession = { ...f.session, filesystem: async () => {
      failedCalls++; return new Promise((_resolve, reject) => { rejectRequest = reject; });
    } };
    const state: GatewayState = { version: 2, routes: { route: {
      binding: { sources: [{ kind: "sendblue", id: "sendblue:account", accountId: "account", sender: f.route.sender!, sendblueNumber: f.route.sendblueNumber! }],
        target: { sshHost: null, threadId: f.route.agent.threadId, cwd: f.route.agent.cwd } },
      nextSequence: 0, receipts: [], queue: [], active: f.work,
    } } };
    const first = files.reconcile(f.route, state, failedSession, f.signal);
    const concurrent = files.reconcile(f.route, state, f.session, f.signal);
    assert.equal(first, concurrent);
    const checks = [assert.rejects(first, { code: "app_server_disconnected" }), assert.rejects(concurrent, { code: "app_server_disconnected" })];
    while (!rejectRequest) await new Promise(resolve => setImmediate(resolve));
    rejectRequest(new RouterError("app_server_disconnected", "transient setup failure"));
    await Promise.all(checks); assert.equal(failedCalls, 1);
    await writeFile(join(f.publication, "retained.txt"), "retained");
    await files.reconcile(f.route, state, f.session, f.signal);
    assert.equal(await readFile(join(f.publication, "retained.txt"), "utf8"), "retained");
    // A successful reconciliation remains cached, including across sessions.
    await files.reconcile(f.route, state, failedSession, f.signal);
    assert.equal(failedCalls, 1);
  } finally { await f.close(); }
});
