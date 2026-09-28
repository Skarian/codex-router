import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { AgentConfig } from "./config.js";
import { RouterError } from "./errors.js";
import { RpcRequestError } from "./json-rpc.js";
import { TurnEndedError, type TurnInput } from "./turn-session.js";
import { executionBinding, openExecutionSession, verifyExecutionBinding, type ExecutionSession } from "./execution-session.js";

import type { Submission, SourcePolicy } from "./request-types.js";
import { RequestProgress } from "./request-progress.js";
import type { Receipt } from "./gateway-state.js";
import type { TurnOutcome } from "./turn-state.js";
import { receiptVisible, bindTargets, GatewayStore, settlePart, type Batch, type CodexWork, type Delivery, type DeliveryPart, type GatewayState, type InboundEvent, type RouteBinding, type SourceBinding, type Destination, type Completion, type StagedArtifact, type StagedCompletion, OUTBOX_METADATA_BYTES, ADMISSION_FAILURE } from "./gateway-state.js";


export type SendOutcome =
  | { status: "accepted"; providerHandle: string }
  | { status: "rejected" | "uncertain"; retryable: boolean; retryAfterMs?: number };
export interface DeliveryCallback { status: "accepted" | "failed" | "pending"; providerHandle?: string }
export interface ProcessingStatus { routeId: string; state: "idle" | "running" | "retrying" | "blocked" | "unresolved"; code?: string }
export interface RequestAdapter {
  readonly binding: SourceBinding;
  readonly policy: SourcePolicy;
  prepare(batch: Batch, session: ExecutionSession, signal: AbortSignal): Promise<Batch>;
  instructions(session: ExecutionSession, signal: AbortSignal): Promise<{ publicationId?: string; instructions?: string }>;
  typing?(active: boolean, signal: AbortSignal): Promise<void>;
  readReceipt?(signal: AbortSignal): Promise<void>;
  outbound?: {
    prepare(completion: Completion, destination: Destination, signal: AbortSignal): Promise<DeliveryPart[]>;
    callbackNamespace: string;
    line: string;
    maxPerSecond: number;
    callbackUrl(partId: string, token: string): string | undefined;
    send(part: DeliveryPart, callbackUrl: string | undefined, signal: AbortSignal, destination: Destination): Promise<SendOutcome>;
  };
}
export interface RuntimeTarget { id: string; agent: AgentConfig; binding: RouteBinding; adapters: RequestAdapter[] }
export interface RuntimeSettings { targets: RuntimeTarget[]; maxRequests?: number; retainedBytes?: number; outboxJobs?: number; destinationJobs?: number; preparationSlots?: number }
export interface RuntimeOperations {
  outbound?(destination: Destination): NonNullable<RequestAdapter["outbound"]>;
  stage(target: RuntimeTarget, work: CodexWork, outcome: TurnOutcome, session: ExecutionSession, signal: AbortSignal): Promise<StagedCompletion>;
  cleanup(state: GatewayState): Promise<void>;
  release?(target: RuntimeTarget, active: CodexWork | readonly StagedArtifact[], session?: ExecutionSession): Promise<void>;
  reconcile(target: RuntimeTarget, state: GatewayState, session: ExecutionSession, signal: AbortSignal): Promise<void>;
  openSession?(target: RuntimeTarget, signal: AbortSignal): Promise<ExecutionSession>;
  now?(): number;
  retryDelayMs?(attempt: number): number;
}
interface Worker {
  running?: Promise<void>;
  again: boolean;
  session?: ExecutionSession;
  observation?: Promise<void>;
  outcome?: TurnOutcome;
  error?: unknown;
  observationError?: unknown;
  retryAttempt?: number;
  retryAt?: number;
  retryCode?: string;
  retryTimer?: NodeJS.Timeout;
  timer?: NodeJS.Timeout;
  typingTimer?: NodeJS.Timeout;
  typingSource?: RequestAdapter;
  cancelFlight?: Promise<unknown>;
}
interface LiveSend {
  attemptsStarted: number;
  abort: AbortController;
  settlement?: { status: "accepted"; providerHandle: string } | { status: "failed" };
  persistence?: Promise<void>;
  durable: boolean;
  running: boolean;
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { finish(); reject(new RouterError("interrupted", "The gateway operation stopped.")); };
    const deadline = Date.now() + Math.max(0, ms);
    const tick = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { finish(); resolve(); }
      else { timer = setTimeout(tick, Math.min(remaining, 2147483647)); timer.unref(); }
    };
    let timer = setTimeout(tick, Math.min(Math.max(0, ms), 2147483647)); timer.unref();
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

function batchInput(batch: Batch, instructions?: string): TurnInput[] {
  const input: TurnInput[] = [];
  for (const event of [...batch.events].sort((a, b) => a.providerTimeMs - b.providerTimeMs || a.receiptSequence - b.receiptSequence)) {
    if (event.text) input.push({ type: "text", text: event.text, text_elements: [] });
    const file = event.attachment;
    if (file?.state === "ready") {
      if (file.inputKind === "image") input.push({ type: "localImage", path: file.hostPath });
      else input.push({ type: "text", text: `Attached file: ${JSON.stringify(file.name)} (${file.mediaType}) at ${JSON.stringify(file.hostPath)}.`, text_elements: [] });
    } else if (file?.state === "omitted") input.push({ type: "text", text: `Attachment omitted: ${JSON.stringify(file.name)} (${file.reason}).`, text_elements: [] });
  }
  if (instructions) input.push({ type: "text", text: instructions, text_elements: [] });
  return input;
}

function staleSteer(error: unknown): boolean {
  return error instanceof RpcRequestError && error.payload.code === -32600 &&
    (error.payload.message === "no active turn to steer" || /^expected active turn id `[^`]+` but found `[^`]+`$/.test(error.payload.message ?? ""));
}

