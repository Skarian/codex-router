import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type RequestOptions } from "node:http";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { GatewayConfig } from "../src/config.js";
import type { Gateway } from "../src/gateway.js";
import { ProgressHub } from "../src/http-progress.js";
import { createGatewayServer, listenGateway, closeGatewayServer } from "../src/gateway-server.js";

async function connect(options: RequestOptions, body?: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ ...options, agent: false }, resolve);
    req.once("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("HTTP test timed out")));
    req.end(body);
  });
}
async function read(response: IncomingMessage): Promise<string> {
  let body = ""; for await (const chunk of response) body += chunk; return body;
}

test("loopback HTTP provides discovery, durable results and live SSE while rejecting hostile Host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-http-"));
  const id = randomUUID(), key = "request-key";
  const progress = new ProgressHub({ heartbeatMs: 25 });
  let admitted = false, terminal = false;
  const config: GatewayConfig = { http: { port: 8787, api: true }, stateDir: directory,
    sendblue: [], agents: [{ id: "agent", label: "Agent", threadId: "thread", cwd: directory, model: "test" }] };
  const gateway = { config, ready: true, progress,
    submit: async () => { admitted = true; }, requestKey: () => key,
    request: () => admitted ? { request_id: id, status: terminal ? "completed" : "running",
      ...(terminal ? { result: { status: "completed", text: "Finished", notices: [] } } : {}) } : undefined,
  } as unknown as Gateway;
  const server = createGatewayServer(gateway);
  try {
    await listenGateway(server, 0);
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base: RequestOptions = { hostname: "127.0.0.1", port: address.port, path: `/v1/agents/agent/requests`, headers: { "content-type": "application/json" } };
    assert.equal(address.address, "127.0.0.1");
    for (const method of ["GET", "POST"]) {
      const hostile = await connect({ ...base, method, headers: { ...base.headers, host: `evil.example:${address.port}` } });
      assert.equal(hostile.statusCode, 400); assert.match(await read(hostile), /invalid_host/);
    }
    assert.equal(admitted, false);
    const catalog = await connect({ ...base, path: "/v1/agents" });
    assert.deepEqual(JSON.parse(await read(catalog)), [{ id: "agent", label: "Agent" }]);
    const posted = await connect({ ...base, method: "POST" }, JSON.stringify({ request_id: id, text: "Hello" }));
    assert.equal(posted.statusCode, 202); assert.match(await read(posted), /running/);
    for (const path of ["/webhooks/sendblue/phone", "/callbacks/sendblue/phone/part/token"]) {
      const disabled = await connect({ ...base, path, method: "POST" });
      assert.equal(disabled.statusCode, 404); await read(disabled);
    }
    const status = await connect({ ...base, path: "/statusz" });
    assert.equal(status.statusCode, 401); await read(status);
    const stream = await connect({ ...base, path: `${base.path}/${id}/events` });
    assert.equal(stream.statusCode, 200);
    assert.match(stream.headers["content-type"]!, /text\/event-stream/);
    progress.publish(key, { id: "commentary-1", kind: "commentary", text: "Working" });
    let partial = "";
    const commentaryCursor = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("live commentary/heartbeat missing")), 2000);
      stream.on("data", chunk => {
        partial += chunk.toString();
        if (partial.includes("Working") && partial.includes(": heartbeat")) {
          const cursor = /id: ([^\n]+)\nevent: commentary/.exec(partial)?.[1];
          if (cursor) { clearTimeout(timer); resolve(cursor); }
        }
      });
      stream.once("error", reject);
    });
    assert.equal(terminal, false, "commentary must arrive before terminal completion");
    stream.destroy();
    terminal = true;
    progress.notify(key);
    const resumed = await connect({ ...base, path: `${base.path}/${id}/events`, headers: { ...base.headers, "last-event-id": commentaryCursor } });
    const resumedBody = await read(resumed);
    assert.match(resumedBody, /event: terminal/); assert.match(resumedBody, /Finished/);
    assert.doesNotMatch(resumedBody, /Working/);
    const result = await connect({ ...base, path: `${base.path}/${id}` });
    assert.equal(result.statusCode, 200); assert.match(await read(result), /Finished/);
  } finally { progress.close(); await closeGatewayServer(server); await rm(directory, { recursive: true, force: true }); }
});

test("backend Host validation rejects missing, duplicate and malformed authority", async () => {
  const { validateBackendHost } = await import("../src/gateway-server.js");
  const input = (hosts: string[], authority?: string) => ({
    rawHeaders: hosts.flatMap(value => ["Host", value]), headers: { host: authority }, socket: { localPort: 8788 },
  } as unknown as IncomingMessage);
  assert.doesNotThrow(() => validateBackendHost(input(["127.0.0.1:8788"], "127.0.0.1:8788")));
  for (const hosts of [[], ["127.0.0.1:8788", "127.0.0.1:8788"]]) {
    assert.throws(() => validateBackendHost(input(hosts, "127.0.0.1:8788")), /invalid_host/);
  }
  for (const authority of ["localhost:8788", "127.0.0.1", "127.0.0.1:8787", "evil.example:8788", "127.0.0.1:8788@evil.example"]) {
    assert.throws(() => validateBackendHost(input([authority], authority)), /invalid_host/);
  }
});
