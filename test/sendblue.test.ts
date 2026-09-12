import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sendblue, retryPolicy } from "../src/sendblue.js";
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

test("Sendblue sends exact text, media-only, and typing payloads without extra physical requests", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const connector = new Sendblue(credentials, { fetch: async (url, init) => {
    calls.push({ url: String(url), init: init! }); return Response.json({ message_handle: "accepted" });
  } });
  assert.deepEqual(await connector.send(route, { id: "part", status: "ready", payload: { kind: "text", text: "hi" } }, "https://callback.test", signal), { status: "accepted", providerHandle: "accepted" });
  await connector.send(route, { id: "part2", status: "ready", payload: { kind: "media", localPath: "/private/file", name: "file", mediaType: "application/pdf", mediaUrl: "https://cdn.test/file" } }, "https://callback.test/2", signal);
  await connector.typing(route, "start", signal); await connector.typing(route, "stop", signal);
  assert.equal(calls.length, 4);
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { number: route.sender, from_number: route.sendblueNumber, status_callback: "https://callback.test", content: "hi" });
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { number: route.sender, from_number: route.sendblueNumber, status_callback: "https://callback.test/2", media_url: "https://cdn.test/file" });
  assert.deepEqual(JSON.parse(calls[2]!.init.body as string), { number: route.sender, from_number: route.sendblueNumber, state: "start", max_duration_ms: 300000 });
  assert.equal(JSON.parse(calls[3]!.init.body as string).max_duration_ms, undefined);
  assert.equal(new Headers(calls[0]!.init.headers).get("sb-api-secret-key"), "secret");
  assert.equal(calls[0]!.init.redirect, "error");
});

test("Sendblue classifies rejection, uncertainty, malformed success, and retry overrides", async () => {
  const part = { id: "p", status: "ready" as const, payload: { kind: "text" as const, text: "hi" } };
  for (const [code, override, status, retryable] of [[400, "", "rejected", false], [429, "", "uncertain", true], [503, "false", "uncertain", false], [400, "true", "uncertain", true], [200, "", "uncertain", false]] as const) {
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
    assert.deepEqual(await connector.send(route, { id: "p", status: "ready", payload: { kind: "text", text: "hello" } }, "https://callback.test", signal), { status: "uncertain", retryable: true });
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