export class RequestRuntime {
  ready = false;
  readonly progress = new RequestProgress();
  private readonly adapters = new Map<string, RequestAdapter[]>();
  private readonly abort = new AbortController();
  private readonly workers = new Map<string, Worker>();
  private readonly live = new Map<string, LiveSend>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly outboxWorkers = new Map<string, Promise<void>>();
  private readonly outboxErrors = new Map<string, unknown>();
  private readonly preparing = new Map<string, { sourceId: string; targetId: string; promise: Promise<void> }>();
  private readonly prepared = new Map<string, Batch>();
  private readonly lineStarts = new Map<string, number[]>();
  private readonly now: () => number;
  constructor(readonly settings: RuntimeSettings, readonly store: GatewayStore, readonly lifecycle: RuntimeOperations) {
    this.now = lifecycle.now ?? Date.now;
    for (const route of settings.targets) {
      this.workers.set(route.id, { again: false });
      this.adapters.set(route.id, route.adapters);
    }
  }

  /** Scheduling and file cleanup need identities and work, never retained response text. */
  private executionState(): GatewayState {
    return this.store.read(state => ({ ...state, routes: Object.fromEntries(Object.entries(state.routes).map(([id, route]) => [id, {
      ...route, completions: Object.fromEntries(Object.entries(route.completions).map(([key, completion]) => [key, { ...completion, result: { ...completion.result, text: "" } }])),
    }])) }));
  }

  async start(): Promise<void> {
    await this.store.transaction((state) => bindTargets(state, this.settings.targets.map(target => ({ id: target.id, binding: target.binding }))));
    await this.lifecycle.cleanup(this.executionState());
    this.ready = true;
    for (const route of this.settings.targets) this.wake(route.id);
    this.wakeOutbox();
  }

  private source(route: RuntimeTarget, sourceId: string): RequestAdapter {
    const adapters = this.adapters.get(route.id)!;
    const adapter = adapters.find(a => a.binding.id === sourceId) ?? [...this.adapters.values()].flat().find(a => a.binding.id === sourceId);
    if (!adapter) throw new RouterError("state_invalid", "The work source is unavailable.");
    return adapter;
  }

  private activeSource(route: RuntimeTarget): RequestAdapter | undefined {
    const state = this.executionState().routes[route.id];
    const active = state?.active;
    const sourceId = active?.kind === "codex" ? (active.batches.find(batch => this.source(route, batch.sourceId).typing)?.sourceId ?? active.batches[0]?.sourceId) : undefined;
    if (sourceId) return this.source(route, sourceId);
    const batch = state?.queue[0] ?? state?.openBatch;
    return batch ? this.source(route, batch.sourceId) : this.adapters.get(route.id)?.[0];
  }

  async submit(routeId: string, submission: Submission): Promise<Receipt> {
    if (!this.ready) throw new RouterError("storage_failed", "Gateway intake is not ready.");
    const route = this.settings.targets.find(r => r.id === routeId);
    if (!route) throw new RouterError("input_invalid", "Unknown route.");
    const adapter = this.source(route, submission.sourceId);
    const now = this.now();
    const activeTurn = this.store.read(state => state.routes[routeId]?.active?.kind === "codex");
    const { quietMs, maximumMs } = activeTurn || adapter.policy.batching === "immediate" ? { quietMs: 0, maximumMs: 0 } : adapter.policy.batching;
    const lookup = (state: GatewayState) => adapter.policy.duplicateBehavior === "exact"
      ? state.routes[route.id]!.receipts.find(r => r.sourceId === submission.sourceId && r.externalId === submission.externalId && receiptVisible(state.routes[route.id]!, r, now))
      : Object.values(state.routes).flatMap(r => r.receipts).find(r => r.namespace === adapter.binding.namespace && r.externalId === submission.externalId && r.receivedAtMs > now - 30 * 24 * 60 * 60 * 1000);
    const verify = (receipt: Receipt) => {
      if (adapter.policy.duplicateBehavior === "exact" && receipt.payloadHash !== submission.payloadHash) throw new SubmissionFailure("request_conflict");
      return receipt;
    };
    // A committed duplicate is read-only. First admission still rechecks identity inside the writer.
    const committed = this.store.read(lookup);
    if (committed) return verify(committed);
    let added = false;
    const receipt = await this.store.transaction(state => {
      const target = state.routes[route.id]!;
      const existing = lookup(state);
      if (existing) return verify(existing);
      let reservedBytes: number | undefined;
      { // Every origin retains a canonical result, so every accepted request reserves it.
        for (const r of Object.values(state.routes)) {
          r.receipts = r.receipts.filter(x => receiptVisible(r, x, now));
          const pinned = new Set(r.outbox.map(job => job.completionId));
          for (const [id, completion] of Object.entries(r.completions)) if (completion.expiresAtMs <= now && !pinned.has(id)) delete r.completions[id];
        }
        const retained = Object.values(state.routes).flatMap(r => r.receipts).filter(r => r.reservedBytes !== undefined);
        // Reserve one worst-case canonical result plus input and receipt metadata.
        reservedBytes = Buffer.byteLength(JSON.stringify(submission.input)) + 6 * 256 * 1024 + 16 * 1024;
        if (retained.length >= (this.settings.maxRequests ?? 1024) || retained.reduce((n, r) => n + r.reservedBytes!, 0) + Object.values(state.routes).reduce((bytes, route) => bytes + Buffer.byteLength(JSON.stringify(route.completions)), 0) + reservedBytes > (this.settings.retainedBytes ?? 8 * 1024 * 1024)) throw new SubmissionFailure("capacity_exceeded");
      }
      if (target.openBatch && (target.openBatch.sourceId !== submission.sourceId || quietMs === 0
        || Math.min(target.openBatch.quietDeadlineMs, target.openBatch.maximumDeadlineMs) <= now)) {
        target.queue.push(target.openBatch); delete target.openBatch;
      }
      const batch = target.openBatch ?? { id: randomUUID(), sourceId: submission.sourceId, openedAtMs: now,
        quietDeadlineMs: now + quietMs, maximumDeadlineMs: now + maximumMs, events: [] };
      if (adapter.outbound && !batch.deliveryReserved) {
        const jobs = Object.values(state.routes).flatMap(r => r.outbox);
        const reservations = Object.values(state.routes).flatMap(r => [...r.queue, ...(r.openBatch ? [r.openBatch] : []), ...(r.active?.batches ?? [])].filter(b => b.deliveryReserved).map(b => r.binding.sources.find(source => source.id === b.sourceId)?.destination?.id));
        const destination = adapter.binding.destination;
        if (!destination) throw new RouterError("state_invalid", "Outbound adapter has no frozen destination.");
        if (jobs.length + reservations.length >= (this.settings.outboxJobs ?? 128)
          || jobs.filter(job => job.destination.id === destination.id).length + reservations.filter(id => id === destination.id).length >= (this.settings.destinationJobs ?? 32)) throw new SubmissionFailure("capacity_exceeded");
        batch.deliveryReserved = true;
      }
      batch.events.push({ messageHandle: submission.externalId, providerTimeMs: submission.providerTimeMs ?? now,
        receiptSequence: target.nextSequence++, text: submission.input.text,
        ...(submission.input.attachment ? { attachment: { state: "pending", ...submission.input.attachment } } : {}) });
      batch.quietDeadlineMs = now + quietMs;
      if (quietMs) target.openBatch = batch; else target.queue.push(batch);
      const receipt: Receipt = { namespace: adapter.binding.namespace, sourceId: submission.sourceId, externalId: submission.externalId, receivedAtMs: now,
        batchId: batch.id, ...(submission.payloadHash ? { payloadHash: submission.payloadHash } : {}), ...(reservedBytes === undefined ? {} : { reservedBytes }) };
      target.receipts.push(receipt); added = true; return receipt;
    });
    if (added) { this.progress.reset(this.requestKey(routeId, submission.sourceId, submission.externalId)); this.readReceipt(adapter); this.typing(route, true); this.wake(route.id); }
    return receipt;
  }

