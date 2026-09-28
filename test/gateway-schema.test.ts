import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayStore, validateState, bindTargets, type GatewayState } from "../src/gateway-state.js";


function current(): GatewayState {
  const batch = (id: string) => ({ id, sourceId: "sendblue:phone", openedAtMs: 1, quietDeadlineMs: 2, maximumDeadlineMs: 3, events: [{ messageHandle: id, providerTimeMs: 1, receiptSequence: 1, text: id }] });
  return { version: 3, nextDeliverySequence: 1, routes: { route: { completions: {}, outbox: [], binding: { sources: [{ id: "sendblue:phone", namespace: "phone", destination: { id: "conversation", namespace: "phone", properties: { sender: "+15555550100" } } }], target: { sshHost: null, threadId: "thread", cwd: "/tmp" } }, nextSequence: 3,
    receipts: [{ namespace: "phone", sourceId: "sendblue:phone", externalId: "seen", receivedAtMs: Date.now() }], openBatch: batch("open"), queue: [batch("queued")],
    active: { kind: "codex", ownerBatchId: "accepted", joinedBatchIds: [], batches: [batch("accepted")], turnId: "turn", clientUserMessageId: "uuid", publicationIds: ["publication"], artifactBaseline: ["image"], pendingAdmission: { batchId: "accepted", clientUserMessageId: "uuid", publicationId: "publication" }, binding: { backend: "desktop", host: "local", codexHome: "/tmp/home", threadId: "thread" } },
  } } };
}
const config = [{ id: "route", binding: { ...current().routes.route!.binding, sources: [...current().routes.route!.binding.sources, { id: "http", namespace: "http" }] } }];

test("current state preserves pending identities and permits adding an unrelated source", () => {
  const original = current(); const state = validateState(original);
  assert.deepEqual(state, original);
  assert.doesNotThrow(() => bindTargets(state, config));
  assert.equal(state.routes.route!.binding.sources.length, 2);
  assert.deepEqual(state.routes.route!.active, original.routes.route!.active);
  assert.deepEqual(state.routes.route!.receipts, original.routes.route!.receipts);
  const changed = structuredClone(config); changed[0]!.binding.sources[0]!.destination!.properties.sender = "+15555550300";
  assert.throws(() => bindTargets(state, changed), { code: "config_invalid" });
});

test("current schema preserves uncertain delivery callback identity and accepted handles", () => {
  const state = current(); delete state.routes.route!.active; state.routes.route!.completions.completion = { id: "completion", result: {status: "completed", text: "reply", notices: []}, artifacts: [], expiresAtMs: 0 }; state.routes.route!.outbox.push({ destination: state.routes.route!.binding.sources[0]!.destination!, completionId: "completion", sequence: 0, prepared: true, reservedBytes: 2097152, kind: "delivery", sourceId: "sendblue:phone", id: "delivery", batchIds: ["accepted"], parts: [
    { id: "sent", status: "accepted", providerHandle: "provider", payload: { kind: "text", text: "sent" } },
    { id: "uncertain", status: "sending", callbackToken: "callback", payload: { kind: "text", text: "pending" } },
  ] });
  const validated = validateState(state).routes.route!.outbox[0]!;
  assert.equal(validated.kind, "delivery"); if (validated.kind !== "delivery") assert.fail();
  assert.equal(validated.sourceId, "sendblue:phone"); assert.deepEqual(validated.parts, state.routes.route!.outbox[0]!.parts);
});

test("opening current state preserves receipts and pending work across a transaction and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-schema-"));
  const path = join(dir, "state.json"); const original = current(); const data = JSON.stringify(original);
  try {
    await writeFile(path, data, { mode: 0o600 });
    const store = await GatewayStore.open(dir);
    try {
      assert.deepEqual(store.snapshot(), original);
      assert.equal(await readFile(path, "utf8"), data);
      await store.transaction(() => undefined);
    } finally { await store.close(); }
    const reopened = await GatewayStore.open(dir);
    try { assert.deepEqual(reopened.snapshot(), original); } finally { await reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unsupported schema and missing source identities are rejected without rewriting state", async () => {
  const original = current();
  const variants = [
    { ...original, version: 1 },
    { ...original, version: 2 },
    { ...original, routes: { route: { ...original.routes.route, receipts: undefined } } },
    { ...original, routes: { route: { ...original.routes.route, binding: { ...original.routes.route!.binding, sources: undefined } } } },
    { ...original, routes: { route: { ...original.routes.route, openBatch: { ...original.routes.route!.openBatch, sourceId: undefined } } } },
  ];
  const dir = await mkdtemp(join(tmpdir(), "router-schema-invalid-")); const path = join(dir, "state.json");
  try {
    for (const invalid of variants) {
      const data = JSON.stringify(invalid); await writeFile(path, data, { mode: 0o600 });
      await assert.rejects(GatewayStore.open(dir), { code: "state_invalid" });
      assert.equal(await readFile(path, "utf8"), data);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
