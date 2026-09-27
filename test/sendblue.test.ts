import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { Sendblue, SendblueRequestError, retryPolicy, sendblueCredentials } from "../src/sendblue.js";
import type { GatewayRoute } from "../src/config.js";

const route = { sender: "+15555550001", sendblueNumber: "+15555550002" } as GatewayRoute;
const credentials = { apiKeyId: "key", apiSecretKey: "secret", signingSecret: "sign" };
const signal = new AbortController().signal;
const event = { is_outbound: false, status: "RECEIVED", from_number: route.sender, sendblue_number: route.sendblueNumber,
  date_sent: "2026-09-12T12:00:00Z", message_handle: "full.handle.0", content: "hello", message_type: "message", group_id: "" };

test("Sendblue decodes inbound identity, ignores outbound and groups, and validates fields", () => {
  const connector = new Sendblue(credentials);
  assert.equal(connector.inbound(event)?.messageHandle, "full.handle.0");
  assert.equal(connector.inbound({ ...event, is_outbound: true }), undefined);
  assert.equal(connector.inbound({ ...event, status: "SENT" }), undefined);
  assert.equal(connector.inbound({ ...event, group_id: "group" }), undefined);
  assert.throws(() => connector.inbound({ ...event, date_sent: "bad" }));
  assert.throws(() => connector.inbound({ ...event, media_url: "http://example.com/file" }));
  assert.equal(connector.inbound({ ...event, media_url: "https://example.com/a%2Fb.pdf" })?.attachment?.name, "a_b.pdf");
  assert.deepEqual(connector.callback({ status: "DELIVERED", message_handle: "whole.1" }), { status: "DELIVERED", providerHandle: "whole.1" });
});

test("Sendblue sends exact text, media-only, typing, and read-receipt payloads without extra physical requests", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const connector = new Sendblue(credentials, { fetch: async (url, init) => {
    calls.push({ url: String(url), init: init! }); return Response.json({ message_handle: "accepted" });
  } });
  assert.deepEqual(await connector.send(route, { id: "part", status: "ready", payload: { kind: "text", text: "hi" } }, "https://callback.test", signal), { status: "accepted", providerHandle: "accepted" });
  await connector.send(route, { id: "part2", status: "ready", payload: { kind: "media", localPath: "/private/file", name: "file", mediaType: "application/pdf", mediaUrl: "https://cdn.test/file" } }, "https://callback.test/2", signal);
  await connector.typing(route, "start", signal); await connector.typing(route, "stop", signal);
  await connector.readReceipt(route, signal);
  assert.equal(calls.length, 5);
  assert.equal(calls[4]!.url, "https://api.sendblue.com/api/mark-read");
  assert.deepEqual(JSON.parse(calls[4]!.init.body as string), { number: route.sender, from_number: route.sendblueNumber });
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { number: route.sender, from_number: route.sendblueNumber, status_callback: "https://callback.test", content: "hi" });
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { number: route.sender, from_number: route.sendblueNumber, status_callback: "https://callback.test/2", media_url: "https://cdn.test/file" });
  assert.deepEqual(JSON.parse(calls[2]!.init.body as string), { number: route.sender, from_number: route.sendblueNumber, state: "start", max_duration_ms: 300000 });
  assert.equal(JSON.parse(calls[3]!.init.body as string).max_duration_ms, undefined);
  assert.equal(new Headers(calls[0]!.init.headers).get("sb-api-secret-key"), "secret");
  assert.equal(calls[0]!.init.redirect, "error");
});

test("Sendblue classifies rejection, uncertainty, malformed success, and retry overrides", async () => {
  const part = { id: "p", status: "ready" as const, payload: { kind: "text" as const, text: "hi" } };
  for (const [code, override, status, retryable] of [[400, "", "rejected", false], [429, "", "rejected", true], [503, "false", "uncertain", false], [400, "true", "rejected", true], [200, "", "uncertain", false]] as const) {
    let count = 0;
    const connector = new Sendblue(credentials, { fetch: async () => { count++; return new Response("bad", { status: code, headers: { "x-should-retry": override } }); } });
    assert.deepEqual(await connector.send(route, part, "https://callback.test", signal), { status, retryable });
    assert.equal(count, 1);
  }
  assert.deepEqual(retryPolicy(429, new Headers({ "retry-after-ms": "125", "retry-after": "2" })), { retryable: true, retryAfterMs: 125 });
  assert.equal(retryPolicy(429, new Headers({ "retry-after": "2" })).retryAfterMs, 2000);
  assert.equal(retryPolicy(429, new Headers({ "retry-after": "Sat, 12 Sep 2026 12:00:02 GMT" }), Date.parse(event.date_sent)).retryAfterMs, 2000);
});