  request(routeId: string, sourceId: string, requestId: string) {
    return this.store.read(state => {
    const route = state.routes[routeId];
    const receipt = route?.receipts.find(r => r.sourceId === sourceId && r.externalId === requestId && receiptVisible(route!, r, this.now()));
    if (!receipt) return undefined;
    const completion = receipt.completionId ? route!.completions[receipt.completionId] : undefined;
    const active = route!.active;
    const worker = this.workers.get(routeId);
    const ours = active?.kind === "codex" && active.batches.some(b => b.id === receipt.batchId);
    const confirmed = ours && receipt.batchId !== active.pendingAdmission?.batchId
      && !active.failedBatchIds?.includes(receipt.batchId!)
      && (receipt.batchId === active.ownerBatchId || active.joinedBatchIds.includes(receipt.batchId!));
    const turnId = completion?.turnId ?? (!completion && confirmed ? active.turnId : undefined);
    return { request_id: requestId, status: completion?.result.status ?? (this.preparing.has(receipt.batchId ?? "") ? "preparing" : ours ? active.pendingAdmission ? "unresolved" : "running" : "queued"),
      ...(completion ? { result: completion.result, expires_at: completion.expiresAtMs } : {}),
      ...(turnId ? { turn_id: turnId } : {}),
      ...(!completion && worker?.error ? { processing: { state: "blocked", code: worker.error instanceof RouterError ? worker.error.code : "gateway_unavailable" } }
        : !completion && worker?.retryAt !== undefined ? { processing: { state: "retrying", code: worker.retryCode } } : {}),
      ...(ours && this.workers.get(routeId)?.session?.capabilities?.commentary ? { commentary: this.workers.get(routeId)!.session!.capabilities!.commentary } : {}) };
    });
  }

  requestKey(routeId: string, sourceId: string, requestId: string): string { return JSON.stringify([routeId, sourceId, requestId]); }

  private notifyWork(route: RuntimeTarget, work?: CodexWork): void {
    const state = this.executionState().routes[route.id]!;
    for (const receipt of state.receipts) {
      if (!work || work.batches.some(b => b.id === receipt.batchId)) this.progress.notify(this.requestKey(route.id, receipt.sourceId, receipt.externalId));
    }
  }

  private readReceipt(adapter: RequestAdapter): void {
    // Presence is best effort: provider failures must never affect the reply.
    void Promise.resolve().then(() => {
      if (!this.abort.signal.aborted) return adapter.readReceipt?.(this.abort.signal);
    }).catch(() => undefined);
  }

  private typing(route: RuntimeTarget, active: boolean): void {
    const worker = this.workers.get(route.id)!;
    if (!active && !worker.typingTimer) return;
    if (worker.typingTimer) { if (active) return; clearTimeout(worker.typingTimer); delete worker.typingTimer; }
    const adapter = active ? this.activeSource(route) : worker.typingSource;
    if (!active) delete worker.typingSource;
    if (!adapter?.typing) return;
    void adapter.typing(active, this.abort.signal).catch(() => undefined);
    if (active) {
      worker.typingSource = adapter;
      worker.typingTimer = setTimeout(() => { delete worker.typingTimer; this.typing(route, true); }, 240000);
      worker.typingTimer.unref();
    }
  }

