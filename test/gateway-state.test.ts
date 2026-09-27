import assert from "node:assert/strict";
import test from "node:test";
import { validateState, initializePolling, type GatewayState } from "../src/gateway-state.js";

function state(): GatewayState {
  return { version: 2, routes: { route: {
    binding: { sources: [{ kind: "sendblue", id: "sendblue:sendblue", accountId: "sendblue", sender: "+1", sendblueNumber: "+2" }], target: { sshHost: null, threadId: "thread", cwd: "/work" } },
    nextSequence: 1, receipts: [], queue: [], active: {
      kind: "codex", ownerBatchId: "batch", joinedBatchIds: [], publicationIds: ["publication"], artifactBaseline: [],
      batches: [{ id: "batch", sourceId: "sendblue:sendblue", openedAtMs: 0, quietDeadlineMs: 1, maximumDeadlineMs: 2,
        events: [{ messageHandle: "message", providerTimeMs: 0, receiptSequence: 0, text: "hello" }] }],
      binding: { backend: "desktop", host: "local", codexHome: "/home/user/.codex", threadId: "thread" }, clientUserMessageId: "client-id",
    },
  } } };
}

test("execution binding validates route identity and Desktop admission boundary", () => {
  assert.deepEqual(validateState(state()), state());
  for (const mutation of ["host", "threadId", "clientUserMessageId"] as const) {
    const value = state(); const work = value.routes.route!.active!;
    if (work.kind !== "codex") assert.fail();
    if (mutation === "clientUserMessageId") delete work.clientUserMessageId;
    else work.binding![mutation] = "other";
    assert.throws(() => validateState(value), { code: "state_invalid" });
  }
});

test("legacy unbound work remains readable without fabricated admission identity", () => {
  const value = state(); const work = value.routes.route!.active!;
  if (work.kind !== "codex") assert.fail();
  delete work.binding; delete work.clientUserMessageId;
  assert.deepEqual(validateState(value), value);
});


test("Desktop execution cannot be bound to an SSH route", () => {
  const value = state(); const route = value.routes.route!; const work = route.active!;
  if (work.kind !== "codex") assert.fail();
  route.binding.target.sshHost = "remote"; work.binding!.host = "remote";
  assert.throws(() => validateState(value), { code: "state_invalid" });
});


test("poll activation survives restart, adds routes at activation, and validates stored checkpoints", () => {
  const data: GatewayState = { version: 2, routes: {} };
  const config = { sendblue: [{ id: "account", mode: "poll", pollStart: new Date(1000).toISOString() }], routes: [{ id: "one", sendblueId: "account" }] } as import("../src/config.js").GatewayConfig;
  initializePolling(data, config, 2000);
  assert.deepEqual(data.polling!.account, { activationAtMs: 1000, completedThroughMs: 1000, routeActivationAtMs: { one: 1000 } });
  data.polling!.account!.completedThroughMs = 3000;
  config.routes.push({ id: "two", sendblueId: "account" } as import("../src/config.js").GatewayRoute);
  initializePolling(data, config, 4000);
  assert.equal(data.polling!.account!.completedThroughMs, 3000);
  assert.deepEqual(data.polling!.account!.routeActivationAtMs, { one: 1000, two: 4000 });
  validateState(data);
  data.polling!.account!.completedThroughMs = 999;
  assert.throws(() => validateState(data), { code: "state_invalid" });
});

test("fresh polling activation is saved once and future migration boundaries are rejected", () => {
  const data: GatewayState = { version: 2, routes: {} };
  const config = { sendblue: [{ id: "account", mode: "poll" }], routes: [] } as unknown as import("../src/config.js").GatewayConfig;
  initializePolling(data, config, 2000); initializePolling(data, config, 3000);
  assert.equal(data.polling!.account!.activationAtMs, 2000);
  config.sendblue[0]!.pollStart = new Date(4000).toISOString();
  assert.throws(() => initializePolling(data, config, 3000), { code: "config_invalid" });
});
