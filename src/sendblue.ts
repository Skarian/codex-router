import { openAsBlob } from "node:fs";
import SendblueAPI, { type APIPromise } from "sendblue";
import type { MessageListParams, MessageListResponse, MessageResponse } from "sendblue/resources/messages";
import type { GatewayConfig, SendblueConfig } from "./config.js";
import type { SendblueProvider, IncomingMessage, SendOutcome, StatusCallback } from "./gateway.js";
import { delay } from "./request-runtime.js";
import type { DeliveryPart } from "./gateway-state.js";
import { RouterError } from "./errors.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouterError("input_invalid", "Invalid Sendblue event.");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new RouterError("input_invalid", "Invalid Sendblue event field.");
  return value;
}
function https(value: unknown): string {
  const url = new URL(string(value));
  if (url.protocol !== "https:" || url.username || url.password) throw new RouterError("input_invalid", "Invalid media URL.");
  return url.href;
}
export function retryPolicy(status: number, headers: Headers, now = Date.now()): { retryable: boolean; retryAfterMs?: number } {
  const override = headers.get("x-should-retry");
  const retryable = override === "false" ? false : override === "true" || [408, 409, 429].includes(status) || status >= 500;
  const milliseconds = headers.get("retry-after-ms");
  const seconds = headers.get("retry-after");
  let wait: number | undefined;
  if (milliseconds !== null && milliseconds.trim() && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0) wait = Number(milliseconds);
  else if (seconds !== null && seconds.trim()) {
    const numeric = Number(seconds);
    if (Number.isFinite(numeric) && numeric >= 0) wait = numeric * 1000;
    else { const date = Date.parse(seconds); if (Number.isFinite(date)) wait = Math.max(0, date - now); }
  }
  return { retryable, ...(wait !== undefined && Number.isFinite(wait) ? { retryAfterMs: wait } : {}) };
}

export type SendblueListQuery = MessageListParams;
export type SendblueListPage = MessageListResponse;

export class SendblueRequestError extends Error {
  constructor(readonly retryable: boolean, readonly retryAfterMs?: number) {
    super("The Sendblue request failed.");
  }
}

interface Credentials { apiKeyId: string; apiSecretKey: string; signingSecret?: string }
interface ProviderResponse { status: number; headers: Headers; value: unknown; bodyFailed: boolean }
interface SendblueOperations {
  fetch?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

export class Sendblue implements SendblueProvider {
  readonly signingSecret: string;
  private readonly client: SendblueAPI;
  constructor(credentials: Credentials, private readonly operations: SendblueOperations = {}) {
    this.signingSecret = credentials.signingSecret ?? "";
    this.client = new SendblueAPI({ apiKey: credentials.apiKeyId, apiSecret: credentials.apiSecretKey,
      baseURL: operations.baseUrl ?? "https://api.sendblue.com", maxRetries: 0, logLevel: "off" });
  }
  agentInstructions(outputDirectory: string): string {
    return `You are chatting with the user through Sendblue over iMessage, RCS, or SMS. Prefer short, conversational replies unless the user asks for detail. Your final text response is sent automatically as a message.

To send an image or other file as an attachment, save it in ${JSON.stringify(outputDirectory)}. The gateway uploads and sends files from that directory. Images created with the image-generation tool are attached automatically.`;
  }