  wake(routeId: string): void {
    const worker = this.workers.get(routeId)!;
    if (this.abort.signal.aborted || worker.cancelFlight || worker.error || (worker.retryAt !== undefined && Date.now() < worker.retryAt)) return;
    delete worker.retryAt;
    clearTimeout(worker.retryTimer); delete worker.retryTimer;
    worker.again = true;
    if (worker.running) return;
    const route = this.settings.targets.find((route) => route.id === routeId)!;
    worker.running = (async () => {
      while (worker.again && !worker.error && !this.abort.signal.aborted) { worker.again = false; await this.step(route, worker); }
    })().catch((error: unknown) => this.failure(route, worker, error))
      .finally(() => { delete worker.running; if (worker.again && !worker.error) this.wake(route.id); });
  }

  private retry(route: RuntimeTarget, worker: Worker, code: string): void {
    worker.again = false;
    worker.retryCode = code;
    const attempt = worker.retryAttempt ?? 0;
    worker.retryAttempt = attempt + 1;
    const ms = this.lifecycle.retryDelayMs?.(attempt) ?? Math.min(250 * 2 ** Math.min(attempt, 5), 5000);
    worker.retryAt = Date.now() + ms;
    clearTimeout(worker.retryTimer);
    const tick = () => {
      if (this.abort.signal.aborted || worker.retryAt === undefined) return;
      const remaining = worker.retryAt - Date.now();
      if (remaining <= 0) this.wake(route.id);
      else {
        worker.retryTimer = setTimeout(tick, remaining);
        worker.retryTimer.unref();
      }
    };
    worker.retryTimer = setTimeout(tick, ms);
    worker.retryTimer.unref();
    this.typing(route, false);
    this.notifyWork(route);
  }

  private async failure(route: RuntimeTarget, worker: Worker, error: unknown): Promise<void> {
    worker.again = false;
    const session = worker.session;
    const current = this.executionState().routes[route.id]!;
    for (const receipt of current.receipts) if (!receipt.completionId) this.progress.reset(this.requestKey(route.id, receipt.sourceId, receipt.externalId));
    delete worker.session; delete worker.observation; delete worker.outcome; delete worker.observationError;
    await session?.close().catch(() => undefined);
    if (this.abort.signal.aborted) return;
    // These retries only reopen and restore persisted work. No retry path calls
    // admit for an unresolved UUID, even when the original request lost its ACK.
    if (error instanceof RouterError && ["thread_busy", "app_server_connect_failed", "app_server_disconnected", "timeout"].includes(error.code)) {
      this.retry(route, worker, error.code);
    } else {
      worker.error = error;
      this.typing(route, false);
      this.notifyWork(route);
    }
  }

  private async session(route: RuntimeTarget, worker: Worker): Promise<ExecutionSession> {
    if (!worker.session) {
      const active = this.executionState().routes[route.id]!.active;
      const binding = active?.kind === "codex" ? active.binding : undefined;
      const session = await (this.lifecycle.openSession?.(route, this.abort.signal)
        ?? openExecutionSession(route.agent, this.abort.signal, binding));
      worker.session = session;
      if (binding) verifyExecutionBinding(binding, executionBinding(route.agent, session));
      await this.lifecycle.reconcile(route, this.executionState(), session, this.abort.signal);
    }
    return worker.session;
  }

  private observe(route: RuntimeTarget, worker: Worker, turnId: string): void {
    if (worker.observation) return;
    const session = worker.session!;
    const epoch = randomUUID();
    let sequence = 0;
    worker.observation = session.observe(turnId, message => {
      if ((message.type !== "commentary" && message.type !== "reasoning") || worker.session !== session || this.abort.signal.aborted) return;
      const state = this.executionState().routes[route.id]!;
      const work = state.active;
      if (work?.kind !== "codex" || work.turnId !== turnId) return;
      const id = `${turnId}:${message.itemId ?? `${epoch}:${++sequence}`}`;
      for (const receipt of state.receipts) if (work.batches.some(b => b.id === receipt.batchId && !work.failedBatchIds?.includes(b.id))) {
        try { this.progress.publish(this.requestKey(route.id, receipt.sourceId, receipt.externalId), { id, kind: message.type, text: message.text }); } catch { /* Progress never fails execution. */ }
      }
    }).then((outcome) => {
      if (worker.session !== session || this.abort.signal.aborted) return;
      worker.outcome = outcome; this.wake(route.id);
    }, (error: unknown) => {
      if (worker.session !== session || this.abort.signal.aborted) return;
      worker.observationError = error; this.wake(route.id);
    });
  }

