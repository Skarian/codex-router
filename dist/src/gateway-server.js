import { startDiagnostics } from "./gateway-diagnostics.js";
import { unresolved } from "./gateway-state.js";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { RouterError } from "./errors.js";
import { createServer } from "node:http";
import { handleHttps, httpsCredentials, HTTPS_BODY_LIMIT, HttpFailure } from "./gateway-https.js";
import { Gateway, secretEqual } from "./gateway.js";
const BODY_LIMIT = 256 * 1024;
async function body(request, limit = BODY_LIMIT) {
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
            if (bytes > limit) {
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
    const tokens = httpsCredentials(gateway.config.https ?? []);
    const handler = (request, response) => {
        void handle(gateway, tokens, request, response).catch((error) => {
            if (response.headersSent) {
                response.end();
                return;
            }
            const status = error instanceof HttpFailure ? error.status : 503;
            response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(status === 408 ? { connection: "close" } : {}) });
            response.end(JSON.stringify({ error: error instanceof HttpFailure ? error.code : "gateway_unavailable" }));
        });
    };
    let server;
    try {
        const tls = gateway.config.tls;
        server = tls ? createHttpsServer({ cert: readFileSync(tls.certPath), key: readFileSync(tls.keyPath), minVersion: "TLSv1.2" }, handler) : createServer(handler);
    }
    catch {
        throw new RouterError("config_invalid", "The gateway TLS certificate or key could not be loaded.");
    }
    server.headersTimeout = 30000;
    server.requestTimeout = 0;
    server.keepAliveTimeout = 5000;
    return server;
}
async function handle(gateway, tokens, request, response) {
    if (request.url?.startsWith("/v1/") && await handleHttps(gateway, tokens, request, response, () => body(request, HTTPS_BODY_LIMIT)))
        return;
    const path = (request.url ?? "").split("?")[0];
    const status = path === "/statusz";
    const health = path === "/healthz" || path === "/readyz";
    const webhook = /^\/webhooks\/sendblue\/([a-z][a-z0-9-]*)$/.exec(path);
    const callback = /^\/callbacks\/sendblue\/([a-z][a-z0-9-]*)\/([^/]+)\/([^/]+)$/.exec(path);
    if (!health && !status && !webhook && !callback)
        throw new HttpFailure(404);
    if (request.method !== (health || status ? "GET" : "POST"))
        throw new HttpFailure(405);
    if (health) {
        response.writeHead(path === "/healthz" || gateway.ready ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify(path === "/healthz" ? { ok: true } : { ready: gateway.ready }));
        return;
    }
    if (status) {
        const secret = request.headers["sb-signing-secret"];
        const accounts = typeof secret === "string" ? gateway.config.sendblue.filter((entry) => entry.mode === "webhook" &&
            secretEqual(secret, gateway.operations.connector(entry.id).signingSecret)).map((entry) => entry.id) : [];
        if (!accounts.length)
            throw new HttpFailure(401);
        const routes = new Set(gateway.config.routes.filter((route) => route.sendblueId !== undefined && accounts.includes(route.sendblueId)).map((route) => route.id));
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ ready: gateway.ready, routes: gateway.processingStatus().filter((route) => routes.has(route.routeId)) }));
        return;
    }
    const account = (webhook ?? callback)[1];
    if (!gateway.config.sendblue.some((entry) => entry.id === account && entry.mode === "webhook"))
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
export async function listenGateway(server, port, host = "127.0.0.1") {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
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
    const { GatewayStore, initializePolling } = await import("./gateway-state.js");
    const { SendbluePoller } = await import("./sendblue-poller.js");
    const { GatewayFilePlane } = await import("./gateway-files.js");
    const connectors = sendblueConnectors(config);
    httpsCredentials(config.https ?? []);
    const store = await GatewayStore.open(config.stateDir);
    const gateway = new Gateway(config, store, { connector: (id) => connectors.get(id), files: new GatewayFilePlane(config.stateDir) });
    const intakeAbort = new AbortController();
    const stopIntake = () => intakeAbort.abort();
    signal.addEventListener("abort", stopIntake, { once: true });
    let server;
    const pollers = [];
    const polling = new Map();
    const diagnostics = startDiagnostics(config.stateDir, () => {
        const routes = gateway.processingStatus();
        return { ready: gateway.ready, polling: [...polling.values()], routes,
            unresolved: store.read(state => unresolved(state).unresolved.filter(effect => routes.some(route => route.routeId === effect.routeId && route.state === "unresolved"))) };
    }, { report: failed => process.stderr.write(JSON.stringify({ type: "gateway_diagnostics", state: failed ? "unavailable" : "recovered" }) + "\n") });
    try {
        signal.throwIfAborted();
        server = createGatewayServer(gateway);
        await listenGateway(server, config.listenPort, config.listenHost);
        await gateway.start();
        await store.transaction(state => initializePolling(state, config, Date.now()));
        for (const account of config.sendblue.filter(account => account.mode !== "webhook")) {
            const connector = connectors.get(account.id);
            let lastStatus = "";
            polling.set(account.id, { accountId: account.id, state: "running" });
            const poller = new SendbluePoller({
                ...(account.pollIntervalMs === undefined ? {} : { intervalMs: account.pollIntervalMs }),
                routes: config.routes.filter(route => route.sendblueId === account.id).map(route => ({ id: route.id, sender: route.sender, sendblueNumber: route.sendblueNumber })),
                state: () => store.read(state => state.polling[account.id]),
                checkpoint: async (completedThroughMs) => { await store.transaction(state => { state.polling[account.id].completedThroughMs = completedThroughMs; }); },
                list: (query, abort) => connector.list(query, abort),
                receive: async (raw) => { const message = connector.inbound(raw); if (message)
                    await gateway.receive(account.id, message); },
                onStatus: status => {
                    const previous = polling.get(account.id);
                    // A retry in progress does not erase the last failure before checkpoint success.
                    if (status.state !== "running" || !["degraded", "blocked"].includes(previous.state)) {
                        polling.set(account.id, { accountId: account.id, ...status,
                            ...(status.state === "idle" ? { lastSuccessAt: Date.now() } : previous.lastSuccessAt === undefined ? {} : { lastSuccessAt: previous.lastSuccessAt }) });
                    }
                    // Log stable state transitions, not changing retry timestamps.
                    const summary = status.state === "running" ? "" : JSON.stringify({ state: status.state, code: status.code });
                    if (summary && summary !== lastStatus) {
                        lastStatus = summary;
                        process.stderr.write(JSON.stringify({ type: "sendblue_poll", account: account.id, ...status }) + "\n");
                    }
                },
            });
            pollers.push(poller.run(intakeAbort.signal));
        }
        const runningServer = server;
        await new Promise((resolve, reject) => {
            const stop = () => { runningServer.removeListener("error", fail); resolve(); };
            const fail = (error) => { signal.removeEventListener("abort", stop); reject(error); };
            runningServer.once("error", fail);
            if (signal.aborted)
                stop();
            else
                signal.addEventListener("abort", stop, { once: true });
            for (const poller of pollers)
                void poller.catch(fail);
        });
    }
    finally {
        diagnostics.close();
        signal.removeEventListener("abort", stopIntake);
        intakeAbort.abort();
        await Promise.allSettled(pollers);
        gateway.ready = false;
        try {
            await Promise.all([server?.listening ? closeGatewayServer(server) : undefined, gateway.close()]);
        }
        finally {
            await store.close();
        }
    }
}
//# sourceMappingURL=gateway-server.js.map