import { openAsBlob } from "node:fs";
import { delay } from "./gateway.js";
import { RouterError } from "./errors.js";
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new RouterError("input_invalid", "Invalid Sendblue event.");
    return value;
}
function string(value) {
    if (typeof value !== "string" || !value)
        throw new RouterError("input_invalid", "Invalid Sendblue event field.");
    return value;
}
function https(value) {
    const url = new URL(string(value));
    if (url.protocol !== "https:" || url.username || url.password)
        throw new RouterError("input_invalid", "Invalid media URL.");
    return url.href;
}
export function retryPolicy(status, headers, now = Date.now()) {
    const override = headers.get("x-should-retry");
    const retryable = override === "false" ? false : override === "true" || [408, 409, 429].includes(status) || status >= 500;
    const milliseconds = headers.get("retry-after-ms");
    const seconds = headers.get("retry-after");
    let wait;
    if (milliseconds !== null && milliseconds.trim() && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0)
        wait = Number(milliseconds);
    else if (seconds !== null && seconds.trim()) {
        const numeric = Number(seconds);
        if (Number.isFinite(numeric) && numeric >= 0)
            wait = numeric * 1000;
        else {
            const date = Date.parse(seconds);
            if (Number.isFinite(date))
                wait = Math.max(0, date - now);
        }
    }
    return { retryable, ...(wait !== undefined && Number.isFinite(wait) ? { retryAfterMs: wait } : {}) };
}
export class Sendblue {
    operations;
    signingSecret;
    headers;
    constructor(credentials, operations = {}) {
        this.operations = operations;
        this.signingSecret = credentials.signingSecret;
        this.headers = { "sb-api-key-id": credentials.apiKeyId, "sb-api-secret-key": credentials.apiSecretKey };
    }
    agentInstructions(outputDirectory) {
        return `You are chatting with the user through Sendblue over iMessage, RCS, or SMS. Prefer short, conversational replies unless the user asks for detail. Your final text response is sent automatically as a message.

To send an image or other file as an attachment, save it in ${JSON.stringify(outputDirectory)}. The gateway uploads and sends files from that directory. Images created with the image-generation tool are attached automatically.`;
    }
    inbound(value) {
        const event = object(value);
        if (event.is_outbound !== false || event.status !== "RECEIVED" || event.message_type === "group" || event.group_id)
            return;
        const sender = string(event.from_number), sendblueNumber = string(event.sendblue_number);
        if (!/^\+[1-9]\d{6,14}$/.test(sender) || !/^\+[1-9]\d{6,14}$/.test(sendblueNumber))
            throw new RouterError("input_invalid", "Invalid Sendblue number.");
        const providerTimeMs = Date.parse(string(event.date_sent));
        if (!Number.isFinite(providerTimeMs))
            throw new RouterError("input_invalid", "Invalid Sendblue event time.");
        const text = event.content == null ? "" : typeof event.content === "string" ? event.content : string(undefined);
        const sourceUrl = event.media_url ? https(event.media_url) : undefined;
        let name = "attachment";
        if (sourceUrl) {
            try {
                name = decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || name);
            }
            catch { /* Keep a safe fallback name. */ }
            name = name.replace(/[\x00-\x1f\x7f/\\]/g, "_") || "attachment";
        }
        return { messageHandle: string(event.message_handle), sender, sendblueNumber, providerTimeMs, text,
            ...(sourceUrl ? { attachment: { sourceUrl, name } } : {}) };
    }
    callback(value) {
        const event = object(value);
        return { status: string(event.status), ...(event.message_handle ? { providerHandle: string(event.message_handle) } : {}) };
    }
    async request(path, body, signal, timeout) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal.aborted)
            abort();
        else
            signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, timeout);
        timer.unref();
        try {
            const response = await (this.operations.fetch ?? fetch)(`${this.operations.baseUrl ?? "https://api.sendblue.com"}${path}`, {
                method: "POST", headers: { ...this.headers, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
                body, signal: controller.signal, redirect: "error",
            });
            // Keep the deadline active through response consumption. Never log provider bodies.
            const reader = response.body?.getReader();
            const chunks = [];
            let size = 0;
            let bodyFailed = false;
            if (reader)
                try {
                    while (true) {
                        const next = await reader.read();
                        if (next.done)
                            break;
                        size += next.value.length;
                        if (size > 256 * 1024) {
                            await reader.cancel();
                            break;
                        }
                        chunks.push(next.value);
                    }
                }
                catch {
                    size = 256 * 1024 + 1;
                    bodyFailed = true;
                }
                finally {
                    reader.releaseLock();
                }
            let value;
            if (size <= 256 * 1024)
                try {
                    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                }
                catch { /* Unusable response remains uncertain. */ }
            return { status: response.status, headers: response.headers, value, bodyFailed };
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
        }
    }
    async send(route, part, callbackUrl, signal) {
        const payload = { number: route.sender, from_number: route.sendblueNumber, status_callback: callbackUrl,
            ...(part.payload.kind === "text" ? { content: part.payload.text } : { media_url: part.payload.mediaUrl }) };
        try {
            const response = await this.request("/api/send-message", JSON.stringify(payload), signal, this.operations.requestTimeoutMs ?? 60000);
            const policy = retryPolicy(response.bodyFailed ? 503 : response.status, response.headers);
            if (response.status >= 200 && response.status < 300) {
                const handle = response.value && typeof response.value === "object" ? response.value.message_handle : undefined;
                return typeof handle === "string" && handle ? { status: "accepted", providerHandle: handle } : { status: "uncertain", ...policy };
            }
            return { status: policy.retryable || response.status >= 500 || response.status === 408 ? "uncertain" : "rejected", ...policy };
        }
        catch {
            return { status: "uncertain", retryable: !signal.aborted };
        }
    }
    async upload(path, name, mediaType, signal) {
        for (let attempt = 0; attempt < 3; attempt++) {
            let policy = { retryable: true };
            try {
                signal.throwIfAborted();
                const file = await openAsBlob(path, { type: mediaType });
                if (file.size > 100000000)
                    throw new RouterError("output_too_large", "The artifact exceeds the Sendblue upload limit.");
                const form = new FormData();
                form.set("file", file, name);
                const response = await this.request("/api/upload-file", form, signal, this.operations.uploadTimeoutMs ?? 600000);
                policy = retryPolicy(response.bodyFailed ? 503 : response.status, response.headers);
                if (response.status >= 200 && response.status < 300) {
                    try {
                        return https(object(response.value).media_url);
                    }
                    catch {
                        policy = retryPolicy(503, response.headers);
                    }
                }
            }
            catch (error) {
                if (error instanceof RouterError)
                    throw error;
            }
            if (signal.aborted || !policy.retryable || attempt === 2)
                break;
            await delay(policy.retryAfterMs ?? 500 * 2 ** attempt, signal);
        }
        throw new RouterError("turn_failed", "The Sendblue upload failed.");
    }
    async typing(route, state, signal) {
        await this.request("/api/send-typing-indicator", JSON.stringify({ number: route.sender, from_number: route.sendblueNumber, state,
            ...(state === "start" ? { max_duration_ms: 300000 } : {}) }), signal, this.operations.requestTimeoutMs ?? 60000);
    }
}
export function sendblueCredentials(account, env = process.env) {
    const secret = (value, name) => {
        const resolved = value ?? (name === undefined ? undefined : env[name]);
        if (!resolved?.trim() || /[\r\n]/.test(resolved)) {
            throw new RouterError("config_invalid", "A gateway credential is missing or invalid.");
        }
        return resolved;
    };
    return {
        apiKeyId: secret(account.apiKeyId, account.apiKeyIdEnv),
        apiSecretKey: secret(account.apiSecretKey, account.apiSecretKeyEnv),
        signingSecret: secret(account.webhookSecret, account.webhookSecretEnv),
    };
}
export function sendblueConnectors(config, env = process.env) {
    return new Map(config.sendblue.map((account) => [account.id, new Sendblue(sendblueCredentials(account, env))]));
}
//# sourceMappingURL=sendblue.js.map