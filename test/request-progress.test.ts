import assert from "node:assert/strict";
import test from "node:test";
import { RequestProgress } from "../src/request-progress.js";
import { ProgressHub } from "../src/http-progress.js";

test("semantic consumers receive summaries without HTTP and cannot mutate shared replay", () => {
  const progress = new RequestProgress();
  const first = progress.watch("request", () => { throw new Error("broken consumer"); });
  let signals = 0;
  const second = progress.watch("request", () => { signals++; });
  const summary = { id: "summary", kind: "reasoning" as const, text: "Published summary", metadata: { status: "working" } };
  assert.doesNotThrow(() => progress.publish("request", summary));
  summary.text = "changed";
  assert.equal(second.view.entries[0]!.message.text, "Published summary");
  assert.equal(signals, 1);
  assert.throws(() => { first.view.entries[0]!.message.text = "changed by observer"; });
  progress.reset("request");
  assert.equal(signals, 2); assert.equal(second.view.entries.length, 0);
  first.close(); second.close(); progress.close();
});

test("pinned empty states and subscriptions stay within independent bounds", () => {
  const progress = new RequestProgress({ globalBytes: 256, subscriptions: 2 });
  const first = progress.watch("one", () => {});
  assert.throws(() => progress.watch("two", () => {}), /capacity/);
  const second = progress.watch("one", () => {});
  assert.throws(() => progress.watch("one", () => {}), /capacity/);
  assert.equal(progress.retainedBytes, 256);
  first.close(); assert.equal(progress.retainedBytes, 256);
  second.close(); assert.equal(progress.retainedBytes, 0);
  progress.watch("two", () => {}).close(); progress.close();
});

test("HTTP presentation has a bounded cache and cannot close a borrowed semantic source", () => {
  const progress = new RequestProgress();
  const http = new ProgressHub({ encodedCacheBytes: 1024 }, progress);
  for (let i = 0; i < 10; i++) {
    progress.publish("request", { id: String(i), kind: "commentary", text: "x".repeat(2000) });
    const sub = http.subscribe("request", { snapshot: () => ({ status: {} }) }, () => {});
    while (sub.read()) {}
    sub.close();
    assert.ok(http.encodedBytes <= 1024);
  }
  http.close();
  assert.equal(http.encodedBytes, 0);
  assert.doesNotThrow(() => progress.publish("request", { id: "still-open", kind: "commentary", text: "ok" }));
  progress.close();
});

test("escaped identities and maximum text stream incrementally with exact reconnect", { timeout: 10000 }, () => {
  const progress = new RequestProgress();
  const http = new ProgressHub({}, progress);
  const message = { id: "\u0001".repeat(512), kind: "commentary" as const, text: "\u0001".repeat(256 * 1024) };
  progress.publish("large", message);
  const snapshot = () => ({ status: {} });
  let sub = http.subscribe("large", { snapshot }, () => {});
  let text = "", count = 0, cursor: string | undefined;
  const consume = (value: NonNullable<ReturnType<typeof sub.read>>) => {
    assert.ok(Buffer.byteLength(value.data) <= 4096);
    if (value.event !== "commentary") return;
    const data = JSON.parse(value.data.split("\ndata: ")[1]!.trim());
    assert.equal(data.message_id, message.id);
    assert.equal(data.part, count++);
    text += data.text; cursor = value.id;
    assert.ok(http.encodedBytes <= 2 * 1024 * 1024);
  };
  while (count < 10) consume(sub.read()!);
  sub.close();
  sub = http.subscribe("large", { snapshot, cursor: cursor! }, () => {});
  let value;
  while ((value = sub.read())) consume(value);
  assert.equal(text, message.text);
  assert.ok(count > 1000, "adversarial escaping must exercise many transport parts");
  assert.ok(http.encodedBytes < 64 * 1024, "cache stores boundaries, not megabytes of escaped frames");
  sub.close(); http.close(); progress.close();
});

test("an index larger than an explicit tiny presentation budget fails once without caching", () => {
  const progress = new RequestProgress();
  const http = new ProgressHub({ encodedCacheBytes: 1 }, progress);
  progress.publish("request", { id: "id", kind: "commentary", text: "text" });
  const sub = http.subscribe("request", { snapshot: () => ({ status: {} }) }, () => {});
  assert.throws(() => sub.read(), /frame index exceeds presentation budget/);
  assert.equal(http.encodedBytes, 0);
  sub.close(); http.close(); progress.close();
});
