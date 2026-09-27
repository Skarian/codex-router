import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Gateway, secretEqual, SubmissionFailure } from "./gateway.js";
import type { HttpsConfig } from "./config.js";
import { RouterError } from "./errors.js";
import { writeProgressStream } from "./gateway-progress.js";

export const HTTPS_BODY_LIMIT = 512 * 1024;
export class HttpFailure extends Error { constructor(readonly status: number, readonly code = "invalid_request") { super(code); } }

export function httpsCredentials(accounts: readonly HttpsConfig[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const account of accounts) {
    const token = account.bearerToken ?? process.env[account.bearerTokenEnv ?? ""];
    if (!token || /\s/.test(token)) throw new RouterError("config_invalid", "An HTTPS bearer token is missing or invalid.");
    if ([...result.values()].includes(token)) throw new RouterError("config_invalid", "HTTPS accounts must use distinct bearer tokens.");
    result.set(account.id, token);
  }
  return result;
}

export async function handleHttps(gateway: Gateway, tokens: ReadonlyMap<string, string>, request: IncomingMessage,
  response: ServerResponse, body: () => Promise<string>): Promise<boolean> {
  const path = (request.url ?? "").split("?")[0]!;
  const match = /^\/v1\/routes\/([a-z][a-z0-9-]*)\/requests(?:\/([0-9a-f-]+)(\/events)?)?$/.exec(path);
  if (!match) return false;
  const auth = request.headers.authorization;
  const token = typeof auth === "string" ? /^Bearer ([^\s]+)$/i.exec(auth)?.[1] : undefined;
  const account = token ? [...tokens].find(([, value]) => secretEqual(value, token))?.[0] : undefined;
  if (!account) throw new HttpFailure(401, "unauthorized");
  const route = gateway.config.routes.find(r => r.id === match[1] && r.httpsId === account);
  if (!route) throw new HttpFailure(404, "not_found");
  const sourceId = `https:${account}`;
  const id = match[2];
  const json = (status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  if (!id) {
    if (request.method !== "POST") throw new HttpFailure(405);
    if (!gateway.ready) throw new HttpFailure(503, "not_ready");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new HttpFailure(415);
    if (Number(request.headers["content-length"] ?? 0) > HTTPS_BODY_LIMIT) throw new HttpFailure(413, "input_too_large");
    let value: unknown;
    try { value = JSON.parse(await body()); } catch (error) { if (error instanceof HttpFailure) throw error; throw new HttpFailure(400); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpFailure(400);
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(k => k !== "request_id" && k !== "text") || typeof v.request_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.request_id)
      || typeof v.text !== "string" || !v.text.trim()) throw new HttpFailure(400);
    if (Buffer.byteLength(v.text) > 64 * 1024) throw new HttpFailure(413, "input_too_large");
    const payloadHash = createHash("sha256").update(JSON.stringify([1, v.text])).digest("hex");
    try { await gateway.submit(route.id, { sourceId, externalId: v.request_id, payloadHash, input: { text: v.text } }); }
    catch (error) { if (error instanceof SubmissionFailure) throw new HttpFailure(error.status, error.code); throw error; }
    const result = gateway.request(route.id, sourceId, v.request_id)!;
    json(202, { ...result, result_url: `/v1/routes/${route.id}/requests/${v.request_id}` });
    return true;
  }
  if (request.method !== "GET") throw new HttpFailure(405);
  const result = gateway.request(route.id, sourceId, id);
  if (!result) throw new HttpFailure(404, "not_found");
  if (!match[3]) { json(200, result); return true; }
  const cursor = request.headers["last-event-id"];
  if (Array.isArray(cursor)) throw new HttpFailure(400);
  const opened = writeProgressStream({ hub: gateway.progress, requestKey: gateway.requestKey(route.id, sourceId, id), accountId: account, response,
    ...(cursor === undefined ? {} : { cursor }),
    snapshot: () => {
      const current = gateway.request(route.id, sourceId, id);
      if (!current) throw new HttpFailure(404, "not_found");
      const { result, ...status } = current;
      return { status, ...(result ? { terminal: { id, kind: "terminal" as const, text: result.text, metadata: { status: result.status, notices: result.notices } } } : {}) };
    },
  });
  if (!opened) throw new HttpFailure(429, "stream_limit");
  return true;
}
