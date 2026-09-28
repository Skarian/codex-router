import { randomUUID, createHash } from "node:crypto";
import { preparePrivateDirectory, assertPrivatePath, validateExistingPrivatePaths, syncDirectory } from "./platform-storage.js";
import { open, readFile, rename, rm } from "node:fs/promises";
import { acquireGatewayLock } from "./gateway-lock.js";
import { join } from "node:path";
import * as v from "valibot";

import { RouterError } from "./errors.js";

const str = v.pipe(v.string(), v.minLength(1));
const number = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const attachmentSchema = v.variant("state", [
  v.strictObject({ state: v.literal("pending"), sourceUrl: str, name: str }),
  v.strictObject({ state: v.literal("ready"), name: str, mediaType: str, inputKind: v.picklist(["image", "file"]), localPath: str, hostPath: str }),
  v.strictObject({ state: v.literal("omitted"), name: str, reason: v.picklist(["download_failed", "invalid_media", "copy_failed"]) }),
]);
const eventSchema = v.strictObject({ messageHandle: str, providerTimeMs: number, receiptSequence: number, text: v.string(), attachment: v.optional(attachmentSchema) });
const batchSchema = v.strictObject({ deliveryReserved: v.optional(v.literal(true)), id: str, sourceId: str, openedAtMs: number, quietDeadlineMs: number, maximumDeadlineMs: number, events: v.array(eventSchema) });
const intentSchema = v.strictObject({ batchId: str, clientUserMessageId: str, publicationId: v.optional(str), expectedTurnId: v.optional(str) });
const executionBindingSchema = v.strictObject({ backend: v.picklist(["desktop", "proxy", "stdio"]), host: str, codexHome: str, threadId: str });
const workSchema = v.strictObject({
  kind: v.literal("codex"), ownerBatchId: str, joinedBatchIds: v.array(str), batches: v.array(batchSchema), turnId: v.optional(str),
  pendingAdmission: v.optional(intentSchema), binding: v.optional(executionBindingSchema), clientUserMessageId: v.optional(str), publicationIds: v.array(str), artifactBaseline: v.array(str), admissionFailed: v.optional(v.literal(true)), failedBatchIds: v.optional(v.array(str)),
});
const payloadSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("text"), text: v.string() }),
  v.strictObject({ kind: v.literal("media"), localPath: str, name: str, mediaType: str, mediaUrl: str }),
]);
const partSchema = v.strictObject({ id: str, payload: payloadSchema, status: v.picklist(["ready", "sending", "accepted", "failed", "skipped"]), callbackToken: v.optional(str), providerHandle: v.optional(str) });
const destinationSchema = v.strictObject({ id: str, namespace: str, properties: v.record(str, v.string()) });
const sourceSchema = v.strictObject({ id: str, namespace: str, destination: v.optional(destinationSchema) });
const artifactSchema = v.strictObject({ localPath: str, name: str, mediaType: str, size: number });
const deliverySchema = v.strictObject({ kind: v.literal("delivery"), id: str, sourceId: str, batchIds: v.array(str), parts: v.array(partSchema),
  destination: destinationSchema, completionId: str, sequence: number, prepared: v.boolean(), reservedBytes: number });
const resultSchema = v.strictObject({ status: v.picklist(["completed", "failed", "interrupted"]), text: v.string(), notices: v.array(v.string()) });
const receiptSchema = v.strictObject({ sourceId: str, externalId: str, receivedAtMs: number,
  namespace: str, completionId: v.optional(str), payloadHash: v.optional(str), batchId: v.optional(str),
  reservedBytes: v.optional(number) });
