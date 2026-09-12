import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Gateway, secretEqual } from "./gateway.js";

const BODY_LIMIT = 256 * 1024;
class HttpFailure extends Error { constructor(readonly status: number) { super(); } }

async function body(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.setTimeout(0);
      request.removeListener("data", data); request.removeListener("end", end);
      request.removeListener("error", error); request.removeListener("aborted", aborted);
    };
    const error = () => { cleanup(); reject(new HttpFailure(400)); };
    const aborted = () => error();
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) { cleanup(); request.resume(); reject(new HttpFailure(413)); }
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpFailure(400)); }
    };
    request.on("data", data); request.once("end", end); request.once("error", error); request.once("aborted", aborted);
    request.setTimeout(60000, () => { cleanup(); reject(new HttpFailure(408)); request.destroy(); });
  });
}

export function createGatewayServer(gateway: Gateway): Server {
  const server = createServer((request, response) => {
    void handle(gateway, request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(error instanceof HttpFailure ? error.status : 503);
      response.end();
    });
  });
  server.headersTimeout = 30000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5000;
  return server;
}

async function handle(gateway: Gateway, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = (request.url ?? "").split("?")[0]!;
  const health = path === "/healthz" || path === "/readyz";
  const webhook = /^\/webhooks\/sendblue\/([a-z][a-z0-9-]*)$/.exec(path);
  const callback = /^\/callbacks\/sendblue\/([a-z][a-z0-9-]*)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!health && !webhook && !callback) throw new HttpFailure(404);
  if (request.method !== (health ? "GET" : "POST")) throw new HttpFailure(405);
  if (health) {
    response.writeHead(path === "/healthz" || gateway.ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(path === "/healthz" ? { ok: true } : { ready: gateway.ready }));
    return;
  }
  const account = (webhook ?? callback)![1]!;
  if (!gateway.config.sendblue.some((entry) => entry.id === account)) throw new HttpFailure(404);
  const connector = gateway.operations.connector(account);
  const secret = request.headers["sb-signing-secret"];
  if (typeof secret !== "string" || !secretEqual(secret, connector.signingSecret)) throw new HttpFailure(401);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new HttpFailure(415);
  if (Number(request.headers["content-length"] ?? 0) > BODY_LIMIT) throw new HttpFailure(413);
  if (webhook && !gateway.ready) throw new HttpFailure(503);
  const value = await body(request);
  if (webhook) {
    let message;
    try { message = connector.inbound(value); } catch { throw new HttpFailure(400); }
    if (message) await gateway.receive(account, message);
  } else {
    let status;
    try { status = connector.callback(value); } catch { throw new HttpFailure(400); }
    if (!await gateway.callback(account, callback![2]!, callback![3]!, status)) throw new HttpFailure(401);
  }
  response.writeHead(204); response.end();
}

export async function listenGateway(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
}

export async function closeGatewayServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
