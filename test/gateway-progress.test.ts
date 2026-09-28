import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { encodeProgressFrames, ProgressHub, writeProgressStream, type ProgressFrame, type ProgressSubscription } from "../src/http-progress.js";

function body(frame: ProgressFrame) { return JSON.parse(frame.data.split("\ndata: ")[1]!.trim()) as { message_id: string; part: number; end: boolean; field: string; text: string }; }
function collect(sub: ProgressSubscription): ProgressFrame[] {
  const result: ProgressFrame[] = [];
  for (let i = 0; i < 2000; i++) { const frame = sub.read(); if (!frame) return result; result.push(frame); }
  throw new Error("Unbounded read loop");
}
const snapshot = () => ({ status: { status: "running" } });
const message = (id: string, text = "message") => ({ id, kind: "commentary" as const, text });

test("maximum escaped and Unicode text reconstructs exactly within encoded SSE bounds", () => {
  for (const text of ["\u0000".repeat(256 * 1024), "😀é\\\n\"".repeat(20_000)]) {
    const frames = encodeProgressFrames("epoch", 13, "terminal", { id: "final", text, metadata: { status: "completed", notices: "x".repeat(9000) } });
    assert.ok(frames.length > 1);
    assert.ok(frames.every((frame) => Buffer.byteLength(frame.data) <= 4096));
    assert.equal(frames.filter((frame) => body(frame).field === "text").map((frame) => body(frame).text).join(""), text);
    assert.equal(JSON.parse(frames.filter((frame) => body(frame).field === "metadata").map((frame) => body(frame).text).join("")).status, "completed");
    assert.equal(frames.filter((frame) => frame.end).length, 1);
    assert.equal(frames.at(-1)!.end, true);
  }
});

test("native identity dedup preserves distinct messages with identical text", () => {
  const hub = new ProgressHub();
  assert.equal(hub.publish("a", message("one")), true);
  assert.equal(hub.publish("a", message("one")), false);
  hub.publish("a", message("two"));
  const sub = hub.subscribe("a", { snapshot }, () => { throw new Error("observer"); });
  assert.deepEqual(collect(sub).filter((f) => f.event === "commentary").map((f) => body(f).message_id), ["one", "two"]);
  assert.doesNotThrow(() => hub.publish("a", message("three")));
  sub.close(); hub.close();
});

test("reconnect mid-message resumes the exact next deterministic frame", () => {
  const hub = new ProgressHub(); hub.publish("a", message("one", "😀".repeat(10_000)));
  const first = hub.subscribe("a", { snapshot }, () => {});
  const frame = first.read()!; first.close();
  const resumed = hub.subscribe("a", { snapshot, cursor: frame.id }, () => {});
  const rest = collect(resumed).filter((f) => f.event === "commentary");
  assert.equal(body(rest[0]!).part, 1);
  assert.equal([frame, ...rest].map((f) => body(f).text).join(""), "😀".repeat(10_000));
  hub.close();
});

test("subscription watermark places captured status before later live messages", () => {
  const hub = new ProgressHub(); hub.publish("a", message("old"));
  const sub = hub.subscribe("a", { snapshot }, () => {});
  hub.publish("a", message("new"));
  assert.deepEqual(collect(sub).map((f) => f.event), ["commentary", "status", "commentary"]);
  hub.close();
});

test("eviction mid-message resets rather than silently dropping its remaining parts", () => {
  const hub = new ProgressHub({ requestMessages: 1 }); hub.publish("a", message("old", "x".repeat(10_000)));
  const sub = hub.subscribe("a", { snapshot }, () => {});
  assert.equal(sub.read()!.event, "commentary");
  hub.publish("a", message("new"));
  const frames = collect(sub);
  assert.equal(frames[0]!.event, "reset");
  assert.equal(frames[1]!.event, "status");
  assert.deepEqual(frames.filter((f) => f.event === "commentary").map((f) => body(f).message_id), ["new"]);
  hub.close();
});

test("identity reset and process restart regenerate only the durable terminal", () => {
  const hub = new ProgressHub(); hub.publish("a", message("old"));
  const sub = hub.subscribe("a", { snapshot }, () => {});
  const cursor = sub.read()!.id; hub.reset("a");
  assert.equal(sub.read()!.event, "reset"); hub.close();
  const next = new ProgressHub();
  const terminal = { id: "request", kind: "terminal" as const, text: "durable answer", metadata: { status: "completed" } };
  const reconnect = next.subscribe("a", { cursor, snapshot: () => ({ status: { status: "completed" }, terminal }) }, () => {});
  const frames = collect(reconnect);
  assert.equal(frames[0]!.event, "reset");
  assert.equal(frames.filter((f) => f.event === "terminal" && body(f).field === "text").map((f) => body(f).text).join(""), "durable answer");
  next.close();
});

test("durable commit after subscription is visible without a terminal publication", () => {
  const hub = new ProgressHub();
  let terminal: { id: string; kind: "terminal"; text: string } | undefined;
  const sub = hub.subscribe("a", { snapshot: () => ({ status: { status: terminal ? "completed" : "running" }, ...(terminal ? { terminal } : {}) }) }, () => {});
  collect(sub);
  terminal = { id: "final", kind: "terminal", text: "persisted" }; hub.notify("a");
  assert.equal(collect(sub).filter((f) => f.event === "terminal").map((f) => body(f).text).join(""), "persisted");
  hub.close();
});