const bindingSchema = v.strictObject({ sources: v.array(sourceSchema), target: v.strictObject({ sshHost: v.nullable(str), threadId: str, cwd: str }) });
const completionFields = { id: str, artifacts: v.array(artifactSchema), turnId: v.optional(str), expiresAtMs: number };
const completionSchema = v.strictObject({ ...completionFields, result: resultSchema });
const routeSchema = v.strictObject({
  binding: bindingSchema, nextSequence: number, receipts: v.array(receiptSchema),
  openBatch: v.optional(batchSchema), queue: v.array(batchSchema), active: v.optional(workSchema),
  completions: v.record(str, completionSchema), outbox: v.array(deliverySchema),
});
const pollingSchema = v.strictObject({ activationAtMs: number, completedThroughMs: number, routeActivationAtMs: v.record(str, number) });
const stateSchema = v.strictObject({ version: v.literal(3), nextDeliverySequence: number, routes: v.record(str, routeSchema), polling: v.optional(v.record(str, pollingSchema)) });
export type Destination = v.InferOutput<typeof destinationSchema>;
export type SourceBinding = v.InferOutput<typeof sourceSchema>;
export type StagedArtifact = v.InferOutput<typeof artifactSchema>;
export type Completion = v.InferOutput<typeof completionSchema>;
export interface StagedCompletion { result: RetainedResult; artifacts: StagedArtifact[] }
export const OUTBOX_METADATA_BYTES = 2 * 1024 * 1024;
export type Receipt = v.InferOutput<typeof receiptSchema>;
export type RetainedResult = v.InferOutput<typeof resultSchema>;
export type GatewayState = v.InferOutput<typeof stateSchema>;
export type RouteState = v.InferOutput<typeof routeSchema>;
export type RouteBinding = v.InferOutput<typeof bindingSchema>;
export type Batch = v.InferOutput<typeof batchSchema>;
export type InboundEvent = v.InferOutput<typeof eventSchema>;
export type InboundAttachment = v.InferOutput<typeof attachmentSchema>;
export type CodexWork = v.InferOutput<typeof workSchema>;
export type AdmissionIntent = v.InferOutput<typeof intentSchema>;
export type Delivery = v.InferOutput<typeof deliverySchema>;
export type DeliveryPart = v.InferOutput<typeof partSchema>;
export const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ADMISSION_FAILURE = "Codex did not confirm the latest input. It was not sent again.";

/** Delivery pinning retains files and results, never an expired request identity. */
export function receiptVisible(route: RouteState, receipt: Receipt, now: number): boolean {
  if (!receipt.completionId) return true;
  const completion = route.completions[receipt.completionId];
  if (!completion) throw new RouterError("state_invalid", "Receipt completion is missing.");
  return completion.expiresAtMs > now;
}