  inbound(value: unknown): IncomingMessage | undefined {
    const event = object(value);
    if (event.is_outbound !== false || event.status !== "RECEIVED" || event.message_type === "group" || event.group_id) return;
    const sender = string(event.from_number), sendblueNumber = string(event.sendblue_number);
    if (!/^\+[1-9]\d{6,14}$/.test(sender) || !/^\+[1-9]\d{6,14}$/.test(sendblueNumber)) throw new RouterError("input_invalid", "Invalid Sendblue number.");
    const providerTimeMs = Date.parse(string(event.date_sent));
    if (!Number.isFinite(providerTimeMs)) throw new RouterError("input_invalid", "Invalid Sendblue event time.");
    const text = event.content == null ? "" : typeof event.content === "string" ? event.content : string(undefined);
    const sourceUrl = event.media_url ? https(event.media_url) : undefined;
    let name = "attachment";
    if (sourceUrl) {
      try { name = decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || name); } catch { /* Keep a safe fallback name. */ }
      name = name.replace(/[\x00-\x1f\x7f/\\]/g, "_") || "attachment";
    }
    return { messageHandle: string(event.message_handle), sender, sendblueNumber, providerTimeMs, text,
      ...(sourceUrl ? { attachment: { sourceUrl, name } } : {}) };
  }
  callback(value: unknown): StatusCallback {
    const event = object(value);
    return { status: string(event.status), ...(event.message_handle ? { providerHandle: string(event.message_handle) } : {}) };
  }
  private async request(operation: (client: SendblueAPI, signal: AbortSignal) => APIPromise<unknown>,
    signal: AbortSignal, timeout: number, responseLimit = 256 * 1024): Promise<ProviderResponse> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout); timer.unref();
    let status = 0, headers = new Headers();
    const boundedFetch: typeof fetch = async (url, init) => {
      const response = await (this.operations.fetch ?? fetch)(url, { ...init, redirect: "error" });
      status = response.status; headers = response.headers;
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) {
        const cancel = () => { void reader.cancel().catch(() => undefined); };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          controller.signal.throwIfAborted();
          while (true) {
            const next = await reader.read();
            controller.signal.throwIfAborted();
            if (next.done) break;
            size += next.value.length;
            if (size > responseLimit) { await reader.cancel(); throw new Error("Response limit exceeded."); }
            chunks.push(next.value);
          }
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          if (controller.signal.aborted) await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      controller.signal.throwIfAborted();
      return new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : Buffer.concat(chunks),
        { status, headers });
    };
    try {
      controller.signal.throwIfAborted();
      // The SDK timeout ends at headers. Keep our deadline and response cap through parsing.
      const { data } = await operation(this.client.withOptions({ fetch: boundedFetch, timeout }), controller.signal).withResponse();
      controller.signal.throwIfAborted();
      return { status, headers, value: data, bodyFailed: false };
    } catch { return { status, headers, value: undefined, bodyFailed: true }; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }

  private checked(response: ProviderResponse): unknown {
    if (!response.bodyFailed && response.status >= 200 && response.status < 300) return response.value;
    const policy = retryPolicy(response.bodyFailed && response.status >= 200 && response.status < 300 ? 503 : response.status || 503, response.headers);
    throw new SendblueRequestError(policy.retryable, policy.retryAfterMs);
  }

  async list(query: SendblueListQuery, signal: AbortSignal): Promise<SendblueListPage> {
    return this.checked(await this.request((client, signal) => client.messages.list(query, { signal }), signal,
      this.operations.requestTimeoutMs ?? 60000, 2 * 1024 * 1024)) as SendblueListPage;
  }

  async getStatus(handle: string, signal: AbortSignal): Promise<MessageResponse> {
    return this.checked(await this.request((client, signal) => client.messages.getStatus({ handle }, { signal }), signal,
      this.operations.requestTimeoutMs ?? 60000)) as MessageResponse;
  }
  async send(route: import("./gateway.js").SendblueRecipient, part: DeliveryPart, callbackUrl: string | undefined, signal: AbortSignal): Promise<SendOutcome> {
    const payload = { number: route.sender!, from_number: route.sendblueNumber!, ...(callbackUrl ? { status_callback: callbackUrl } : {}),
      ...(part.payload.kind === "text" ? { content: part.payload.text } : { media_url: part.payload.mediaUrl }) };
    try {
      const response = await this.request((client, signal) => client.messages.send(payload, { signal }), signal, this.operations.requestTimeoutMs ?? 60000);
      const policy = retryPolicy(response.status || 503, response.headers);
      if (response.status >= 200 && response.status < 300) {
        const handle = response.value && typeof response.value === "object" ? (response.value as Record<string, unknown>).message_handle : undefined;
        return typeof handle === "string" && handle ? { status: "accepted", providerHandle: handle } : { status: "uncertain", ...policy, retryable: false };
      }
      // A rate-limit rejection is safe to retry; a lost or server-error response is not.
      const rejected = response.status === 429 || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409);
      return rejected ? { status: "rejected", ...policy } : { status: "uncertain", ...policy, retryable: false };
    } catch { return { status: "uncertain", retryable: false }; }
  }
  async upload(path: string, name: string, mediaType: string, signal: AbortSignal): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let policy: { retryable: boolean; retryAfterMs?: number } = { retryable: true };
      try {
        signal.throwIfAborted();
        const file = await openAsBlob(path, { type: mediaType });
        if (file.size > 100000000) throw new RouterError("output_too_large", "The artifact exceeds the Sendblue upload limit.");
        const form = new FormData(); form.set("file", file, name);
        const response = await this.request((client, signal) => client.post("/api/upload-file", { body: form, signal }), signal, this.operations.uploadTimeoutMs ?? 600000);
        policy = retryPolicy(response.bodyFailed ? 503 : response.status, response.headers);
        if (response.status >= 200 && response.status < 300) {
          try { return https(object(response.value).media_url); } catch { policy = retryPolicy(503, response.headers); }
        }
      } catch (error) { if (error instanceof RouterError) throw error; }
      if (signal.aborted || !policy.retryable || attempt === 2) break;
      await delay(policy.retryAfterMs ?? 500 * 2 ** attempt, signal);
    }
    throw new RouterError("turn_failed", "The Sendblue upload failed.");
  }
  async readReceipt(route: import("./gateway.js").SendblueRecipient, signal: AbortSignal): Promise<void> {
    this.checked(await this.request((client, signal) => client.post("/api/mark-read", {
      body: { number: route.sender, from_number: route.sendblueNumber }, signal }),
      signal, this.operations.requestTimeoutMs ?? 60000));
  }
  async typing(route: import("./gateway.js").SendblueRecipient, state: "start" | "stop", signal: AbortSignal): Promise<void> {
    this.checked(await this.request((client, signal) => client.typingIndicators.send({ number: route.sender!, from_number: route.sendblueNumber!, state,
      ...(state === "start" ? { max_duration_ms: 300000 } : {}) }, { signal }), signal, this.operations.requestTimeoutMs ?? 60000));
  }
}

export function sendblueCredentials(account: SendblueConfig, env: NodeJS.ProcessEnv = process.env): Credentials {
  const secret = (value: string | undefined, name: string | undefined): string => {
    const resolved = value ?? (name === undefined ? undefined : env[name]);
    if (!resolved?.trim() || /[\r\n]/.test(resolved)) {
      throw new RouterError("config_invalid", "A gateway credential is missing or invalid.");
    }
    return resolved;
  };
  return {
    apiKeyId: secret(account.apiKeyId, account.apiKeyIdEnv),
    apiSecretKey: secret(account.apiSecretKey, account.apiSecretKeyEnv),
    ...(account.mode === "webhook" ? { signingSecret: secret(account.webhookSecret, account.webhookSecretEnv) } : {}),
  };
}

export function sendblueConnectors(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): Map<string, Sendblue> {
  return new Map(config.sendblue.map((account) => [account.id, new Sendblue(sendblueCredentials(account, env))]));
}