  private async step(route: RuntimeTarget, worker: Worker): Promise<void> {
    if (worker.observationError) throw worker.observationError;
    let stored = this.executionState().routes[route.id]!;
    if (worker.timer) { clearTimeout(worker.timer); delete worker.timer; }
    if (stored.openBatch) {
      const remaining = Math.min(stored.openBatch.quietDeadlineMs, stored.openBatch.maximumDeadlineMs) - this.now();
      if (remaining <= 0) {
        await this.store.transaction((state) => {
          const target = state.routes[route.id]!;
          if (target.openBatch && Math.min(target.openBatch.quietDeadlineMs, target.openBatch.maximumDeadlineMs) <= this.now()) {
            target.queue.push(target.openBatch); delete target.openBatch;
          }
        });
        stored = this.executionState().routes[route.id]!;
      } else { worker.timer = setTimeout(() => this.wake(route.id), remaining); worker.timer.unref(); }
    }
    const active = stored.active;
    if (active?.kind === "codex") {
      if (active.admissionFailed && !active.turnId) {
        const session = await this.session(route, worker);
        await this.finish(route, active, { turnId: "", status: "failed", finalText: "", imageGenerations: [] }, session);
        worker.again = true; return;
      }
      const session = await this.session(route, worker);
      if (!worker.observation) {
        const intent = active.pendingAdmission;
        const turnId = await session.restore(active.turnId, intent ? { clientUserMessageId: intent.clientUserMessageId,
          ...(intent.expectedTurnId ? { expectedTurnId: intent.expectedTurnId } : {}) } : undefined, active.artifactBaseline, active.clientUserMessageId);
        await this.store.transaction((state) => {
          const work = state.routes[route.id]!.active as CodexWork;
          work.turnId = turnId;
          if (work.pendingAdmission && work.pendingAdmission.batchId !== work.ownerBatchId) work.joinedBatchIds.push(work.pendingAdmission.batchId);
          delete work.pendingAdmission;
        });
        worker.retryAttempt = 0; delete worker.retryCode;
        this.notifyWork(route);
        this.observe(route, worker, turnId);
        stored = this.executionState().routes[route.id]!;
      }
      const work = stored.active as CodexWork;
      if (worker.outcome && !work.pendingAdmission) {
        await this.finish(route, work, worker.outcome, session); worker.again = true; return;
      }
      if (work.pendingAdmission || !stored.queue.length) return;
      if (session.capabilities?.steer === false) throw new RouterError("thread_unavailable", "This connection cannot steer the active turn.");
    } else if (!stored.queue.length) {
      if (!stored.openBatch) this.typing(route, false);
      return;
    }
    const session = await this.session(route, worker);
    let resumed = session.backend === "desktop" ? undefined : await session.resume();
    const seen = new Set<string>();
    let first: Batch | undefined;
    for (const candidate of stored.queue) {
      if (seen.has(candidate.sourceId)) continue;
      seen.add(candidate.sourceId);
      if (!candidate.events.some(event => event.attachment?.state === "pending") || this.prepared.has(candidate.id)) { first = candidate; break; }
      if (!this.preparing.has(candidate.id) && this.preparing.size < (this.settings.preparationSlots ?? 4)
        && ![...this.preparing.values()].some(p => p.sourceId === candidate.sourceId)) {
        const adapter = this.source(route, candidate.sourceId);
        const promise = adapter.prepare(candidate, session, this.abort.signal).then(async batch => {
          await this.store.transaction(state => {
            const index = state.routes[route.id]!.queue.findIndex(value => value.id === batch.id);
            if (index >= 0) state.routes[route.id]!.queue[index] = batch;
          });
          this.prepared.set(batch.id, batch);
        }).catch(error => { if (!this.abort.signal.aborted) worker.error = error; }).finally(() => {
          this.preparing.delete(candidate.id);
          for (const target of this.settings.targets) this.wake(target.id);
        });
        this.preparing.set(candidate.id, { sourceId: candidate.sourceId, targetId: route.id, promise });
      }
    }
    if (!first) return;
    const adapter = this.source(route, first.sourceId);
    const batch = this.prepared.get(first.id) ?? first;
    this.prepared.delete(first.id);
    if (worker.outcome) { worker.again = true; return; }
    // Desktop preflight can fail without sending input. Complete it before the
    // durable admission intent, after potentially slow attachment preparation.
    resumed ??= await session.resume();
    if (session.capabilities?.steer === false && resumed.activeTurn) throw new RouterError("thread_unavailable", "This connection cannot steer the active turn.");
    const currentWork = stored.active;
    const expectedTurnId = currentWork?.kind === "codex" ? currentWork.turnId : resumed.activeTurn?.id as string | undefined;
    const { publicationId, instructions } = await adapter.instructions(session, this.abort.signal);
    const intent = { batchId: batch.id, clientUserMessageId: randomUUID(), ...(publicationId ? { publicationId } : {}), ...(expectedTurnId ? { expectedTurnId } : {}) };
    if (this.abort.signal.aborted) return;
    await this.store.transaction((state) => {
      const target = state.routes[route.id]!;
      const index = target.queue.findIndex(queued => queued.id === batch.id);
      if (index < 0) throw new RouterError("state_invalid", "The admission queue changed unexpectedly.");
      target.queue.splice(index, 1);
      const firstAdmission = !target.active;
      target.active ??= { kind: "codex", ownerBatchId: batch.id, joinedBatchIds: [], batches: [], publicationIds: [], artifactBaseline: session.artifactBaseline, binding: executionBinding(route.agent, session), clientUserMessageId: intent.clientUserMessageId };
      const work = target.active as CodexWork;
      work.batches.push(batch);
      if (intent.publicationId) work.publicationIds.push(intent.publicationId);
      work.pendingAdmission = intent;
      if (firstAdmission && session.backend !== "desktop" && resumed.activeTurn && Array.isArray(resumed.activeTurn.items)) {
        work.artifactBaseline = resumed.activeTurn.items.flatMap((item: { type?: string; id?: string }) => item.type === "imageGeneration" && item.id ? [item.id] : []);
      }
    });
    try {
      const turnId = await session.admit(batchInput(batch, instructions), intent);
      await this.store.transaction((state) => {
        const work = state.routes[route.id]!.active as CodexWork;
        work.turnId = turnId;
        if (batch.id !== work.ownerBatchId) work.joinedBatchIds.push(batch.id);
        delete work.pendingAdmission;
      });
      worker.retryAttempt = 0; delete worker.retryCode;
      this.notifyWork(route);
        this.observe(route, worker, turnId);
    } catch (error) {
      const busy = error instanceof RouterError && error.code === "thread_busy" && !error.ambiguous;
      if (!busy && !(error instanceof RpcRequestError) && !(error instanceof TurnEndedError)) throw error;
      await this.store.transaction((state) => {
        const target = state.routes[route.id]!; const work = target.active as CodexWork;
        delete work.pendingAdmission;
        if (busy || (expectedTurnId && (staleSteer(error) || error instanceof TurnEndedError))) {
          work.batches = work.batches.filter((value) => value.id !== batch.id);
          if (intent.publicationId) work.publicationIds = work.publicationIds.filter((value) => value !== intent.publicationId);
          target.queue.unshift(batch);
          if (!work.turnId) delete target.active;
        } else {
          work.admissionFailed = true; work.failedBatchIds = [...(work.failedBatchIds ?? []), batch.id];
          if (intent.publicationId) work.publicationIds = work.publicationIds.filter(id => id !== intent.publicationId);
        }
      });
      if (!this.executionState().routes[route.id]!.active) { await session.close(); delete worker.session; }
      if (busy) { this.retry(route, worker, "thread_busy"); return; }
    }
    this.typing(route, true);
    worker.again = true;
  }

