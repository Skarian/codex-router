import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";
import { RouterError } from "./errors.js";
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export function defaultConfigPath() {
    return resolve(homedir(), ".codex-router.toml");
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
        if (threads.has(threadId))
            throw new RouterError("config_invalid", "An agent thread_id is duplicated.");
        threads.add(threadId);
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
    const entries = (raw) => {
        if (!Array.isArray(raw) || !raw.length)
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
    fields(record, ["listen_port", "public_url", "state_dir", "sendblue", "routes"]);
    if (!Number.isInteger(record.listen_port) || Number(record.listen_port) < 1 || Number(record.listen_port) > 65535)
        invalid();
    const publicUrl = requiredString(record, "public_url", "Gateway");
    try {
        const url = new URL(publicUrl);
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
            invalid();
    }
    catch {
        invalid();
    }
    const stateDir = optionalString(record, "state_dir", "Gateway") ?? resolve(homedir(), ".codex-router/gateway");
    if (!isAbsolute(stateDir))
        invalid();
    const accounts = new Set();
    const sendblue = entries(record.sendblue).map((entry) => {
        fields(entry, ["id", "api_key_id_env", "api_secret_key_env", "webhook_secret_env"]);
        const accountId = id(entry, "id");
        if (accounts.has(accountId))
            invalid();
        accounts.add(accountId);
        return { id: accountId, apiKeyIdEnv: env(entry, "api_key_id_env"), apiSecretKeyEnv: env(entry, "api_secret_key_env"), webhookSecretEnv: env(entry, "webhook_secret_env") };
    });
    const routeIds = new Set();
    const conversations = new Set();
    const targets = new Set();
    const routes = entries(record.routes).map((entry) => {
        fields(entry, ["id", "sendblue", "sender", "sendblue_number", "agent"]);
        const routeId = id(entry, "id");
        const sendblueId = id(entry, "sendblue");
        const agent = agents.find((agent) => agent.id === entry.agent);
        if (!agent || !accounts.has(sendblueId) || routeIds.has(routeId) || targets.has(agent.id))
            return invalid();
        const sender = phone(entry, "sender");
        const sendblueNumber = phone(entry, "sendblue_number");
        const conversation = JSON.stringify([sendblueId, sender, sendblueNumber]);
        if (conversations.has(conversation))
            invalid();
        conversations.add(conversation);
        targets.add(agent.id);
        routeIds.add(routeId);
        return { id: routeId, sendblueId, sender, sendblueNumber, agent };
    });
    return { listenPort: Number(record.listen_port), publicUrl: new URL(publicUrl).origin, stateDir, sendblue, routes };
}
//# sourceMappingURL=config.js.map