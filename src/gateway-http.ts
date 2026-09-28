import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Gateway, SubmissionFailure } from "./gateway.js";
import { listAgents } from "./agent-catalog.js";
import { writeProgressStream } from "./http-progress.js";

export const HTTP_BODY_LIMIT = 512 * 1024;
export class HttpFailure extends Error { constructor(readonly status: number, readonly code = "invalid_request") { super(code); } }

export async function handleHttp(gateway: Gateway, request: IncomingMessage,
  response: ServerResponse, body: () => Promise<string>): Promise<boolean> {
  const path = (request.url ?? "").split("?")[0]!;
  if (!gateway.config.http?.api) return false;
  const json = (status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  if (path === "/v1/agents") {
    if (request.method !== "GET") throw new HttpFailure(405);
    json(200, listAgents(gateway.config.agents));
    return true;
  }
  const match = /^\/v1\/agents\/([a-z][a-z0-9-]*)\/(requests(?:\/([0-9a-f-]+)(\/events)?)?|cancel)$/.exec(path);
  if (!match) return false;
  const agent = gateway.config.agents.find(agent => agent.id === match[1]);
  if (!agent) throw new HttpFailure(404, "not_found");
  const sourceId = "http", id = match[3];
  const readInput = async (): Promise<Record<string, unknown>> => {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new HttpFailure(415);
    if (Number(request.headers["content-length"] ?? 0) > HTTP_BODY_LIMIT) throw new HttpFailure(413, "input_too_large");
    let value: unknown;
    try { value = JSON.parse(await body()); } catch (error) { if (error instanceof HttpFailure) throw error; throw new HttpFailure(400); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpFailure(400);
    return value as Record<string, unknown>;
  };
  if (match[2] === "cancel") {
    if (request.method !== "POST") throw new HttpFailure(405);
    if (!gateway.ready) throw new HttpFailure(503, "not_ready");
    const value = await readInput();
    if (Object.keys(value).some(key => key !== "expected_turn_id") || typeof value.expected_turn_id !== "string"
      || !value.expected_turn_id.trim() || value.expected_turn_id.length > 512) throw new HttpFailure(400);
    try {
      const result = await gateway.cancel(agent.id, value.expected_turn_id);
      json(result.type === "interrupt_requested" ? 202 : 200, result);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        const code = String(error.code);
        if (code === "interrupt_uncertain") throw new HttpFailure(503, code);
        if (["interrupt_unsupported", "interrupt_conflict", "admission_unresolved"].includes(code)) throw new HttpFailure(409, code);
      }
      throw error;
    }
    return true;
  }
  if (!id) {
    if (request.method !== "POST") throw new HttpFailure(405);
    if (!gateway.ready) throw new HttpFailure(503, "not_ready");
    const value = await readInput();
    if (Object.keys(value).some(key => key !== "request_id" && key !== "text") || typeof value.request_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.request_id)
      || typeof value.text !== "string" || !value.text.trim()) throw new HttpFailure(400);
    if (Buffer.byteLength(value.text) > 64 * 1024) throw new HttpFailure(413, "input_too_large");
    const payloadHash = createHash("sha256").update(JSON.stringify([1, value.text])).digest("hex");
    try { await gateway.submit(agent.id, { sourceId, externalId: value.request_id, payloadHash, input: { text: value.text } }); }
    catch (error) { if (error instanceof SubmissionFailure) throw new HttpFailure(error.code === "request_conflict" ? 409 : 429, error.code); throw error; }
    json(202, { ...gateway.request(agent.id, sourceId, value.request_id), result_url: `/v1/agents/${agent.id}/requests/${value.request_id}` });
    return true;
  }
  if (request.method !== "GET") throw new HttpFailure(405);
  const result = gateway.request(agent.id, sourceId, id);
  if (!result) throw new HttpFailure(404, "not_found");
  if (!match[4]) { json(200, result); return true; }
  const cursor = request.headers["last-event-id"];
  if (Array.isArray(cursor)) throw new HttpFailure(400);
  const requestKey = gateway.requestKey(agent.id, sourceId, id);
  const opened = writeProgressStream({ hub: gateway.progress, requestKey, accountId: requestKey, response,
    ...(cursor === undefined ? {} : { cursor }), snapshot: () => {
      const current = gateway.request(agent.id, sourceId, id);
      if (!current) throw new HttpFailure(404, "not_found");
      const { result, ...status } = current;
      return { status, ...(result ? { terminal: { id, kind: "terminal" as const, text: result.text, metadata: { status: result.status, notices: result.notices } } } : {}) };
    } });
  if (!opened) throw new HttpFailure(429, "stream_limit");
  return true;
}