  private async finish(route: RuntimeTarget, work: CodexWork, outcome: TurnOutcome, session: ExecutionSession): Promise<void> {
    const failedIds = new Set(work.failedBatchIds ?? (work.admissionFailed ? [work.batches.at(-1)!.id] : []));
    const accepted = work.batches.filter(batch => !failedIds.has(batch.id));
    const staged = accepted.length ? await this.lifecycle.stage(route, { ...work, batches: accepted }, outcome, session, this.abort.signal) : undefined;
    const expiry = this.now() + 30 * 86400000;
    const groups: Array<{batches:Batch[];completion:Completion & StagedCompletion}> = [
      ...(staged ? [{batches:accepted,completion:{id:work.ownerBatchId,...staged,...(outcome.turnId ? {turnId:outcome.turnId}:{}),expiresAtMs:expiry}}] : []),
      ...work.batches.filter(batch=>failedIds.has(batch.id)).map(batch=>({batches:[batch],completion:{id:batch.id,result:{status:"failed" as const,text:"",notices:[ADMISSION_FAILURE]},artifacts:[],expiresAtMs:expiry}})),
    ];
    this.typing(route, false);
    await this.store.transaction(state => {
      const target = state.routes[route.id]!;
      if (target.active?.ownerBatchId !== work.ownerBatchId || target.active.pendingAdmission) throw new RouterError("state_invalid", "Result has no settled execution.");
      for (const {batches,completion} of groups) {
      target.completions[completion.id] = completion;
      for (const sourceId of new Set(batches.map(batch => batch.sourceId))) {
        const adapter = this.source(route, sourceId);
        for (const receipt of target.receipts) if (receipt.sourceId === sourceId && batches.some(batch => batch.id === receipt.batchId)) {
          receipt.completionId = completion.id;
          receipt.reservedBytes = Buffer.byteLength(JSON.stringify(receipt)) + 64;
        }
        if (adapter.outbound) {
          const destination = adapter.binding.destination;
          if (!destination) throw new RouterError("state_invalid", "Outbound source has no destination.");
          target.outbox.push({ kind: "delivery", id: randomUUID(), sourceId, destination: structuredClone(destination),
            completionId: completion.id, sequence: state.nextDeliverySequence++, prepared: false,
            reservedBytes: OUTBOX_METADATA_BYTES, batchIds: batches.filter(batch => batch.sourceId === sourceId).map(batch => batch.id), parts: [] });
        }
      }
      }
      delete target.active;
    });
    this.wakeOutbox();
    for (const { batches, completion } of groups) for (const batch of batches) for (const event of batch.events) {
      try { this.progress.publish(this.requestKey(route.id, batch.sourceId, event.messageHandle), { id: event.messageHandle, kind: "terminal", text: completion.result.text, metadata: { status: completion.result.status, notices: completion.result.notices } }); } catch { /* Durable result remains retrievable. */ }
    }
    this.release(route, work, session);
    const worker = this.workers.get(route.id)!;
    delete worker.session; delete worker.observation; delete worker.outcome;
    const preparations = [...this.preparing.values()].filter(value => value.targetId === route.id).map(value => value.promise);
    if (preparations.length) {
      const closing = Promise.all(preparations).then(() => session.close()).catch(() => undefined).finally(() => this.cleanups.delete(closing));
      this.cleanups.add(closing);
    } else await session.close().catch(() => undefined);
    this.notifyWork(route);
  }

  private release(route: RuntimeTarget, active: CodexWork | readonly StagedArtifact[], session?: ExecutionSession): void {
    const operation = this.lifecycle.release?.(route, active, session);
    if (!operation) return;
    const cleanup = operation.catch(() => undefined).finally(() => { this.cleanups.delete(cleanup); });
    this.cleanups.add(cleanup);
  }

  private outbound(route: RuntimeTarget, job: Delivery): NonNullable<RequestAdapter["outbound"]> {
    const outbound = this.lifecycle.outbound?.(job.destination) ?? this.source(route, job.sourceId).outbound;
    if (!outbound) throw new RouterError("state_invalid", "Delivery transport is unavailable.");
    return outbound;
  }

  private currentPart(partId: string): { route: RuntimeTarget; delivery: Delivery; part: DeliveryPart } | undefined {
    const state = this.executionState();
    for (const route of this.settings.targets) {
      for (const delivery of state.routes[route.id]?.outbox ?? []) {
        const part = delivery.parts.find((part) => part.id === partId);
        if (part) return { route, delivery, part };
      }
    }
    return undefined;
  }

  callbackState(account: string, partId: string, token: string): "stale" | "unauthorized" | "current" {
    const current = this.currentPart(partId);
    if (!current || this.outbound(current.route, current.delivery).callbackNamespace !== account || current.part.status !== "sending") return "stale";
    return secretEqual(current.part.callbackToken!, token) ? "current" : "unauthorized";
  }

