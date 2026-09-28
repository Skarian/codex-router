import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { parseConfig, type AgentConfig } from "../src/config.js";
import { Gateway, type SendblueProvider, type GatewayFiles } from "../src/gateway.js";
import { GatewayStore } from "../src/gateway-state.js";
import { DesktopSession } from "../src/desktop-session.js";
import { DesktopIpc } from "../src/desktop-ipc.js";

function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
for (const { brokerError, loseAck = false, fatal = false } of [
  { brokerError: "no-client-found" },
  { brokerError: "client-disconnected" },
  { brokerError: "Conversation must be resumed before loading history" },
  { brokerError: "Conversation must be resumed before loading history", loseAck: true },
  { brokerError: "Unsupported history version", loseAck: true, fatal: true },
]) {
  test(`Desktop recovery: ${brokerError}, lost acknowledgement=${loseAck}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dg-")));
    await mkdir(join(root, "sessions"));
    const rolloutPath = join(root, "sessions", "rollout.jsonl"); await writeFile(rolloutPath, "");
    const config = parseConfig(`
[[agents]]
id="route"
label="Agent"
cwd=${JSON.stringify(root)}
thread_id="thread"
model="test"
[gateway]
state_dir=${JSON.stringify(join(root, "state"))}
[gateway.http]
api=false
[[gateway.sendblue]]
mode="webhook"
public_url="https://example.com"
id="account"
api_key_id_env="KEY"
api_secret_key_env="SECRET"
webhook_secret_env="SIGNING"
[[gateway.sendblue.conversations]]
sender="+15125550100"
sendblue_number="+15125550200"
agent="route"
`).gateway!;
    const store = await GatewayStore.open(join(root, "state"));
    const socketPath = join(root, "s");
    const broker = createServer();
    await new Promise<void>((resolve, reject) => { broker.once("error", reject); broker.listen(socketPath, resolve); });
    let now = Date.now(), opens = 0, starts = 0, sends = 0, revision = 0;
    let acceptedUuid: string | undefined;
    let failures = 0;
    const failureLimit = brokerError === "Conversation must be resumed before loading history" ? 2 : 1;
    broker.on("connection", peer => {
      let buffer: Buffer = Buffer.alloc(0);
      peer.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
          const length = buffer.readUInt32LE(0);
          const request = JSON.parse(buffer.subarray(4, 4 + length).toString()); buffer = buffer.subarray(4 + length);
          if (request.type !== "request") continue;
          const reply = { type: "response", requestId: request.requestId, method: request.method, handledByClientId: "owner", resultType: "success" };
          if (request.method === "thread-follower-start-turn") {
            starts++; acceptedUuid = request.params.turnStart.request.clientUserMessageId;
            if (loseAck) {
              peer.write(encode({ type: "response", requestId: request.requestId, resultType: "error", error: "client-disconnected" })); continue;
            }
            peer.write(encode({ ...reply, result: { result: { turn: { id: "accepted" } } } })); continue;
          }
          if (acceptedUuid && failures < failureLimit) {
            failures++;
            if (loseAck) {
              const active = store.snapshot().routes.route!.active;
              assert.ok(active?.kind === "codex");
              assert.equal(active.pendingAdmission?.clientUserMessageId, acceptedUuid);
            }
            peer.write(encode({ type: "response", requestId: request.requestId, resultType: "error", error: brokerError })); continue;
          }
          revision++;
          const turns = acceptedUuid ? [{ turnId: "accepted", status: "completed", items: [
            { id: "u", type: "userMessage", clientId: acceptedUuid }, { id: "a", type: "agentMessage", text: "recovered reply" },
          ] }] : [];
          peer.write(encode({ type: "broadcast", method: "thread-stream-state-changed", sourceClientId: "owner", targetClientIds: ["client"], version: 11,
            params: { hostId: "local", conversationId: "thread", change: { type: "snapshot", revision,
              conversationState: { id: "thread", hostId: "local", cwd: root, rolloutPath, threadRuntimeStatus: { type: "idle" }, turns } } } }));
          peer.write(encode({ ...reply, result: { revision } }));
        }
      });
    });
    const connector: SendblueProvider = {
      signingSecret: "fixture", async typing() {}, inbound() { return undefined; }, callback() { return { status: "SENT" }; },
      async send(_route, part) { assert.deepEqual(part.payload, { kind: "text", text: "recovered reply" }); sends++; return { status: "accepted", providerHandle: "reply" }; },
      async upload() { throw new Error("Unexpected upload"); },
    };
    const files: GatewayFiles = {
      async cleanup() {}, async reconcile() {}, async prepareBatch(_route, batch) { return batch; }, async publication() { return join(root, "out"); },
      async stage(_route, _work, outcome) { return { result: { status: outcome.status, text: outcome.finalText ?? "", notices: [] }, artifacts: [] }; },
    };
    const Constructor = DesktopSession as unknown as new (agent: AgentConfig, ipc: DesktopIpc, owner: string, home: string) => DesktopSession;
    const gateway = new Gateway(config, store, { connector: () => connector, files, now: () => now, retryDelayMs: () => 10,
      async openSession() { opens++; const ipc = new DesktopIpc(connect(socketPath)); ipc.clientId = "client"; return new Constructor(config.agents[0]!, ipc, "owner", root); },
    });
    try {
      await gateway.start(); await gateway.idle();
      await gateway.receive("account", { messageHandle: "input", sender: "+15125550100", sendblueNumber: "+15125550200", providerTimeMs: now, text: "hello" });
      now += 5001; gateway.wake("route"); await gateway.idle();
      const deadline = Date.now() + 3000;
      while (sends === 0 && !gateway.processingStatus().some(s => s.state === "blocked" || s.state === "unresolved") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      await gateway.idle();
      assert.equal(failures, failureLimit); assert.equal(starts, 1);
      if (fatal) {
        assert.equal(sends, 0);
        const active = store.snapshot().routes.route!.active;
        assert.ok(active?.kind === "codex");
        assert.equal(active.pendingAdmission?.clientUserMessageId, acceptedUuid);
        assert.equal(gateway.processingStatus()[0]?.code, "app_server_protocol_failed");
      } else {
        assert.equal(opens, 1 + failureLimit + Number(loseAck)); assert.equal(sends, 1);
        assert.equal(store.snapshot().routes.route!.active, undefined);
        assert.deepEqual(gateway.processingStatus(), [{ routeId: "route", state: "idle" }]);
      }
    } finally {
      await gateway.close(); await store.close(); await new Promise<void>(resolve => broker.close(() => resolve())); await rm(root, { recursive: true, force: true });
    }
  });
}
