import { randomUUID } from "node:crypto";
import { routeSources, type GatewayConfig, type GatewayRoute, type SourceBinding } from "./config.js";
import type { SendblueProvider, GatewayFiles, GatewaySession, IncomingMessage, SendOutcome } from "./gateway.js";
import type { Batch, CodexWork, DeliveryPart, RetainedResult } from "./gateway-state.js";
import type { SourcePolicy, CompletionPlan } from "./gateway-connector.js";
import type { TurnOutcome } from "./turn-state.js";

export interface SourceAdapter {
  readonly binding: SourceBinding;
  readonly policy: SourcePolicy;
  prepare(batch: Batch, session: GatewaySession, signal: AbortSignal): Promise<Batch>;
  instructions(session: GatewaySession, signal: AbortSignal): Promise<{ publicationId?: string; instructions?: string }>;
  complete(work: CodexWork, outcome: TurnOutcome, session: GatewaySession, signal: AbortSignal): Promise<CompletionPlan>;
  typing?(active: boolean, signal: AbortSignal): Promise<void>;
  readReceipt?(signal: AbortSignal): Promise<void>;
  outbound?: {
    line: string;
    maxPerSecond: number;
    callbackUrl(partId: string, token: string): string | undefined;
    send(part: DeliveryPart, callbackUrl: string | undefined, signal: AbortSignal): Promise<SendOutcome>;
  };
}

/** Static composition: provider-specific behavior stops at this boundary. */
export function sourceAdapters(config: GatewayConfig, route: GatewayRoute, files: GatewayFiles,
  connector: (id: string) => SendblueProvider): SourceAdapter[] {
  return routeSources(route).map(binding => {
    if (binding.kind === "https") return {
      binding, policy: { batching: "immediate", retainTerminalResult: true, duplicateBehavior: "exact" },
      async prepare(batch) { return batch; },
      async instructions() { return {}; },
      async complete(_work, outcome) {
        return { kind: "retain", result: { status: outcome.status, text: outcome.finalText ?? "",
          notices: outcome.imageGenerations.length ? ["attachments_omitted"] : [] } };
      },
    };
    const provider = connector(binding.accountId);
    return {
      binding, policy: { batching: { quietMs: config.sendblue.find(account => account.id === binding.accountId)?.batchQuietMs ?? 5000, maximumMs: 30000 }, retainTerminalResult: false, duplicateBehavior: "first" },
      prepare: (batch, session, signal) => files.prepareBatch(route, batch, session, signal),
      async instructions(session, signal) {
        const publicationId = randomUUID();
        const directory = await files.publication(route, publicationId, session, signal);
        const instructions = provider.agentInstructions?.(directory);
        return { publicationId, ...(instructions === undefined ? {} : { instructions }) };
      },
      async complete(work, outcome, session, signal) {
        const parts = work.admissionFailed && !work.turnId
          ? [{ id: randomUUID(), status: "ready" as const, payload: { kind: "text" as const, text: "Codex did not confirm the latest input. It was not sent again." } }]
          : await files.delivery(route, work, outcome, session, provider, signal);
        return { kind: "deliver", parts, result: { status: outcome.status, text: outcome.finalText ?? "", notices: [] } };
      },
      typing: (active, signal) => provider.typing(route, active ? "start" : "stop", signal),
      readReceipt: async signal => { await provider.readReceipt?.(route, signal); },
      outbound: {
        line: binding.sendblueNumber, maxPerSecond: 10,
        callbackUrl: (partId, token) => config.sendblue.find(account => account.id === binding.accountId)?.mode === "webhook"
          ? `${config.publicUrl}/callbacks/sendblue/${binding.accountId}/${partId}/${token}` : undefined,
        send: (part, callbackUrl, signal) => provider.send(route, part, callbackUrl, signal),
      },
    };
  });
}

export function matchIncoming(config: GatewayConfig, accountId: string, message: IncomingMessage): { route: GatewayRoute; sourceId: string } | undefined {
  for (const route of config.routes) {
    const binding = routeSources(route).find(b => b.kind === "sendblue" && b.accountId === accountId && b.sender === message.sender && b.sendblueNumber === message.sendblueNumber);
    if (binding) return { route, sourceId: binding.id };
  }
  return undefined;
}