export function validateState(value: unknown): GatewayState {
  if (value && typeof value === "object" && "version" in value && value.version !== 3) {
    throw new RouterError("state_invalid", "Unsupported gateway state version. This build requires version 3.");
  }
  const parsed = v.safeParse(stateSchema, value);
  if (!parsed.success) throw new RouterError("state_invalid", "The canonical gateway state is invalid.");
  const state = parsed.output;
  for (const poll of Object.values(state.polling ?? {})) {
    if (poll.completedThroughMs < poll.activationAtMs || Object.values(poll.routeActivationAtMs).some(time => time < poll.activationAtMs)) {
      throw new RouterError("state_invalid", "The polling checkpoint is invalid.");
    }
  }
  const partIds = new Set<string>();
  const jobIds = new Set<string>();
  const sequences = new Set<number>();
  for (const route of Object.values(state.routes)) {
    for (const [id, completion] of Object.entries(route.completions)) {
      if (id !== completion.id || (Buffer.byteLength(completion.result.text) > 256 * 1024 || Buffer.byteLength(JSON.stringify(completion.result.notices)) > 4096)) throw new RouterError("state_invalid", "Canonical completion is invalid.");
    }
    const work = route.active;
    const sources = route.binding.sources;
    if (new Set(sources.map(s => s.id)).size !== sources.length) throw new RouterError("state_invalid", "Gateway source bindings are invalid.");
    const batches = [...(route.openBatch ? [route.openBatch] : []), ...route.queue, ...(work?.kind === "codex" ? work.batches : [])];
    for (const batch of batches) if (!sources.some(s => s.id === batch.sourceId)) throw new RouterError("state_invalid", "A batch has no configured source.");
    const ids = new Set<string>();
    for (const receipt of route.receipts) {
      const key = JSON.stringify([receipt.sourceId, receipt.externalId]);
      if (ids.has(key)) throw new RouterError("state_invalid", "Duplicate submission receipt.");
      ids.add(key);
      if (receipt.namespace === "http" && !receipt.payloadHash) throw new RouterError("state_invalid", "HTTP receipt lost its exact payload identity.");
      if (receipt.completionId && !route.completions[receipt.completionId]) throw new RouterError("state_invalid", "Receipt completion is missing.");
      const retained = receipt.payloadHash !== undefined || receipt.completionId !== undefined || receipt.reservedBytes !== undefined;
      if (retained) {
        const batch = batches.find(b => b.id === receipt.batchId);
        if (!receipt.batchId || receipt.reservedBytes === undefined
          || (receipt.completionId ? !!batch : !batch || batch.sourceId !== receipt.sourceId
            || !batch.events.some(e => e.messageHandle === receipt.externalId))) throw new RouterError("state_invalid", "Retained receipt has invalid execution references.");
        if (receipt.completionId) {
          if (Buffer.byteLength(JSON.stringify(receipt)) > receipt.reservedBytes) throw new RouterError("state_invalid", "Retained receipt exceeds its reserved capacity.");
        } else {
          if (receipt.namespace === "http" && batch!.events.length !== 1) throw new RouterError("state_invalid", "HTTP batch has multiple inputs.");
          const text = batch!.events[0]!.text;
          const hash = createHash("sha256").update(JSON.stringify([1, text])).digest("hex");
          const minimum = Buffer.byteLength(JSON.stringify({ text })) + 6 * 256 * 1024 + 16 * 1024;
          if (receipt.payloadHash !== undefined && (receipt.payloadHash !== hash || receipt.reservedBytes < minimum)) throw new RouterError("state_invalid", "Retained request identity or reservation is invalid.");
        }
      }
    }
    const batchIds = new Set<string>();
    for (const batch of [...(route.openBatch ? [route.openBatch] : []), ...route.queue, ...(work?.kind === "codex" ? work.batches : [])]) {
      if (batchIds.has(batch.id) || !batch.events.length || batch.quietDeadlineMs < batch.openedAtMs || batch.maximumDeadlineMs < batch.openedAtMs) {
        throw new RouterError("state_invalid", "The gateway batch references are invalid.");
      }
      batchIds.add(batch.id);
    }
    if (work?.kind === "codex") {
      if (work.failedBatchIds && (new Set(work.failedBatchIds).size !== work.failedBatchIds.length || work.failedBatchIds.some(id => !work.batches.some(batch => batch.id === id) || work.joinedBatchIds.includes(id)))) throw new RouterError("state_invalid", "Failed admission references are invalid.");
      if (work.binding && (work.binding.host !== (route.binding.target.sshHost ?? "local")
        || work.binding.threadId !== route.binding.target.threadId
        || (work.binding.backend === "desktop" && (!work.clientUserMessageId || work.binding.host !== "local")))) {
        throw new RouterError("state_invalid", "The gateway execution binding does not match its route or lacks its admission identity.");
      }
      const owned = new Set(work.batches.map((batch) => batch.id));
      if (!owned.has(work.ownerBatchId) || work.joinedBatchIds.some((id) => !owned.has(id) || id === work.ownerBatchId)
        || new Set(work.joinedBatchIds).size !== work.joinedBatchIds.length
        || (work.pendingAdmission && (!owned.has(work.pendingAdmission.batchId)
          || (work.pendingAdmission.publicationId !== undefined && !work.publicationIds.includes(work.pendingAdmission.publicationId))
          || work.joinedBatchIds.includes(work.pendingAdmission.batchId)))) {
        throw new RouterError("state_invalid", "The gateway admission references are invalid.");
      }
    }
    for (const work of route.outbox) {
      if (jobIds.has(work.id) || sequences.has(work.sequence) || work.sequence >= state.nextDeliverySequence || (!work.prepared && work.parts.length)) throw new RouterError("state_invalid", "Outbox identity or preparation is invalid.");
      jobIds.add(work.id); sequences.add(work.sequence);
      if (!route.completions[work.completionId]) throw new RouterError("state_invalid", "Outbox completion is missing.");
      const ids = new Set<string>();
      let unfinished = false;
      let blocked = false;
      for (const part of work.parts) {
        if (partIds.has(part.id) || ids.has(part.id) || (part.status === "sending" ? !part.callbackToken || !!part.providerHandle
          : part.status === "accepted" ? !part.providerHandle || !!part.callbackToken : !!part.callbackToken || !!part.providerHandle)
          || (unfinished && (part.status === "accepted" || part.status === "sending"))
          || (blocked && part.status !== "skipped")) throw new RouterError("state_invalid", "The gateway delivery order is invalid.");
        ids.add(part.id); partIds.add(part.id);
        unfinished ||= part.status !== "accepted";
        blocked ||= part.status === "failed";
      }
    }
  }
  return state;
}