test("global eviction bounds bytes and idle request map cardinality", () => {
  const hub = new ProgressHub({ globalBytes: 4096, requestBytes: 2048 });
  for (let i = 0; i < 200; i++) hub.publish(String(i), message("item", "x".repeat(300)));
  assert.ok(hub.retainedBytes <= 4096);
  assert.ok(hub.requestCount < 20);
  hub.close(); assert.equal(hub.retainedBytes, 0);
});

class Response extends EventEmitter {
  writableLength = 0;
  writes: string[] = [];
  ended = false;
  destroyed = false;
  accept = true;
  writeHead() { return this; }
  flushHeaders() {}
  write(text: string) { this.writes.push(text); return this.accept; }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function stream(hub: ProgressHub, response: Response, key = "a", account = "account", getSnapshot = snapshot) {
  return writeProgressStream({ hub, response: response as unknown as ServerResponse, requestKey: key, accountId: account, snapshot: getSnapshot });
}

test("stream backpressure stops reads and resumes after drain without private queues", async () => {
  const hub = new ProgressHub(); hub.publish("a", message("a", "x".repeat(20_000)));
  const response = new Response(); response.accept = false;
  assert.equal(stream(hub, response), true); await tick();
  assert.equal(response.writes.length, 1);
  await tick(); assert.equal(response.writes.length, 1);
  response.accept = true; response.emit("drain"); await tick();
  assert.ok(response.writes.length > 2); hub.close();
  assert.equal(response.destroyed, true);
});

test("slow stream timeout closes it, returns account capacity, and does not affect another stream", async () => {
  const hub = new ProgressHub({ accountStreams: 1, drainTimeoutMs: 10 });
  const slow = new Response(); slow.accept = false;
  const other = new Response();
  assert.equal(stream(hub, slow), true);
  assert.equal(stream(hub, new Response()), false);
  assert.equal(stream(hub, other, "b", "other"), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(slow.destroyed, true); assert.equal(other.destroyed, false);
  assert.equal(stream(hub, new Response()), true); hub.close();
});

test("terminal closes only after its final blocked frame drains", async () => {
  const hub = new ProgressHub(); const response = new Response();
  const terminal = { id: "final", kind: "terminal" as const, text: "answer" };
  stream(hub, response, "a", "account", () => ({ status: { status: "completed" }, terminal }));
  const original = response.write.bind(response);
  response.write = (data) => { original(data); return !data.includes("event: terminal"); };
  await tick(); assert.equal(response.ended, false);
  response.emit("drain"); await tick(); assert.equal(response.ended, true);
  hub.close();
});

test("malformed cursor resets and controls do not overwrite the last consumed event ID", () => {
  const hub = new ProgressHub(); hub.publish("a", message("one"));
  const sub = hub.subscribe("a", { snapshot, cursor: "not-a-cursor" }, () => {});
  const frames = collect(sub);
  assert.equal(frames[0]!.event, "reset");
  for (const frame of frames.filter((f) => f.event === "reset" || f.event === "status")) assert.equal(frame.data.includes("id: "), false);
  hub.close();
});

test("invalid publications cannot accumulate empty request maps", () => {
  const hub = new ProgressHub();
  for (let i = 0; i < 100; i++) assert.throws(() => hub.publish(String(i), message("id", "x".repeat(256 * 1024 + 1))));
  assert.equal(hub.requestCount, 0); assert.equal(hub.retainedBytes, 0); hub.close();
});

test("global stream cap applies across accounts and writable overflow closes just that stream", async () => {
  const hub = new ProgressHub({ globalStreams: 2, writableBytes: 100 });
  const first = new Response(); first.writableLength = 101;
  const second = new Response();
  assert.equal(stream(hub, first), true);
  assert.equal(stream(hub, second, "b", "other"), true);
  assert.equal(stream(hub, new Response(), "c", "third"), false);
  await tick();
  assert.equal(first.destroyed, true); assert.equal(second.destroyed, false);
  assert.equal(stream(hub, new Response(), "c", "third"), true);
  hub.close();
});

test("heartbeat comments do not consume message cursor or duplicate progress", async () => {
  const hub = new ProgressHub({ heartbeatMs: 5 }); const response = new Response();
  stream(hub, response);
  await new Promise((resolve) => setTimeout(resolve, 18));
  assert.ok(response.writes.some((text) => text === ": heartbeat\n\n"));
  assert.equal(response.writes.filter((text) => text.includes("event: status")).length, 1);
  hub.close();
});


test("heartbeat refreshes changed commentary capability without a progress publication", async () => {
  const hub = new ProgressHub({ heartbeatMs: 5 });
  const response = new Response();
  let capability = "not_observed";
  stream(hub, response, "a", "account", () => ({ status: { status: "running", commentary: capability } }));
  await tick();
  assert.equal(response.writes.filter((text) => text.includes("event: status")).length, 1);
  capability = "unavailable";
  await new Promise((resolve) => setTimeout(resolve, 30));
  await tick();
  const statuses = response.writes.filter((text) => text.includes("event: status"));
  assert.equal(statuses.length, 2, "unchanged heartbeats must not duplicate status");
  const data = JSON.parse(statuses[1]!.split("\ndata: ")[1]!.trim());
  assert.equal(JSON.parse(data.text).commentary, "unavailable");
  assert.equal(response.writes.some((text) => text.includes("event: commentary") || text.includes("event: terminal")), false);
  hub.close();
});
