import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopCommentary } from "../src/desktop-commentary.js";
const meta = JSON.stringify({ type: "session_meta", payload: { id: "thread", history_mode: "paginated" } }) + "\n";
const item = (id: string, text = "same") => ({ id, type: "agentMessage", phase: "commentary", text });
const completed = (id: string, text = "same", turn = "turn") => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", thread_id: "thread", turn_id: turn, item: { type: "AgentMessage", id, phase: "commentary", content: [{ type: "Text", text }] } } }) + "\n";
async function fixture(run: (reader: DesktopCommentary, path: string) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "commentary-"))); const path = join(dir, "rollout.jsonl");
  await writeFile(path, meta);
  try { await run(new DesktopCommentary("thread"), path); } finally { await rm(dir, { recursive: true, force: true }); }
}
test("Desktop commentary requires authoritative completion and matching snapshot text", async () => fixture(async (reader, path) => {
  assert.deepEqual(await reader.poll(path, "turn", [item("one")]), []);
  await appendFile(path, completed("one"));
  assert.deepEqual(await reader.poll(path, "turn", [item("one", "draft")]), []);
  assert.deepEqual(await reader.poll(path, "turn", [item("one")]), [{ itemId: "one", text: "same" }]);
  assert.deepEqual(await reader.poll(path, "turn", [item("one")]), []);
  await appendFile(path, completed("two"));
  assert.deepEqual(await reader.poll(path, "turn", [item("one"), item("two")]), [{ itemId: "two", text: "same" }]);
}));
test("Desktop partial records and split UTF8 wait for the full completed record", async () => fixture(async (reader, path) => {
  const row = Buffer.from(completed("one", "a🙂b")); const split = row.indexOf(Buffer.from("🙂")) + 2;
  await appendFile(path, row.subarray(0, split));
  assert.deepEqual(await reader.poll(path, "turn", [item("one", "a🙂b")]), []);
  await appendFile(path, row.subarray(split));
  assert.deepEqual(await reader.poll(path, "turn", [item("one", "a🙂b")]), [{ itemId: "one", text: "a🙂b" }]);
}));
test("Desktop completion excludes other turns and items outside the admitted snapshot boundary", async () => fixture(async (reader, path) => {
  await appendFile(path, completed("old") + completed("other", "same", "elsewhere") + completed("new"));
  assert.deepEqual(await reader.poll(path, "turn", [item("other"), item("new")]), [{ itemId: "new", text: "same" }]);
}));
test("Desktop reader reports unsupported history and revalidates replaced session identity", async () => fixture(async (reader, path) => {
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: "thread", history_mode: "legacy" } }) + "\n");
  assert.deepEqual(await reader.poll(path, "turn", []), []);
  assert.equal(reader.status.reason, "unsupported_history_mode");
  await writeFile(path, meta + completed("one"));
  assert.equal((await reader.poll(path, "turn", [item("one")])).length, 1);
  await rm(path); await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: "wrong", history_mode: "paginated" } }) + "\n");
  assert.deepEqual(await reader.poll(path, "turn", [item("two")]), []);
  assert.equal(reader.status.reason, "rollout_identity_mismatch");
}));