export function bindTargets(state: GatewayState, targets: readonly { id: string; binding: RouteBinding }[]): void {
  for (const [id, stored] of Object.entries(state.routes)) {
    const current = targets.find(route => route.id === id);
    const pending = [...(stored.openBatch ? [stored.openBatch] : []), ...stored.queue, ...(stored.active?.kind === "codex" ? stored.active.batches : [])];
    const pendingSources = new Set(pending.map(b => b.sourceId));
    if (stored.outbox.length && (!current || JSON.stringify(stored.binding.target) !== JSON.stringify(current.binding.target))) throw new RouterError("config_invalid", "A target with pending delivery changed.");
    if (pendingSources.size && (!current || JSON.stringify(stored.binding.target) !== JSON.stringify(current.binding.target)
      || [...pendingSources].some(sourceId => JSON.stringify(stored.binding.sources.find(s => s.id === sourceId)) !== JSON.stringify(current.binding.sources.find(s => s.id === sourceId))))) {
      throw new RouterError("config_invalid", "A route with pending work changed its recipient or Codex target.");
    }
  }
  for (const route of targets) {
    const previous = Object.hasOwn(state.routes, route.id) ? state.routes[route.id] : undefined;
    state.routes[route.id] = previous
      ? { ...previous, binding: route.binding }
      : { binding: route.binding, nextSequence: 0, receipts: [], queue: [], outbox: [], completions: {} };
  }
}

const ownerOnly = assertPrivatePath;

async function writeSynced(path: string, data: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
}

export class GatewayStore {
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private closed = false;
  private closeFlight: Promise<void> | undefined;
  private constructor(readonly directory: string, private state: GatewayState, private readonly unlock: () => Promise<void>,
    private readonly beforeWrite?: () => Promise<void>) {}

  static async open(directory: string, beforeWrite?: () => Promise<void>): Promise<GatewayStore> {
    await preparePrivateDirectory(directory);
    const unlock = await acquireGatewayLock(directory);
    try {
      let state: GatewayState = { version: 3, nextDeliverySequence: 0, routes: {} };
      try {
        await validateExistingPrivatePaths([join(directory, "state.json")]);
        await ownerOnly(join(directory, "state.json"), false);
        state = validateState(JSON.parse(await readFile(join(directory, "state.json"), "utf8")));
      } catch (error) {
        if (error instanceof RouterError && error.code === "state_invalid") throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RouterError("state_invalid", "The canonical gateway state cannot be loaded.", { cause: error });
      }
      return new GatewayStore(directory, state, unlock, beforeWrite);
    } catch (error) { await unlock(); throw error; }
  }

  snapshot(): GatewayState { return structuredClone(this.state); }

  /** Internal read-only projection: copy only the requested view, not the whole retained-result archive. */
  read<T>(select: (state: GatewayState) => T): T { return structuredClone(select(this.state)); }