test("Sendblue uploads reopen binary multipart for retries and honor the retry cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sendblue-"));
  const lifetime = setInterval(() => undefined, 1000);
  try {
    const path = join(directory, "binary"); const bytes = Buffer.from([0, 255, 1, 128]); await writeFile(path, bytes);
    let calls = 0;
    const connector = new Sendblue(credentials, { fetch: async (_url, init) => {
      calls++;
      assert.equal(new Headers(init!.headers).has("content-type"), false);
      const file = (init!.body as FormData).get("file") as File;
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      return calls < 3 ? new Response("", { status: 503, headers: { "retry-after-ms": "0" } }) : Response.json({ media_url: "https://cdn.test/file" }, { status: 201 });
    } });
    assert.equal(await connector.upload(path, "report.pdf", "application/pdf", signal), "https://cdn.test/file"); assert.equal(calls, 3);
    calls = 0;
    const failing = new Sendblue(credentials, { fetch: async () => { calls++; return new Response("", { status: 503, headers: { "retry-after-ms": "0" } }); } });
    await assert.rejects(failing.upload(path, "file", "application/octet-stream", signal)); assert.equal(calls, 3);
  } finally { clearInterval(lifetime); await rm(directory, { recursive: true, force: true }); }
});

test("Sendblue deadline includes body consumption and cancellation drains the request", async () => {
  const lifetime = setInterval(() => undefined, 1000);
  let canceled = false;
  try {
    const connector = new Sendblue(credentials, { requestTimeoutMs: 10, fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener("abort", () => { canceled = true; controller.error(new Error("aborted")); }, { once: true }); },
    })) });
    assert.deepEqual(await connector.send(route, { id: "p", status: "ready", payload: { kind: "text", text: "hello" } }, "https://callback.test", signal), { status: "uncertain", retryable: false });
    assert.equal(canceled, true);
  } finally { clearInterval(lifetime); }
});

test("malformed upload success respects the provider no-retry override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sendblue-retry-"));
  try {
    const path = join(directory, "file"); await writeFile(path, "bytes"); let calls = 0;
    const connector = new Sendblue(credentials, { fetch: async () => { calls++; return Response.json({}, { status: 201, headers: { "x-should-retry": "false" } }); } });
    await assert.rejects(connector.upload(path, "file", "application/octet-stream", signal));
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("polling uses typed SDK filters and status lookup without requiring a webhook secret", async () => {
  const calls: URL[] = [];
  const connector = new Sendblue({ apiKeyId: "key", apiSecretKey: "secret" }, { fetch: async (url) => {
    const target = new URL(String(url)); calls.push(target);
    return Response.json(target.pathname === "/api/status" ? { message_handle: "known", status: "DELIVERED" }
      : { data: [event], pagination: { offset: 50, limit: 50, hasMore: false, total: 51 } });
  } });
  const query = { is_outbound: "false" as const, sendblue_number: route.sendblueNumber!, order_by: "updatedAt" as const,
    order_direction: "asc" as const, updated_at_gte: event.date_sent, updated_at_lte: "2026-09-13T12:00:00Z", offset: 50, limit: 50 };
  const page = await connector.list(query, signal);
  assert.equal(page.data?.[0]?.message_handle, event.message_handle);
  assert.equal(page.pagination?.hasMore, false);
  assert.equal(calls[0]!.pathname, "/api/v2/messages");
  for (const [key, value] of Object.entries(query)) assert.equal(calls[0]!.searchParams.get(key), String(value));
  assert.equal((await connector.getStatus("known", signal)).status, "DELIVERED");
  assert.equal(calls[1]!.searchParams.get("handle"), "known");
  const account = { id: "personal", apiKeyId: "key", apiSecretKey: "secret" };
  assert.deepEqual(sendblueCredentials(account), { apiKeyId: "key", apiSecretKey: "secret" });
  assert.throws(() => sendblueCredentials({ ...account, mode: "webhook" }));
});

test("poll-mode sends omit callbacks and SDK retries stay disabled after accepted-response loss", async () => {
  for (const mode of ["network", "server", "malformed"] as const) {
    let requests = 0;
    const connector = new Sendblue(credentials, { fetch: async (_url, init) => {
      requests++;
      assert.equal(Object.hasOwn(JSON.parse(init!.body as string), "status_callback"), false);
      if (mode === "network") throw new Error("socket lost after acceptance");
      if (mode === "server") return Response.json({ error: "private provider detail" }, { status: 503 });
      return new Response('{"message_handle":', { headers: { "content-type": "application/json" } });
    } });
    assert.deepEqual(await connector.send(route, { id: "part", status: "ready", payload: { kind: "text", text: "private reply" } }, undefined, signal),
      { status: "uncertain", retryable: false });
    assert.equal(requests, 1);
  }
});

test("list failures expose only bounded retry metadata and never SDK debug logs", async () => {
  const prior = process.env.SENDBLUE_API_LOG;
  const methods = ["debug", "info", "warn", "error", "log"] as const;
  const originals = methods.map(method => console[method]);
  const logs: unknown[] = [];
  process.env.SENDBLUE_API_LOG = "debug";
  methods.forEach(method => { console[method] = (...args: unknown[]) => { logs.push(args); }; });
  try {
    let calls = 0;
    const connector = new Sendblue(credentials, { fetch: async () => { calls++; return Response.json({ error: "private-content-secret" },
      { status: 429, headers: { "retry-after-ms": "1250" } }); } });
    await assert.rejects(connector.list({}, signal), (error: unknown) => {
      assert.ok(error instanceof SendblueRequestError);
      assert.equal(error.retryAfterMs, 1250); assert.equal(error.retryable, true);
      assert.equal(error.message, "The Sendblue request failed.");
      assert.equal(JSON.stringify(error).includes("private-content-secret"), false);
      return true;
    });
    assert.equal(calls, 1); assert.equal(logs.length, 0);
  } finally {
    methods.forEach((method, index) => { console[method] = originals[index]!; });
    if (prior === undefined) delete process.env.SENDBLUE_API_LOG; else process.env.SENDBLUE_API_LOG = prior;
  }
});

test("SDK response caps cancel oversized send and list bodies", async () => {
  for (const kind of ["send", "list"] as const) {
    let canceled = false, calls = 0;
    const limit = kind === "send" ? 256 * 1024 : 2 * 1024 * 1024;
    const connector = new Sendblue(credentials, { fetch: async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(limit + 1)); },
        cancel() { canceled = true; },
      }), { headers: { "content-type": "application/json" } });
    } });
    if (kind === "send") assert.deepEqual(await connector.send(route, { id: "p", status: "ready", payload: { kind: "text", text: "test" } }, undefined, signal),
      { status: "uncertain", retryable: false });
    else await assert.rejects(connector.list({}, signal), SendblueRequestError);
    assert.equal(canceled, true); assert.equal(calls, 1);
  }
});

