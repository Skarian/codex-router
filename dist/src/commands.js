import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { RouterError } from "./errors.js";
import { connectAppServer } from "./app-server.js";
import { codexProcessSpec, sshProcessSpec } from "./transport.js";
const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function bounded(text) {
    if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
        throw new RouterError("output_too_large", "Codex produced a message too large for the router output contract.");
    }
    return text;
}
export function listAgents(config) {
    return config.agents.map(({ id, label }) => ({ id, label }));
}
export function formatAgentTable(config) {
    const rows = [["ID", "LABEL"], ...config.agents.map(({ id, label }) => [id, label])];
    const width = Math.max(...rows.map(([id]) => id?.length ?? 0));
    return rows.map(([id, label]) => `${id?.padEnd(width)}  ${label}`).join("\n");
}
async function checkDirectory(agent) {
    if (agent.sshHost !== undefined) {
        try {
            const spec = sshProcessSpec(agent.sshHost, ["test", "-d", agent.cwd]);
            await execFileAsync(spec.command, spec.args, { timeout: 10_000 });
            return { name: `agent:${agent.id}:cwd`, ok: true, text: "Working directory is accessible." };
        }
        catch {
            return { name: `agent:${agent.id}:cwd`, ok: false, text: "Working directory is not accessible." };
        }
    }
    try {
        const info = await stat(agent.cwd);
        return info.isDirectory()
            ? { name: `agent:${agent.id}:cwd`, ok: true, text: "Working directory is accessible." }
            : { name: `agent:${agent.id}:cwd`, ok: false, text: "Working directory is not a directory." };
    }
    catch {
        return { name: `agent:${agent.id}:cwd`, ok: false, text: "Working directory is not accessible." };
    }
}
export async function runDoctor(config) {
    const checks = [{ name: "config", ok: true, text: "Configuration is valid." }];
    const localAgents = config.agents.filter(({ sshHost }) => sshHost === undefined);
    const remoteAgents = config.agents.filter(({ sshHost }) => sshHost !== undefined);
    if (localAgents.length > 0 || config.agents.length === 0) {
        try {
            const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 5_000 });
            checks.push({ name: "codex", ok: true, text: stdout.trim() || "Codex executable is available." });
        }
        catch {
            checks.push({ name: "codex", ok: false, text: "Codex executable is unavailable." });
        }
    }
    checks.push(...await Promise.all(config.agents.map(checkDirectory)));
    for (const agent of remoteAgents) {
        try {
            const spec = codexProcessSpec(["--version"], agent.sshHost);
            const { stdout } = await execFileAsync(spec.command, spec.args, { timeout: 10_000 });
            checks.push({ name: `agent:${agent.id}:codex`, ok: true, text: stdout.trim() || "Codex executable is available." });
        }
        catch {
            checks.push({ name: `agent:${agent.id}:codex`, ok: false, text: "Codex executable is unavailable." });
        }
    }
    if (localAgents.length > 0 || config.agents.length === 0) {
        let connection;
        try {
            connection = await connectAppServer();
            checks.push({ name: "app-server", ok: true, text: `App-server initialized over ${connection.transportKind}.` });
            for (const agent of localAgents) {
                try {
                    await connection.client.request("thread/read", { threadId: agent.threadId, includeTurns: false });
                    checks.push({ name: `agent:${agent.id}:thread`, ok: true, text: "Task exists." });
                }
                catch {
                    checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task is unavailable." });
                }
            }
        }
        catch {
            checks.push({ name: "app-server", ok: false, text: "App-server is unavailable." });
            for (const agent of localAgents) {
                checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task was not checked." });
            }
        }
        finally {
            await connection?.close().catch(() => undefined);
        }
    }
    for (const agent of remoteAgents) {
        let remoteConnection;
        try {
            remoteConnection = await connectAppServer(agent.sshHost);
            checks.push({
                name: `agent:${agent.id}:app-server`,
                ok: true,
                text: `App-server initialized over SSH ${remoteConnection.transportKind}.`,
            });
            try {
                await remoteConnection.client.request("thread/read", { threadId: agent.threadId, includeTurns: false });
                checks.push({ name: `agent:${agent.id}:thread`, ok: true, text: "Task exists." });
            }
            catch {
                checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task is unavailable." });
            }
        }
        catch {
            checks.push({ name: `agent:${agent.id}:app-server`, ok: false, text: "App-server is unavailable over SSH." });
            checks.push({ name: `agent:${agent.id}:thread`, ok: false, text: "Task was not checked." });
        }
        finally {
            await remoteConnection?.close().catch(() => undefined);
        }
    }
    return checks;
}
export function waitForTurn(client, threadId, turnId, emit, signal, initialNotifications = []) {
    let finalText;
    const timeoutMs = Number.parseInt(process.env.CODEX_ROUTER_TURN_TIMEOUT_MS ?? "", 10) || DEFAULT_TURN_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            unsubscribe();
            reject(new RouterError("timeout", "The Codex turn did not finish before the router timeout.", { ambiguous: true }));
        }, timeoutMs);
        timer.unref();
        const finish = (callback) => {
            clearTimeout(timer);
            unsubscribe();
            unsubscribeClose();
            signal?.removeEventListener("abort", onAbort);
            callback();
        };
        const onAbort = () => finish(() => reject(new RouterError("interrupted", "The Codex turn was interrupted by the caller.", { ambiguous: true })));
        const unsubscribeClose = client.onClose((error) => finish(() => reject(error)));
        const handleNotification = (method, rawParams) => {
            try {
                const params = object(rawParams);
                if (!params || params.threadId !== threadId)
                    return;
                if (method === "item/completed" && params.turnId === turnId) {
                    const item = object(params.item);
                    if (!item)
                        return;
                    if (item.type === "reasoning" && Array.isArray(item.summary)) {
                        const text = bounded(item.summary.filter((part) => typeof part === "string").join("\n\n"));
                        if (text)
                            emit({ type: "reasoning", text });
                    }
                    if (item.type === "agentMessage" && typeof item.text === "string") {
                        if (item.phase === "commentary")
                            emit({ type: "commentary", text: bounded(item.text) });
                        if (item.phase === "final_answer")
                            finalText = bounded(item.text);
                    }
                    return;
                }
                if (method !== "turn/completed")
                    return;
                const turn = object(params.turn);
                if (!turn || turn.id !== turnId)
                    return;
                if (turn.status === "completed" && finalText !== undefined) {
                    const result = { type: "completed", text: finalText };
                    finish(() => resolve(result));
                }
                else if (turn.status === "interrupted") {
                    finish(() => reject(new RouterError("interrupted", "The Codex turn was interrupted.")));
                }
                else {
                    finish(() => reject(new RouterError("turn_failed", "The Codex turn failed before producing a final response.")));
                }
            }
            catch (error) {
                finish(() => reject(error instanceof RouterError
                    ? error
                    : new RouterError("app_server_protocol_failed", "Codex app-server emitted an invalid turn event.", { cause: error })));
            }
        };
        const unsubscribe = client.onNotification(handleNotification);
        for (const notification of initialNotifications)
            handleNotification(notification.method, notification.params);
        if (signal?.aborted)
            onAbort();
        else
            signal?.addEventListener("abort", onAbort, { once: true });
    });
}
export async function sendTurn(agent, text, emit, signal) {
    const directory = await checkDirectory(agent);
    if (!directory.ok)
        throw new RouterError("working_directory_invalid", `${agent.label}'s working directory is unavailable.`);
    const connection = await connectAppServer(agent.sshHost);
    try {
        let resumeResult;
        try {
            resumeResult = await connection.client.request("thread/resume", { threadId: agent.threadId });
        }
        catch (error) {
            throw new RouterError("thread_unavailable", `${agent.label}'s Codex task could not be resumed.`, { cause: error });
        }
        const thread = object(object(resumeResult)?.thread);
        const status = object(thread?.status);
        if (status?.type === "active") {
            throw new RouterError("agent_busy", `${agent.label} is already working. Try again after the current turn finishes.`);
        }
        connection.client.markTurnAccepted();
        const buffered = [];
        const stopBuffering = connection.client.onNotification((method, params) => {
            if (buffered.length === 64)
                buffered.shift();
            buffered.push({ method, params });
        });
        const started = await connection.client.request("turn/start", {
            threadId: agent.threadId,
            input: [{ type: "text", text, text_elements: [] }],
            cwd: agent.cwd,
            approvalPolicy: "never",
            sandboxPolicy: { type: "dangerFullAccess" },
            model: agent.model,
            ...(agent.reasoning === undefined ? {} : { effort: agent.reasoning }),
            summary: "auto",
        });
        const turn = object(object(started)?.turn);
        if (typeof turn?.id !== "string") {
            throw new RouterError("app_server_protocol_failed", "Codex app-server returned an invalid turn/start response.");
        }
        const resultPromise = waitForTurn(connection.client, agent.threadId, turn.id, emit, signal, buffered);
        stopBuffering();
        const result = await resultPromise;
        return { result, transportKind: connection.transportKind };
    }
    finally {
        await connection.close().catch(() => undefined);
    }
}
//# sourceMappingURL=commands.js.map