import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { GatewayConfig } from "../src/config.js";
import type { Gateway } from "../src/gateway.js";
import { ProgressHub } from "../src/gateway-progress.js";
import { createGatewayServer, listenGateway, closeGatewayServer } from "../src/gateway-server.js";

async function connect(options: RequestOptions, body?: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ ...options, agent: false }, resolve);
    req.once("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("TLS test timed out")));
    req.end(body);
  });
}
async function read(response: IncomingMessage): Promise<string> {
  let body = ""; for await (const chunk of response) body += chunk; return body;
}

test("native TLS validates trust and hostname while retaining authenticated POST, results and live SSE", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-tls-"));
  const certPath = join(directory, "cert.pem"), keyPath = join(directory, "key.pem");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", keyPath, "-out", certPath]);
  const ca = await readFile(certPath);
  const id = randomUUID(), key = "request-key";
  const progress = new ProgressHub({ heartbeatMs: 25 });
  let admitted = false, terminal = false;
  const config: GatewayConfig = { listenPort: 0, listenHost: "127.0.0.1", tls: { certPath, keyPath }, stateDir: directory,
    sendblue: [{ id: "phone", mode: "poll" }], https: [{ id: "client", bearerToken: "test-token" }],
    routes: [{ id: "route", httpsId: "client", agent: { id: "agent", label: "Agent", threadId: "thread", cwd: directory, model: "test" } }] };
  const gateway = { config, ready: true, progress,
    submit: async () => { admitted = true; }, requestKey: () => key,
    request: () => admitted ? { request_id: id, status: terminal ? "completed" : "running",
      ...(terminal ? { result: { status: "completed", text: "Finished", notices: [] } } : {}) } : undefined,
  } as unknown as Gateway;
  const server = createGatewayServer(gateway);
  try {
    await listenGateway(server, 0);
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base: RequestOptions = { hostname: "127.0.0.1", port: address.port, ca, path: `/v1/routes/route/requests`, headers: { authorization: "Bearer test-token", "content-type": "application/json" } };
    await assert.rejects(connect({ ...base, ca: undefined }), /self-signed|certificate/i);
    await assert.rejects(connect({ ...base, servername: "wrong.example" }), /altname|hostname|certificate/i);
    const unauthorized = await connect({ ...base, headers: { authorization: "Bearer wrong" } });
    assert.equal(unauthorized.statusCode, 401); await read(unauthorized);
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

test("TLS loading failures are bounded configuration errors", () => {
  const gateway = { config: { https: [], tls: { certPath: "/missing/secret-certificate", keyPath: "/missing/private-key" } } } as unknown as Gateway;
  assert.throws(() => createGatewayServer(gateway), (error: unknown) => error instanceof Error && error.message === "The gateway TLS certificate or key could not be loaded.");
});