  async callback(account: string, partId: string, token: string, callback: DeliveryCallback): Promise<boolean> {
    const current = this.currentPart(partId);
    if (!current || this.outbound(current.route, current.delivery).callbackNamespace !== account || current.part.status !== "sending") return true;
    if (!secretEqual(current.part.callbackToken!, token)) return false;
    const live = this.live.get(partId);
    if (callback.status === "accepted" && callback.providerHandle) {
      await this.settle(partId, { status: "accepted", providerHandle: callback.providerHandle });
    } else if (callback.status === "failed" && live?.running && live.attemptsStarted === 1) {
      await this.settle(partId, { status: "failed" });
    }
    this.outboxErrors.delete(current.delivery.destination.id);
    this.wakeOutbox();
    return true;
  }

  private settle(partId: string, outcome: NonNullable<LiveSend["settlement"]>): Promise<void> {
    let live = this.live.get(partId);
    if (!live) { live = { attemptsStarted: 0, abort: new AbortController(), durable: false, running: false }; this.live.set(partId, live); }
    live.settlement ??= outcome;
    live.abort.abort();
    if (live.persistence) return live.persistence;
    const selected = live.settlement;
    const entry = live;
    entry.persistence = this.store.transaction((state) => {
      for (const route of Object.values(state.routes)) for (const delivery of route.outbox) {
        const part = delivery.parts.find((part) => part.id === partId && part.status === "sending");
        if (part) settlePart(part, delivery, selected);
      }
    }).then(() => { entry.durable = true; }).catch((error) => { delete entry.persistence; throw error; });
    return entry.persistence;
  }

  private async lineSlot(number: string, limit: number, signal: AbortSignal): Promise<void> {
    while (true) {
      if (signal.aborted) throw new RouterError("interrupted", "The send operation stopped.");
      const starts = (this.lineStarts.get(number) ?? []).filter((time) => time > this.now() - 1000);
      this.lineStarts.set(number, starts);
      if (starts.length < limit) return;
      await delay(starts[0]! + 1000 - this.now(), signal);
    }
  }

