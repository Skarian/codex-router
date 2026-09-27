import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";
import { RouterError } from "./errors.js";
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export function defaultConfigPath() {
    return resolve(homedir(), ".codex-router/config.toml");
}
function requiredString(record, field, agentName) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") {
        throw new RouterError("config_invalid", `${agentName} has an invalid ${field} field.`);
    }
    return value;
}
function optionalString(record, field, agentName) {
    const value = record[field];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || value.trim() === "") {
        throw new RouterError("config_invalid", `${agentName} has an invalid ${field} field.`);
    }
    return value;
}
export function parseConfig(source) {
    let document;
    try {
        document = parse(source);
    }
    catch (error) {
        throw new RouterError("config_invalid", "The router configuration is not valid TOML.", { cause: error });
    }
    const rawAgents = document.agents ?? [];
    if (!Array.isArray(rawAgents)) {
        throw new RouterError("config_invalid", "The router configuration must contain an agents array.");
    }
    const ids = new Set();
    const labels = new Set();
    const threads = new Set();
    const agents = rawAgents.map((value, index) => {
        const agentName = `Agent ${index + 1}`;
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new RouterError("config_invalid", `${agentName} must be a TOML table.`);
        }
        const record = value;
        const id = requiredString(record, "id", agentName);
        const label = requiredString(record, "label", agentName);
        const cwd = requiredString(record, "cwd", agentName);
        const threadId = requiredString(record, "thread_id", agentName);
        const model = requiredString(record, "model", agentName);
        const reasoning = optionalString(record, "reasoning", agentName);
        const sshHost = optionalString(record, "ssh_host", agentName);
        if (!ID_PATTERN.test(id)) {
            throw new RouterError("config_invalid", `${agentName} has an invalid id field.`);
        }
        if (!isAbsolute(cwd)) {
            throw new RouterError("config_invalid", `${agentName} has an invalid cwd field.`);
        }
        if (sshHost?.startsWith("-") || /\s/u.test(sshHost ?? "")) {
            throw new RouterError("config_invalid", `${agentName} has an invalid ssh_host field.`);
        }
        if (ids.has(id)) {
            throw new RouterError("config_invalid", `Agent id ${JSON.stringify(id)} is duplicated.`);
        }
        if (labels.has(label)) {
            throw new RouterError("config_invalid", `Agent label ${JSON.stringify(label)} is duplicated.`);
        }
        const target = JSON.stringify([sshHost ?? null, threadId]);
        if (threads.has(target))
            throw new RouterError("config_invalid", "An agent execution target is duplicated.");
        threads.add(target);
        ids.add(id);
        labels.add(label);
        return {
            id,
            label,
            cwd,
            threadId,
            model,
            ...(reasoning === undefined ? {} : { reasoning }),
            ...(sshHost === undefined ? {} : { sshHost }),
        };
    });
    return { agents, ...(document.gateway === undefined ? {} : { gateway: parseGateway(document.gateway, agents) }) };
}
export async function loadConfig(path) {
    let source;
    try {
        source = await readFile(path, "utf8");
    }
    catch (error) {
        throw new RouterError("config_invalid", "The router configuration could not be read.", { cause: error });
    }
    return parseConfig(source);
}
export function findAgent(config, id) {
    const agent = config.agents.find((candidate) => candidate.id === id);
    if (!agent)
        throw new RouterError("unknown_agent", `No configured agent has id ${JSON.stringify(id)}.`);
    return agent;
}
/** Derive source bindings from the configured route. */
export function routeSources(route) {
    const sources = [];
    if (route.sendblueId && route.sender && route.sendblueNumber)
        sources.push({
            kind: "sendblue", id: `sendblue:${route.sendblueId}`, accountId: route.sendblueId,
            sender: route.sender, sendblueNumber: route.sendblueNumber,
        });
    if (route.httpsId)
        sources.push({ kind: "https", id: `https:${route.httpsId}`, accountId: route.httpsId });
    return sources;
}
function parseGateway(value, agents) {
    const invalid = () => { throw new RouterError("config_invalid", "The gateway configuration is invalid."); };
    const table = (raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            return invalid();
        return raw;
    };
    const fields = (record, allowed) => {
        if (Object.keys(record).some((key) => !allowed.includes(key)))
            invalid();
    };
    const entries = (raw, required = false) => {
        if (raw === undefined && !required)
            return [];
        if (!Array.isArray(raw) || (required && !raw.length))
            return invalid();
        return raw.map(table);
    };
    const id = (record, key) => {
        const value = requiredString(record, key, "Gateway");
        if (!ID_PATTERN.test(value))
            invalid();
        return value;
    };
    const env = (record, key) => {
        const value = requiredString(record, key, "Gateway");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
            invalid();
        return value;
    };
    const phone = (record, key) => {
        const value = requiredString(record, key, "Gateway");
        if (!/^\+[1-9][0-9]{6,14}$/.test(value))
            invalid();
        return value;
    };
    const record = table(value);
    fields(record, ["listen_port", "listen_host", "tls", "public_url", "state_dir", "sendblue", "https", "routes", "max_requests", "retained_bytes"]);
    if (!Number.isInteger(record.listen_port) || Number(record.listen_port) < 1 || Number(record.listen_port) > 65535)
        invalid();
    const listenHost = optionalString(record, "listen_host", "Gateway") ?? "127.0.0.1";
    const octets = listenHost.split(".").map(Number);
    const loopback = isIPv4(listenHost) && octets[0] === 127;
    const privateAddress = isIPv4(listenHost) && (octets[0] === 10 || octets[0] === 192 && octets[1] === 168
        || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
    if (!loopback && !privateAddress)
        invalid();
    let tls;
    if (record.tls !== undefined) {
        const entry = table(record.tls);
        fields(entry, ["cert", "key"]);
        const certPath = requiredString(entry, "cert", "Gateway TLS"), keyPath = requiredString(entry, "key", "Gateway TLS");
        if (!isAbsolute(certPath) || !isAbsolute(keyPath))
            invalid();
        tls = { certPath, keyPath };
    }
    if (!loopback && !tls)
        invalid();
    const publicUrl = optionalString(record, "public_url", "Gateway");
    if (publicUrl !== undefined) {
        try {
            const url = new URL(publicUrl);
            if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
                invalid();
        }
        catch {
            invalid();
        }
    }
    const positiveLimit = (key, fallback) => {
        const value = record[key] ?? fallback;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
            return invalid();
        return value;
    };
    const maxRequests = positiveLimit("max_requests", 1024);
    const retainedBytes = positiveLimit("retained_bytes", 8 * 1024 * 1024);
    const stateDir = optionalString(record, "state_dir", "Gateway") ?? resolve(homedir(), ".codex-router/gateway");
    if (!isAbsolute(stateDir))
        invalid();
    const accounts = new Set();
    const sendblue = entries(record.sendblue).map((entry) => {
        fields(entry, ["id", "mode", "poll_start", "poll_interval_ms", "batch_quiet_ms", "api_key_id", "api_secret_key", "webhook_secret", "api_key_id_env", "api_secret_key_env", "webhook_secret_env"]);
        const duration = (key, maximum) => {
            const value = entry[key];
            if (value === undefined)
                return undefined;
            if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 250 || value > maximum)
                return invalid();
            return value;
        };
        const pollIntervalMs = duration("poll_interval_ms", 60000);
        const batchQuietMs = duration("batch_quiet_ms", 30000);
        const mode = entry.mode ?? "poll";
        if (mode !== "poll" && mode !== "webhook")
            return invalid();
        const pollStartValue = optionalString(entry, "poll_start", "Sendblue");
        if (pollStartValue !== undefined && (mode !== "poll" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(pollStartValue) || !Number.isFinite(Date.parse(pollStartValue)) || new Date(pollStartValue.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) !== pollStartValue.slice(0, 10)))
            invalid();
        const pollStart = pollStartValue === undefined ? undefined : new Date(pollStartValue).toISOString();
        for (const key of ["api_key_id", "api_secret_key", "webhook_secret"]) {
            if (key === "webhook_secret" && mode === "poll" && entry[key] === undefined && entry[`${key}_env`] === undefined)
                continue;
            if ((entry[key] !== undefined) === (entry[`${key}_env`] !== undefined))
                invalid();
            if (entry[key] !== undefined && /[\r\n]/.test(requiredString(entry, key, "Gateway")))
                invalid();
        }
        const accountId = id(entry, "id");
        if (accounts.has(accountId))
            invalid();
        accounts.add(accountId);
        return { id: accountId, mode, ...(pollStart === undefined ? {} : { pollStart }),
            ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }), ...(batchQuietMs === undefined ? {} : { batchQuietMs }),
            apiKeyId: entry.api_key_id,
            apiSecretKey: entry.api_secret_key,
            webhookSecret: entry.webhook_secret,
            apiKeyIdEnv: entry.api_key_id_env === undefined ? undefined : env(entry, "api_key_id_env"),
            apiSecretKeyEnv: entry.api_secret_key_env === undefined ? undefined : env(entry, "api_secret_key_env"),
            webhookSecretEnv: entry.webhook_secret_env === undefined ? undefined : env(entry, "webhook_secret_env"), };
    });
    if (sendblue.some(account => account.mode === "webhook") && publicUrl === undefined)
        invalid();
    const httpsAccounts = new Set();
    const https = entries(record.https).map((entry) => {
        fields(entry, ["id", "bearer_token", "bearer_token_env"]);
        const accountId = id(entry, "id");
        if (httpsAccounts.has(accountId) || (entry.bearer_token === undefined) === (entry.bearer_token_env === undefined))
            return invalid();
        httpsAccounts.add(accountId);
        if (entry.bearer_token !== undefined) {
            const bearerToken = requiredString(entry, "bearer_token", "Gateway");
            if (/[^\x21-\x7e]/.test(bearerToken))
                return invalid();
            return { id: accountId, bearerToken };
        }
        return { id: accountId, bearerTokenEnv: env(entry, "bearer_token_env") };
    });
    const routeIds = new Set();
    const conversations = new Set();
    const targets = new Set();
    const routes = entries(record.routes, true).map((entry) => {
        fields(entry, ["id", "sendblue", "sender", "sendblue_number", "https", "agent"]);
        const routeId = id(entry, "id");
        const agent = agents.find((agent) => agent.id === entry.agent);
        if (!agent || routeIds.has(routeId))
            return invalid();
        const target = JSON.stringify([agent.sshHost ?? null, agent.threadId]);
        if (targets.has(target))
            return invalid();
        const route = { id: routeId, agent };
        if (entry.sendblue !== undefined) {
            const sendblueId = id(entry, "sendblue");
            if (!accounts.has(sendblueId))
                return invalid();
            const sender = phone(entry, "sender");
            const sendblueNumber = phone(entry, "sendblue_number");
            const conversation = JSON.stringify([sendblueId, sender, sendblueNumber]);
            if (conversations.has(conversation))
                return invalid();
            conversations.add(conversation);
            Object.assign(route, { sendblueId, sender, sendblueNumber });
        }
        else if (entry.sender !== undefined || entry.sendblue_number !== undefined)
            return invalid();
        if (entry.https !== undefined) {
            route.httpsId = id(entry, "https");
            if (!httpsAccounts.has(route.httpsId))
                return invalid();
        }
        if (!routeSources(route).length)
            return invalid();
        targets.add(target);
        routeIds.add(routeId);
        return route;
    });
    return { listenPort: Number(record.listen_port), listenHost, ...(tls ? { tls } : {}), ...(publicUrl === undefined ? {} : { publicUrl: new URL(publicUrl).origin }),
        stateDir, sendblue, https, maxRequests, retainedBytes, routes };
}
//# sourceMappingURL=config.js.map