  transaction<T>(change: (draft: GatewayState) => T): Promise<T> {
    if (this.closeFlight) return Promise.reject(new RouterError("storage_failed", "The gateway state writer is closed."));
    const operation = this.queue.then(async () => {
      if (this.closed || this.poisoned) throw new RouterError("storage_failed", "The gateway state writer is unavailable.");
      const draft = structuredClone(this.state);
      const result = change(draft);
      if (result instanceof Promise) throw new RouterError("state_invalid", "A gateway state transaction must be synchronous.");
      const cutoff = Date.now() - SEEN_RETENTION_MS;
      for (const route of Object.values(draft.routes)) {
        route.receipts = route.receipts.filter(r => r.reservedBytes !== undefined ? receiptVisible(route, r, Date.now()) : r.receivedAtMs >= cutoff);
      }
      for (const route of Object.values(draft.routes)) {
        const pinned = new Set(route.outbox.map(job => job.completionId));
        for (const [id, completion] of Object.entries(route.completions)) if (!pinned.has(id) && completion.expiresAtMs <= Date.now()) delete route.completions[id];
      }
      validateState(draft);
      await this.beforeWrite?.();
      const temp = join(this.directory, `state-${randomUUID()}.tmp`);
      let renamed = false;
      try {
        await writeSynced(temp, JSON.stringify(draft));
        await rename(temp, join(this.directory, "state.json")); renamed = true;
        await syncDirectory(this.directory);
        this.state = draft;
      } catch (cause) {
        if (renamed) this.poisoned = true;
        throw new RouterError("storage_failed", "The gateway snapshot could not be stored.", { cause });
      } finally { await rm(temp, { force: true }).catch(() => undefined); }
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    this.closeFlight ??= (async () => { await this.queue; this.closed = true; await this.unlock(); })();
    return this.closeFlight;
  }
}

export function unresolved(state: GatewayState): { unresolved: Array<{ routeId: string; effectId: string; kind: "codex_admission" | "send" }> } {
  return { unresolved: Object.entries(state.routes).flatMap(([routeId, route]) => [
    ...(route.active?.pendingAdmission ? [{ routeId, effectId: route.active.pendingAdmission.clientUserMessageId, kind: "codex_admission" as const }] : []),
    ...route.outbox.flatMap(job => job.parts.filter(part => part.status === "sending").map(part => ({ routeId, effectId: part.id, kind: "send" as const }))),
  ]) };
}

export function settlePart(part: DeliveryPart, delivery: Delivery, outcome: { status: "accepted"; providerHandle: string } | { status: "failed" }): void {
  part.status = outcome.status;
  delete part.callbackToken;
  if (outcome.status === "accepted") part.providerHandle = outcome.providerHandle;
  else for (const later of delivery.parts.slice(delivery.parts.indexOf(part) + 1)) if (later.status === "ready") later.status = "skipped";
}

export function resolveEffect(state: GatewayState, routeId: string, effectId: string, resolution: "failed" | "accepted", providerHandle?: string) {
  const active = state.routes[routeId]?.active;
  if (active?.kind === "codex" && active.pendingAdmission?.clientUserMessageId === effectId && resolution === "failed") {
    active.failedBatchIds = [...(active.failedBatchIds ?? []), active.pendingAdmission.batchId];
    if (active.pendingAdmission.publicationId) active.publicationIds = active.publicationIds.filter(id => id !== active.pendingAdmission!.publicationId);
    delete active.pendingAdmission; active.admissionFailed = true;
  } else {
    const delivery = state.routes[routeId]?.outbox.find(job => job.parts.some(part => part.id === effectId));
    const part = delivery?.parts.find((part) => part.id === effectId && part.status === "sending");
    if (!part || (resolution === "accepted" && !providerHandle)) throw new RouterError("effect_not_found", "The unresolved effect was not found.");
    settlePart(part, delivery!, resolution === "accepted" ? { status: "accepted", providerHandle: providerHandle! } : { status: "failed" });
  }
  return { type: "resolved", routeId, effectId, resolution, ...(resolution === "accepted" ? { providerHandle } : {}) };
}