  private async sendPart(route: RuntimeTarget, partId: string): Promise<void> {
    const delivery = this.currentPart(partId)!.delivery;
    const outbound = this.outbound(route, delivery);
    if (!outbound) throw new RouterError("state_invalid", "Delivery source has no outbound transport.");
    const live: LiveSend = { attemptsStarted: 0, abort: new AbortController(), durable: false, running: true };
    this.live.set(partId, live);
    const onAbort = () => live.abort.abort();
    if (this.abort.signal.aborted) onAbort(); else this.abort.signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.lineSlot(outbound.line, outbound.maxPerSecond, live.abort.signal);
        const current = this.currentPart(partId);
        if (!current || current.part.status !== "sending" || live.abort.signal.aborted || live.settlement) break;
        // No await separates limiter reservation, eligibility, and the physical request.
        const starts = this.lineStarts.get(outbound.line)!;
        if (starts.length >= outbound.maxPerSecond) { attempt--; continue; }
        starts.push(this.now()); live.attemptsStarted++;
        const callbackUrl = outbound.callbackUrl(partId, current.part.callbackToken!);
        const request = outbound.send(current.part, callbackUrl, live.abort.signal, current.delivery.destination);
        const result = await request.catch((): SendOutcome => ({ status: "uncertain", retryable: true }));
        if (live.settlement) break;
        if (result.status === "accepted") { await this.settle(partId, result); break; }
        if (result.status === "rejected" && !result.retryable) { await this.settle(partId, { status: "failed" }); break; }
        // A lost response may hide a successful send. Without provider idempotency,
        // another physical attempt could deliver the same reply twice.
        if (result.status === "uncertain") break;
        if (!result.retryable || attempt === 2) { await this.settle(partId, { status: "failed" }); break; }
        await delay(result.retryAfterMs ?? 500 * 2 ** attempt, live.abort.signal);
      }
    } catch (error) { if (!live.abort.signal.aborted) throw error; }
    finally {
      live.running = false;
      this.abort.signal.removeEventListener("abort", onAbort);
      if (live.persistence) await live.persistence;
    }
  }

  private wakeOutbox(): void {
    if (this.abort.signal.aborted) return;
    const jobs = this.store.read(state => Object.entries(state.routes).flatMap(([targetId, target]) => target.outbox.map(job => ({ targetId, job })))).sort((a, b) => a.job.sequence - b.job.sequence);
    const seen = new Set<string>();
    for (const { targetId, job } of jobs) {
      const destination = job.destination.id;
      if (seen.has(destination)) continue;
      seen.add(destination);
      if (this.outboxWorkers.has(destination) || this.outboxErrors.has(destination) || job.parts.some(part => part.status === "sending")) continue;
      const route = this.settings.targets.find(target => target.id === targetId);
      if (!route) continue;
      const promise = this.deliver(route, job.id).catch(error => { this.outboxErrors.set(destination, error); }).finally(() => {
        this.outboxWorkers.delete(destination);
        this.wakeOutbox();
      });
      this.outboxWorkers.set(destination, promise);
    }
  }

  private async deliver(route: RuntimeTarget, id: string): Promise<void> {
    let job = this.store.read(state => state.routes[route.id]!.outbox.find(job => job.id === id))!;
    const outbound = this.outbound(route, job);
    if (!outbound) throw new RouterError("state_invalid", "Delivery adapter is unavailable.");
    if (!job.prepared) {
      const completion = this.store.read(state => state.routes[route.id]!.completions[job.completionId])!;
      const parts = await outbound.prepare(completion, job.destination, this.abort.signal);
      if (Buffer.byteLength(JSON.stringify({ ...job, parts })) > job.reservedBytes) throw new RouterError("state_invalid", "Delivery exceeds its reserved metadata capacity.");
      await this.store.transaction(state => {
        const stored = state.routes[route.id]!.outbox.find(job => job.id === id)!;
        stored.parts = parts; stored.prepared = true;
      });
    }
    while (!this.abort.signal.aborted) {
      job = this.store.read(state => state.routes[route.id]!.outbox.find(job => job.id === id))!;
      if (job.parts.some(part => part.status === "sending")) return;
      const next = job.parts.find(part => part.status === "ready");
      if (!next) {
        const artifacts = await this.store.transaction(state => {
          const target = state.routes[route.id]!; target.outbox = target.outbox.filter(job => job.id !== id);
          if (target.outbox.some(other => other.completionId === job.completionId)) return [];
          const completion = target.completions[job.completionId]!;
          const artifacts = completion.artifacts; completion.artifacts = []; return artifacts;
        });
        for (const part of job.parts) this.live.delete(part.id);
        this.release(route, artifacts);
        return;
      }
      await this.store.transaction(state => {
        const part = state.routes[route.id]!.outbox.find(job => job.id === id)!.parts.find(part => part.id === next.id)!;
        part.status = "sending"; part.callbackToken = randomUUID();
      });
      await this.sendPart(route, next.id);
    }
  }

  deliveryStatus(): Array<{ agentId: string; destinationId: string; state: "pending" | "running" | "blocked" | "unresolved"; pendingJobs: number; code?: string }> {
    return this.store.read(state => Object.entries(state.routes).flatMap(([agentId, target]) => {
      const destinations = [...new Set(target.outbox.map(job => job.destination.id))];
      return destinations.map(destinationId => {
        const jobs = target.outbox.filter(job => job.destination.id === destinationId);
        const error = this.outboxErrors.get(destinationId);
        return { agentId, destinationId, pendingJobs: jobs.length,
          state: error ? "blocked" as const : jobs.some(job => job.parts.some(part => part.status === "sending" && !this.live.get(part.id)?.running)) ? "unresolved" as const : this.outboxWorkers.has(destinationId) ? "running" as const : "pending" as const,
          ...(error ? { code: error instanceof RouterError ? error.code : "delivery_unavailable" } : {}) };
      });
    }));
  }

  async cancel(agentId: string, expectedTurnId: string): Promise<{ type: "interrupt_requested" | "already_finished" }> {
    const route = this.settings.targets.find(target => target.id === agentId);
    if (!route) throw new CancellationFailure("unknown_agent");
    const worker = this.workers.get(agentId)!;
    if (worker.cancelFlight) throw new CancellationFailure("interrupt_conflict");
    const operation = (async () => {
      await worker.running;
      const active = this.store.read(state => state.routes[agentId]?.active);
      if (active?.pendingAdmission) throw new CancellationFailure("interrupt_conflict");
      const borrowed = !worker.session;
      const session = await this.session(route, worker);
      try {
      const resumed = await session.resume();
      const current = active?.turnId ?? resumed.activeTurn?.id;
      if (worker.outcome || !resumed.activeTurn && !active) {
        const known = worker.outcome?.turnId === expectedTurnId || this.store.read(state => Object.values(state.routes[agentId]!.completions).some(completion => completion.turnId === expectedTurnId));
        if (!known || resumed.activeTurn && resumed.activeTurn.id !== expectedTurnId) throw new CancellationFailure("interrupt_conflict");
        return { type: "already_finished" as const };
      }
      if (current !== expectedTurnId) throw new CancellationFailure("interrupt_conflict");
      if (!session.interrupt) throw new CancellationFailure("interrupt_unsupported");
      try { await session.interrupt(expectedTurnId); }
      catch { throw new CancellationFailure("interrupt_uncertain"); }
      return { type: "interrupt_requested" as const };
      } finally {
        if (borrowed && worker.session === session && !this.store.read(state => state.routes[agentId]?.active) && ![...this.preparing.values()].some(value => value.targetId === agentId)) {
          delete worker.session; await session.close().catch(() => undefined);
        }
      }
    })();
    worker.cancelFlight = operation;
    try { return await operation; }
    finally { delete worker.cancelFlight; this.wake(agentId); }
  }

  async idle(): Promise<void> {
    while ([...this.workers.values()].some((worker) => worker.running)) {
      await Promise.all([...this.workers.values()].map((worker) => worker.running));
    }
  }
  processingStatus(): ProcessingStatus[] {
    const state = this.executionState();
    return [...this.workers].map(([routeId, worker]) => {
      const active = state.routes[routeId]?.active;
      const pending = active?.kind === "codex" && !!active.pendingAdmission;
      const errorCode = worker.error instanceof RouterError ? worker.error.code : worker.error ? "unknown" : undefined;
      return { routeId, state: worker.error ? (pending ? "unresolved" : "blocked") : worker.retryAt !== undefined ? "retrying"
        : active || state.routes[routeId]?.queue.length ? "running" : "idle",
        ...(errorCode || worker.retryCode ? { code: errorCode ?? worker.retryCode! } : {}) };
    });
  }
  errors(): string[] { return [...this.workers].filter(([, worker]) => worker.error).map(([id]) => id); }
  async close(): Promise<void> {
    this.ready = false;
    this.progress.close();
    for (const route of this.settings.targets) this.typing(route, false);
    this.abort.abort();
    for (const worker of this.workers.values()) { clearTimeout(worker.timer); clearTimeout(worker.retryTimer); clearTimeout(worker.typingTimer); }
    await Promise.all([...this.workers.values()].map((worker) => worker.session?.close()));
    await this.idle();
    await Promise.all([...this.preparing.values()].map(p => p.promise));
    await Promise.all(this.outboxWorkers.values());
    await Promise.all(this.cleanups);
  }
}

export function secretEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export class SubmissionFailure extends Error { constructor(readonly code: "request_conflict" | "capacity_exceeded") { super(code); } }

export class CancellationFailure extends Error { constructor(readonly code: "unknown_agent" | "interrupt_conflict" | "interrupt_unsupported" | "interrupt_uncertain") { super(code); } }