test("SDK cancellation prevents pre-aborted calls and cancels stalled list bodies", async () => {
  const already = new AbortController(); already.abort(); let calls = 0;
  const untouched = new Sendblue(credentials, { fetch: async () => { calls++; return Response.json({}); } });
  await assert.rejects(untouched.list({}, already.signal)); assert.equal(calls, 0);
  const lifetime = setInterval(() => undefined, 1000);
  try {
    let canceled = false;
    const connector = new Sendblue(credentials, { requestTimeoutMs: 10, fetch: async () => new Response(new ReadableStream({
      cancel() { canceled = true; },
    }), { headers: { "content-type": "application/json" } }) });
    await assert.rejects(connector.list({}, signal)); assert.equal(canceled, true);
    const stop = new AbortController(); let started!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    const explicit = new Sendblue(credentials, { fetch: async () => {
      started(); return new Response(new ReadableStream({ cancel() { canceled = true; } }));
    } });
    canceled = false;
    const pending = explicit.list({}, stop.signal); await starting; stop.abort();
    await assert.rejects(pending); assert.equal(canceled, true);
  } finally { clearInterval(lifetime); }
});

test("read and typing provider failures are surfaced without duplicate transport attempts", async () => {
  let calls = 0;
  const connector = new Sendblue(credentials, { fetch: async () => { calls++; return Response.json({ error: "failed" }, { status: 503 }); } });
  await assert.rejects(connector.readReceipt(route, signal), SendblueRequestError);
  await assert.rejects(connector.typing(route, "start", signal), SendblueRequestError);
  assert.equal(calls, 2);
});

test("SDK crosses real HTTP for local-file multipart and does not resend an accepted request with a lost response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sendblue-http-"));
  const bytes = Buffer.from([0, 255, 1, 128]);
  const uploadPath = join(directory, "file"); await writeFile(uploadPath, bytes);
  let sends = 0, uploads = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (request.url === "/api/upload-file") {
      uploads++;
      assert.match(request.headers["content-type"]!, /^multipart\/form-data; boundary=/);
      assert.equal(body.includes(bytes), true);
      assert.equal(body.includes(Buffer.from('filename="actual.bin"')), true);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ media_url: "https://cdn.test/actual.bin" }));
    } else {
      sends++;
      assert.equal(JSON.parse(body.toString()).content, "accepted once");
      // Simulate acceptance followed by a partial response and disconnected socket.
      response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      response.write('{"message_handle":');
      response.socket!.destroy();
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const connector = new Sendblue(credentials, { baseUrl: `http://127.0.0.1:${address.port}`, requestTimeoutMs: 1000 });
    assert.equal(await connector.upload(uploadPath, "actual.bin", "application/octet-stream", signal), "https://cdn.test/actual.bin");
    assert.deepEqual(await connector.send(route, { id: "p", status: "ready", payload: { kind: "text", text: "accepted once" } }, undefined, signal),
      { status: "uncertain", retryable: false });
    assert.equal(uploads, 1); assert.equal(sends, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a real stalled HTTP response body hits the adapter deadline and closes its connection", async () => {
  let closed!: () => void;
  const connectionClosed = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"data":[');
    response.on("close", closed);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const connector = new Sendblue(credentials, { baseUrl: `http://127.0.0.1:${address.port}`, requestTimeoutMs: 50 });
    const start = Date.now();
    await assert.rejects(connector.list({}, signal), SendblueRequestError);
    assert.ok(Date.now() - start < 2000);
    await Promise.race([connectionClosed, new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Deadline did not close socket")), 2000); timer.unref();
    })]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
