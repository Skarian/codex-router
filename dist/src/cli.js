#!/usr/bin/env node
import { resolve } from "node:path";
import { defaultConfigPath, findAgent, loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { failedMessage, asRouterError, RouterError } from "./errors.js";
import { cancelTurn, sendTurn } from "./turn-session.js";
let stdoutClosed = false;
let activeAbortController;
function handleStdoutError(error) {
    if (error.code !== "EPIPE")
        throw error;
    stdoutClosed = true;
    process.exitCode = 0;
    activeAbortController?.abort();
}
process.stdout.on("error", handleStdoutError);
function usage() {
    return [
        "Usage:",
        "  codex-router [--config PATH] agents list [--json]",
        "  codex-router [--config PATH] doctor [--json]",
        "  codex-router [--config PATH] send AGENT_ID --stdin [--json | --stream]",
        "  codex-router [--config PATH] cancel AGENT_ID [--json]",
    ].join("\n");
}
function parseArgs(argv) {
    let configPath = defaultConfigPath();
    let json = false;
    let stream = false;
    let stdin = false;
    const command = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--config") {
            const value = argv[++index];
            if (!value)
                throw new RouterError("input_invalid", "--config requires a path.");
            configPath = resolve(value);
        }
        else if (arg === "--json")
            json = true;
        else if (arg === "--stream")
            stream = true;
        else if (arg === "--stdin")
            stdin = true;
        else if (arg?.startsWith("-"))
            throw new RouterError("input_invalid", `Unknown option ${arg}.`);
        else if (arg)
            command.push(arg);
    }
    if (json && stream)
        throw new RouterError("input_invalid", "--json and --stream are mutually exclusive.");
    return { configPath, command, json, stream, stdin };
}
function printJson(value) {
    writeStdout(`${JSON.stringify(value)}\n`);
}
function writeStdout(text) {
    if (stdoutClosed)
        return;
    try {
        process.stdout.write(text);
    }
    catch (error) {
        handleStdoutError(error);
    }
}
function listAgents(config) {
    return config.agents.map(({ id, label }) => ({ id, label }));
}
function formatAgentTable(config) {
    const rows = [["ID", "LABEL"], ...config.agents.map(({ id, label }) => [id, label])];
    const width = Math.max(...rows.map(([id]) => id?.length ?? 0));
    return rows.map(([id, label]) => `${id?.padEnd(width)}  ${label}`).join("\n");
}
async function readStdin() {
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin)
        text += chunk;
    if (text.length === 0)
        throw new RouterError("input_invalid", "No transcript text was provided on stdin.");
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
        throw new RouterError("input_invalid", "Transcript text exceeds the 64 KiB input limit.");
    }
    return text;
}
async function main() {
    let parsed;
    try {
        parsed = parseArgs(process.argv.slice(2));
    }
    catch (error) {
        process.stderr.write(`${asRouterError(error).message}\n${usage()}\n`);
        process.exitCode = 2;
        return;
    }
    const [first, second, third] = parsed.command;
    try {
        const config = await loadConfig(parsed.configPath);
        if (first === "agents" && second === "list" && third === undefined && !parsed.stdin && !parsed.stream) {
            if (parsed.json)
                printJson(listAgents(config));
            else
                writeStdout(`${formatAgentTable(config)}\n`);
            return;
        }
        if (first === "doctor" && second === undefined && !parsed.stdin && !parsed.stream) {
            const checks = await runDoctor(config);
            const ok = checks.every((check) => check.ok);
            if (parsed.json)
                printJson({ ok, checks });
            else
                for (const check of checks)
                    writeStdout(`${check.ok ? "OK" : "FAIL"}  ${check.name}  ${check.text}\n`);
            if (!ok)
                process.exitCode = 1;
            return;
        }
        if (first === "send" && second && third === undefined && parsed.stdin) {
            const agent = findAgent(config, second);
            const text = await readStdin();
            const abortController = new AbortController();
            activeAbortController = abortController;
            const onSignal = () => {
                process.exitCode = 1;
                abortController.abort();
            };
            process.once("SIGINT", onSignal);
            process.once("SIGTERM", onSignal);
            try {
                const emit = (message) => {
                    if (parsed.stream && message.type !== "completed")
                        printJson(message);
                };
                const { result } = await sendTurn(agent, text, emit, abortController.signal);
                if (parsed.json || parsed.stream)
                    printJson(result);
                else
                    writeStdout(`${result.text}\n`);
            }
            finally {
                if (activeAbortController === abortController)
                    activeAbortController = undefined;
                process.removeListener("SIGINT", onSignal);
                process.removeListener("SIGTERM", onSignal);
            }
            return;
        }
        if (first === "cancel" && second && third === undefined && !parsed.stdin && !parsed.stream) {
            const agent = findAgent(config, second);
            const result = await cancelTurn(agent);
            if (parsed.json)
                printJson(result);
            else if (result.type === "interrupt_requested")
                writeStdout(`Interrupt requested for ${agent.label}.\n`);
            else
                writeStdout(`${agent.label} is already idle.\n`);
            return;
        }
        throw new RouterError("input_invalid", "Invalid command usage.");
    }
    catch (error) {
        if (stdoutClosed) {
            process.exitCode = 0;
            return;
        }
        const failure = asRouterError(error);
        if (parsed.json || parsed.stream)
            printJson(failedMessage(failure));
        else
            process.stderr.write(`${failure.message}\n`);
        process.exitCode = failure.code === "input_invalid" ? 2 : 1;
        if (failure.code === "input_invalid")
            process.stderr.write(`${usage()}\n`);
    }
}
await main();
//# sourceMappingURL=cli.js.map