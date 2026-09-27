import { createServer } from "node:http";
import { Gateway, secretEqual } from "./gateway.js";
const BODY_LIMIT = 256 * 1024;
class HttpFailure extends Error {
    status;
    constructor(status) {
        super();
        this.status = status;
    }
}
async function body(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        const cleanup = () => {
            request.setTimeout(0);
            request.removeListener("data", data);
            request.removeListener("end", end);
            request.removeListener("error", error);
            request.removeListener("aborted", aborted);
        };
        const error = () => { cleanup(); reject(new HttpFailure(400)); };
        const aborted = () => error();
        const data = (chunk) => {
            bytes += chunk.length;
            if (bytes > BODY_LIMIT) {
                cleanup();
                request.resume();
                reject(new HttpFailure(413));
            }
            else
                chunks.push(chunk);
        };
        const end = () => {
            cleanup();
            try {
                resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
            }
            catch {
                reject(new HttpFailure(400));
            }
        };
        request.on("data", data);
        request.once("end", end);
        request.once("error", error);
        request.once("aborted", aborted);
        request.setTimeout(60000, () => { cleanup(); reject(new HttpFailure(408)); request.resume(); });
    });
}
export function createGatewayServer(gateway) {
    const server = createServer((request, response) => {
        void handle(gateway, request, response).catch((error) => {
            if (!response.headersSent)
                response.writeHead(error instanceof HttpFailure ? error.status : 503, error instanceof HttpFailure && error.status === 408 ? { connection: "close" } : {});
            response.end();
        });
    });
    server.headersTimeout = 30000;
    server.requestTimeout = 0;
    server.keepAliveTimeout = 5000;
    return server;
}
async function handle(gateway, request, response) {
    const path = (request.url ?? "").split("?")[0];
    const health = path === "/healthz" || path === "/readyz";
    const webhook = /^\/webhooks\/sendblue\/([a-z][a-z0-9-]*)$/.exec(path);
    const callback = /^\/callbacks\/sendblue\/([a-z][a-z0-9-]*)\/([^/]+)\/([^/]+)$/.exec(path);
    if (!health && !webhook && !callback)
        throw new HttpFailure(404);
    if (request.method !== (health ? "GET" : "POST"))
        throw new HttpFailure(405);
    if (health) {
        response.writeHead(path === "/healthz" || gateway.ready ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify(path === "/healthz" ? { ok: true } : { ready: gateway.ready }));
        return;
    }
    const account = (webhook ?? callback)[1];
    if (!gateway.config.sendblue.some((entry) => entry.id === account))
        throw new HttpFailure(404);
    const connector = gateway.operations.connector(account);
    const secret = request.headers["sb-signing-secret"];
    if (typeof secret !== "string" || !secretEqual(secret, connector.signingSecret))
        throw new HttpFailure(401);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? ""))
        throw new HttpFailure(415);
    if (Number(request.headers["content-length"] ?? 0) > BODY_LIMIT)
        throw new HttpFailure(413);
    if (webhook && !gateway.ready)
        throw new HttpFailure(503);
    const raw = await body(request);
    if (callback) {
        const state = gateway.callbackState(account, callback[2], callback[3]);
        if (state === "stale") {
            response.writeHead(204);
            response.end();
            return;
        }
        if (state === "unauthorized")
            throw new HttpFailure(401);
    }
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new HttpFailure(400);
    }
    if (webhook) {
        let message;
        try {
            message = connector.inbound(value);
        }
        catch {
            throw new HttpFailure(400);
        }
        if (message)
            await gateway.receive(account, message);
    }
    else {
        let status;
        try {
            status = connector.callback(value);
        }
        catch {
            throw new HttpFailure(400);
        }
        if (!await gateway.callback(account, callback[2], callback[3], status))
            throw new HttpFailure(401);
    }
    response.writeHead(204);
    response.end();
}
export async function listenGateway(server, port) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
}
export async function closeGatewayServer(server) {
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
    });
}
export async function runGateway(config, signal) {
    const { sendblueConnectors } = await import("./sendblue.js");
    const { GatewayStore } = await import("./gateway-state.js");
    const { GatewayFilePlane } = await import("./gateway-files.js");
    const connectors = sendblueConnectors(config);
    const store = await GatewayStore.open(config.stateDir);
    const gateway = new Gateway(config, store, { connector: (id) => connectors.get(id), files: new GatewayFilePlane(config.stateDir) });
    const server = createGatewayServer(gateway);
    try {
        signal.throwIfAborted();
        await listenGateway(server, config.listenPort);
        await gateway.start();
        await new Promise((resolve, reject) => {
            const stop = () => { server.removeListener("error", fail); resolve(); };
            const fail = (error) => { signal.removeEventListener("abort", stop); reject(error); };
            server.once("error", fail);
            if (signal.aborted)
                stop();
            else
                signal.addEventListener("abort", stop, { once: true });
        });
    }
    finally {
        gateway.ready = false;
        try {
            await Promise.all([server.listening ? closeGatewayServer(server) : undefined, gateway.close()]);
        }
        finally {
            await store.close();
        }
    }
}
//# sourceMappingURL=gateway-server.js.map