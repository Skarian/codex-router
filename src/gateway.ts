import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { GatewayConfig, GatewayRoute } from "./config.js";
import { RouterError } from "./errors.js";
import { RpcRequestError } from "./json-rpc.js";
import { TurnEndedError, type TurnInput } from "./turn-session.js";
import { executionBinding, openExecutionSession, verifyExecutionBinding, type ExecutionSession } from "./execution-session.js";
import { matchIncoming, sourceAdapters, type SourceAdapter } from "./gateway-adapters.js";
import type { Submission } from "./gateway-connector.js";
import { ProgressHub } from "./gateway-progress.js";
import type { Receipt } from "./gateway-state.js";
import type { TurnOutcome } from "./turn-state.js";
import { bindRoutes, GatewayStore, settlePart, type Batch, type CodexWork, type Delivery, type DeliveryPart, type GatewayState, type InboundEvent } from "./gateway-state.js";

export type SendOutcome =
  | { status: "accepted"; providerHandle: string }
  | { status: "rejected" | "uncertain"; retryable: boolean; retryAfterMs?: number };
export interface IncomingMessage {
  messageHandle: string;
  sender: string;
  sendblueNumber: string;
  providerTimeMs: number;
  text: string;
  attachment?: { sourceUrl: string; name: string };
}
export interface StatusCallback { status: string; providerHandle?: string }
export interface SendblueProvider {
  readonly signingSecret: string;
  agentInstructions?(outputDirectory: string): string;
  readReceipt?(route: GatewayRoute, signal: AbortSignal): Promise<void>;
  inbound(value: unknown): IncomingMessage | undefined;
  callback(value: unknown): StatusCallback;
  send(route: GatewayRoute, part: DeliveryPart, callbackUrl: string | undefined, signal: AbortSignal): Promise<SendOutcome>;
  upload(path: string, name: string, mediaType: string, signal: AbortSignal): Promise<string>;
  typing(route: GatewayRoute, state: "start" | "stop", signal: AbortSignal): Promise<void>;
}
export type GatewaySession = ExecutionSession;
export interface ProcessingStatus { routeId: string; state: "idle" | "running" | "retrying" | "blocked" | "unresolved"; code?: string }
export interface GatewayFiles {
  cleanup(state: GatewayState): Promise<void>;
  release?(route: GatewayRoute, active: CodexWork | Delivery, session?: GatewaySession): Promise<void>;
  reconcile(route: GatewayRoute, state: GatewayState, session: GatewaySession, signal: AbortSignal): Promise<void>;
  prepareBatch(route: GatewayRoute, batch: Batch, session: GatewaySession, signal: AbortSignal): Promise<Batch>;
  publication(route: GatewayRoute, publicationId: string, session: GatewaySession, signal: AbortSignal): Promise<string>;
  delivery(route: GatewayRoute, work: CodexWork, outcome: TurnOutcome, session: GatewaySession, connector: SendblueProvider, signal: AbortSignal): Promise<DeliveryPart[]>;
}
export interface GatewayOperations {
  connector(id: string): SendblueProvider;
  files: GatewayFiles;
  openSession?(route: GatewayRoute, signal: AbortSignal): Promise<GatewaySession>;
  now?(): number;
  retryDelayMs?(attempt: number): number;
}
interface Worker {
  running?: Promise<void>;
  again: boolean;
  session?: GatewaySession;
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
  typingSource?: SourceAdapter;
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

export class Gateway {
  ready = false;
  readonly progress = new ProgressHub();
  private readonly adapters = new Map<string, SourceAdapter[]>();
  private readonly abort = new AbortController();
  private readonly workers = new Map<string, Worker>();
  private readonly live = new Map<string, LiveSend>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly lineStarts = new Map<string, number[]>();
  private readonly now: () => number;
  constructor(readonly config: GatewayConfig, readonly store: GatewayStore, readonly operations: GatewayOperations) {
    this.now = operations.now ?? Date.now;
    for (const route of config.routes) {
      this.workers.set(route.id, { again: false });
      this.adapters.set(route.id, sourceAdapters(config, route, operations.files, operations.connector));
    }
  }

  /** Scheduling and file cleanup need identities and work, never retained response text. */
  private executionState(): GatewayState {
    return this.store.read(state => ({ ...state, routes: Object.fromEntries(Object.entries(state.routes).map(([id, route]) => [id, {
      ...route, receipts: route.receipts.map(r => ({ ...r, ...(r.result ? { result: { ...r.result, text: "" } } : {}) })),
    }])) }));
  }

  async start(): Promise<void> {
    await this.store.transaction((state) => bindRoutes(state, this.config));
    await this.operations.files.cleanup(this.executionState());
    this.ready = true;
    for (const route of this.config.routes) this.wake(route.id);
  }

  private source(route: GatewayRoute, sourceId: string): SourceAdapter {
    const adapters = this.adapters.get(route.id)!;
    const adapter = adapters.find(a => a.binding.id === sourceId);
    if (!adapter) throw new RouterError("state_invalid", "The work source is unavailable.");
    return adapter;
  }

  private activeSource(route: GatewayRoute): SourceAdapter | undefined {
    const state = this.executionState().routes[route.id];
    const active = state?.active;
    const sourceId = active?.kind === "codex" ? (active.batches.find(batch => this.source(route, batch.sourceId).typing)?.sourceId ?? active.batches[0]?.sourceId) : active?.sourceId;
    if (sourceId) return this.source(route, sourceId);
    const batch = state?.queue[0] ?? state?.openBatch;
    return batch ? this.source(route, batch.sourceId) : this.adapters.get(route.id)?.[0];
  }

  async receive(accountId: string, message: IncomingMessage): Promise<void> {
    const match = matchIncoming(this.config, accountId, message);
    if (!match) return;
    await this.submit(match.route.id, { sourceId: match.sourceId, externalId: message.messageHandle,
      input: { text: message.text, ...(message.attachment ? { attachment: message.attachment } : {}) }, providerTimeMs: message.providerTimeMs });
  }

  async submit(routeId: string, submission: Submission): Promise<Receipt> {
    if (!this.ready) throw new RouterError("storage_failed", "Gateway intake is not ready.");
    const route = this.config.routes.find(r => r.id === routeId);
    if (!route) throw new RouterError("input_invalid", "Unknown route.");
    const adapter = this.source(route, submission.sourceId);
    const now = this.now();
    const activeTurn = this.store.read(state => state.routes[routeId]?.active?.kind === "codex");
    const { quietMs, maximumMs } = activeTurn || adapter.policy.batching === "immediate" ? { quietMs: 0, maximumMs: 0 } : adapter.policy.batching;
    const lookup = (state: GatewayState) => adapter.policy.duplicateBehavior === "exact"
      ? state.routes[route.id]!.receipts.find(r => r.sourceId === submission.sourceId && r.externalId === submission.externalId && (!r.expiresAtMs || r.expiresAtMs > now))
      : Object.values(state.routes).flatMap(r => r.receipts).find(r => r.sourceId === submission.sourceId && r.externalId === submission.externalId && r.receivedAtMs > now - 30 * 24 * 60 * 60 * 1000);
    const verify = (receipt: Receipt) => {
      if (adapter.policy.duplicateBehavior === "exact" && receipt.payloadHash !== submission.payloadHash) throw new SubmissionFailure(409, "request_conflict");
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
      if (adapter.policy.retainTerminalResult) {
        for (const r of Object.values(state.routes)) r.receipts = r.receipts.filter(x => !x.expiresAtMs || x.expiresAtMs > now);
        const retained = Object.values(state.routes).flatMap(r => r.receipts).filter(r => r.reservedBytes !== undefined);
        reservedBytes = Buffer.byteLength(JSON.stringify(submission.input)) + 6 * 256 * 1024 + 16 * 1024;
        if (retained.length >= (this.config.maxRequests ?? 1024) || retained.reduce((n, r) => n + r.reservedBytes!, 0) + reservedBytes > (this.config.retainedBytes ?? 8 * 1024 * 1024)) throw new SubmissionFailure(429, "capacity_exceeded");
      }
      if (target.openBatch && (target.openBatch.sourceId !== submission.sourceId || quietMs === 0
        || Math.min(target.openBatch.quietDeadlineMs, target.openBatch.maximumDeadlineMs) <= now)) {
        target.queue.push(target.openBatch); delete target.openBatch;
      }
      const batch = target.openBatch ?? { id: randomUUID(), sourceId: submission.sourceId, openedAtMs: now,
        quietDeadlineMs: now + quietMs, maximumDeadlineMs: now + maximumMs, events: [] };
      batch.events.push({ messageHandle: submission.externalId, providerTimeMs: submission.providerTimeMs ?? now,
        receiptSequence: target.nextSequence++, text: submission.input.text,
        ...(submission.input.attachment ? { attachment: { state: "pending", ...submission.input.attachment } } : {}) });
      batch.quietDeadlineMs = now + quietMs;
      if (quietMs) target.openBatch = batch; else target.queue.push(batch);
      const receipt: Receipt = { sourceId: submission.sourceId, externalId: submission.externalId, receivedAtMs: now,
        batchId: batch.id, ...(submission.payloadHash ? { payloadHash: submission.payloadHash } : {}), ...(reservedBytes === undefined ? {} : { reservedBytes }) };
      target.receipts.push(receipt); added = true; return receipt;
    });
    if (added) { this.readReceipt(adapter); this.typing(route, true); this.wake(route.id); }
    return receipt;
  }

  request(routeId: string, sourceId: string, requestId: string) {
    return this.store.read(state => {
    const route = state.routes[routeId];
    const receipt = route?.receipts.find(r => r.sourceId === sourceId && r.externalId === requestId && (!r.expiresAtMs || r.expiresAtMs > this.now()));
    if (!receipt) return undefined;
    const active = route!.active;
    const worker = this.workers.get(routeId);
    const ours = active?.kind === "codex" && active.batches.some(b => b.id === receipt.batchId);
    return { request_id: requestId, status: receipt.result?.status ?? (ours ? active.pendingAdmission ? "unresolved" : "running" : "queued"),
      ...(receipt.result ? { result: receipt.result, expires_at: receipt.expiresAtMs } : {}),
      ...(receipt.turnId ? { turn_id: receipt.turnId } : {}),
      ...(!receipt.result && worker?.error ? { processing: { state: "blocked", code: worker.error instanceof RouterError ? worker.error.code : "gateway_unavailable" } }
        : !receipt.result && worker?.retryAt !== undefined ? { processing: { state: "retrying", code: worker.retryCode } } : {}),
      ...(ours && this.workers.get(routeId)?.session?.capabilities?.commentary ? { commentary: this.workers.get(routeId)!.session!.capabilities!.commentary } : {}),
      ...(!receipt.result && !ours && active?.kind === "delivery" ? { blocked_by: "delivery" } : {}) };
    });
  }

  requestKey(routeId: string, sourceId: string, requestId: string): string { return JSON.stringify([routeId, sourceId, requestId]); }

  private notifyWork(route: GatewayRoute, work?: CodexWork): void {
    const state = this.executionState().routes[route.id]!;
    for (const receipt of state.receipts) {
      if (!work || work.batches.some(b => b.id === receipt.batchId)) this.progress.notify(this.requestKey(route.id, receipt.sourceId, receipt.externalId));
    }
  }

  private readReceipt(adapter: SourceAdapter): void {
    // Presence is best effort: provider failures must never affect the reply.
    void Promise.resolve().then(() => {
      if (!this.abort.signal.aborted) return adapter.readReceipt?.(this.abort.signal);
    }).catch(() => undefined);
  }

  private typing(route: GatewayRoute, active: boolean): void {
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
    if (this.abort.signal.aborted || worker.error || (worker.retryAt !== undefined && Date.now() < worker.retryAt)) return;
    delete worker.retryAt;
    clearTimeout(worker.retryTimer); delete worker.retryTimer;
    worker.again = true;
    if (worker.running) return;
    const route = this.config.routes.find((route) => route.id === routeId)!;
    worker.running = (async () => {
      while (worker.again && !worker.error && !this.abort.signal.aborted) { worker.again = false; await this.step(route, worker); }
    })().catch((error: unknown) => this.failure(route, worker, error))
      .finally(() => { delete worker.running; if (worker.again && !worker.error) this.wake(route.id); });
  }

  private retry(route: GatewayRoute, worker: Worker, code: string): void {
    worker.again = false;
    worker.retryCode = code;
    const attempt = worker.retryAttempt ?? 0;
    worker.retryAttempt = attempt + 1;
    const ms = this.operations.retryDelayMs?.(attempt) ?? Math.min(250 * 2 ** Math.min(attempt, 5), 5000);
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

  private async failure(route: GatewayRoute, worker: Worker, error: unknown): Promise<void> {
    worker.again = false;
    const session = worker.session;
    const current = this.executionState().routes[route.id]!;
    for (const receipt of current.receipts) if (!receipt.result && receipt.reservedBytes !== undefined) this.progress.reset(this.requestKey(route.id, receipt.sourceId, receipt.externalId));
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

  private async session(route: GatewayRoute, worker: Worker): Promise<GatewaySession> {
    if (!worker.session) {
      const active = this.executionState().routes[route.id]!.active;
      const binding = active?.kind === "codex" ? active.binding : undefined;
      const session = await (this.operations.openSession?.(route, this.abort.signal)
        ?? openExecutionSession(route.agent, this.abort.signal, binding));
      worker.session = session;
      if (binding) verifyExecutionBinding(binding, executionBinding(route.agent, session));
      await this.operations.files.reconcile(route, this.executionState(), session, this.abort.signal);
    }
    return worker.session;
  }

  private observe(route: GatewayRoute, worker: Worker, turnId: string): void {
    if (worker.observation) return;
    const session = worker.session!;
    worker.observation = session.observe(turnId, message => {
      if (message.type !== "commentary" || !message.itemId || worker.session !== session || this.abort.signal.aborted) return;
      const state = this.executionState().routes[route.id]!;
      const work = state.active;
      if (work?.kind !== "codex" || work.turnId !== turnId) return;
      for (const receipt of state.receipts) if (receipt.reservedBytes !== undefined && work.batches.some(b => b.id === receipt.batchId)) {
        try { this.progress.publish(this.requestKey(route.id, receipt.sourceId, receipt.externalId), { id: `${turnId}:${message.itemId}`, kind: "commentary", text: message.text }); } catch { /* Progress never fails execution. */ }
      }
    }).then((outcome) => {
      if (worker.session !== session || this.abort.signal.aborted) return;
      worker.outcome = outcome; this.wake(route.id);
    }, (error: unknown) => {
      if (worker.session !== session || this.abort.signal.aborted) return;
      worker.observationError = error; this.wake(route.id);
    });
  }

  private async step(route: GatewayRoute, worker: Worker): Promise<void> {
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
    if (active?.kind === "delivery") {
      const sending = active.parts.find((part) => part.status === "sending");
      if (sending) { this.typing(route, false); return; }
      const next = active.parts.find((part) => part.status === "ready");
      if (next) {
        await this.store.transaction((state) => {
          const delivery = state.routes[route.id]!.active as Delivery;
          const part = delivery.parts.find((part) => part.id === next.id)!;
          part.status = "sending"; part.callbackToken = randomUUID();
        });
        await this.sendPart(route, next.id);
        worker.again = true;
      } else {
        await this.store.transaction((state) => { delete state.routes[route.id]!.active; });
        this.release(route, active, worker.session);
        await worker.session?.close().catch(() => undefined); delete worker.session; delete worker.observation; delete worker.outcome;
        for (const part of active.parts) this.live.delete(part.id);
        this.typing(route, false);
        worker.again = true;
      }
      return;
    }
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
      if (work.admissionFailed || work.pendingAdmission || !stored.queue.length) return;
      if (session.capabilities?.steer === false) throw new RouterError("thread_unavailable", "This connection cannot steer the active turn.");
    } else if (!stored.queue.length) {
      if (!stored.openBatch) this.typing(route, false);
      return;
    }
    const session = await this.session(route, worker);
    let resumed = session.backend === "desktop" ? undefined : await session.resume();
    const first = stored.queue[0]!;
    const adapter = this.source(route, first.sourceId);
    const batch = await adapter.prepare(first, session, this.abort.signal);
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
      if (target.queue[0]?.id !== batch.id) throw new RouterError("state_invalid", "The admission queue changed unexpectedly.");
      target.queue.shift();
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
        } else work.admissionFailed = true;
      });
      if (!this.executionState().routes[route.id]!.active) { await session.close(); delete worker.session; }
      if (busy) { this.retry(route, worker, "thread_busy"); return; }
    }
    this.typing(route, true);
    worker.again = true;
  }

  private async finish(route: GatewayRoute, work: CodexWork, outcome: TurnOutcome, session: GatewaySession): Promise<void> {
    const completions: Array<{ sourceId: string; plan: import("./gateway-connector.js").CompletionPlan }> = [];
    for (const sourceId of new Set(work.batches.map(batch => batch.sourceId))) {
      const adapter = this.source(route, sourceId);
      completions.push({ sourceId, plan: await adapter.complete(work, outcome, session, this.abort.signal) });
    }
    // A route currently has at most one outbound-delivery connector (Sendblue).
    const deliveries = completions.filter(completion => completion.plan.kind === "deliver");
    if (deliveries.length > 1) throw new RouterError("state_invalid", "Multiple outbound delivery sources are unsupported.");
    this.typing(route, false);
    await this.store.transaction(state => {
      const target = state.routes[route.id]!;
      if (target.active?.kind !== "codex" || target.active.ownerBatchId !== work.ownerBatchId || target.active.pendingAdmission) throw new RouterError("state_invalid", "Result has no settled execution.");
      for (const completion of completions) {
        if (completion.plan.kind !== "retain") continue;
        for (const receipt of target.receipts) if (receipt.sourceId === completion.sourceId && work.batches.some(batch => batch.id === receipt.batchId)) {
          receipt.result = completion.plan.result;
          if (outcome.turnId) receipt.turnId = outcome.turnId;
          receipt.expiresAtMs = this.now() + 30 * 24 * 60 * 60 * 1000;
          receipt.reservedBytes = Buffer.byteLength(JSON.stringify(receipt));
        }
      }
      const delivery = deliveries[0];
      if (delivery?.plan.kind === "deliver") target.active = { kind: "delivery", id: randomUUID(), sourceId: delivery.sourceId,
        batchIds: work.batches.map(batch => batch.id), parts: delivery.plan.parts };
      else delete target.active;
    });
    for (const receipt of this.store.read(state => state.routes[route.id]!.receipts.filter(receipt => receipt.result && work.batches.some(batch => batch.id === receipt.batchId)))) if (receipt.result) {
      try { this.progress.publish(this.requestKey(route.id, receipt.sourceId, receipt.externalId), { id: receipt.externalId, kind: "terminal", text: receipt.result.text, metadata: { status: receipt.result.status, notices: receipt.result.notices } }); } catch { /* Durable result remains retrievable. */ }
    }
    this.release(route, work, session);
    const worker = this.workers.get(route.id)!;
    delete worker.session; delete worker.observation; delete worker.outcome;
    await session.close().catch(() => undefined);
    this.notifyWork(route);
  }

  private release(route: GatewayRoute, active: CodexWork | Delivery, session?: GatewaySession): void {
    const operation = this.operations.files.release?.(route, active, session);
    if (!operation) return;
    const cleanup = operation.catch(() => undefined).finally(() => { this.cleanups.delete(cleanup); });
    this.cleanups.add(cleanup);
  }

  private currentPart(partId: string): { route: GatewayRoute; delivery: Delivery; part: DeliveryPart } | undefined {
    const state = this.executionState();
    for (const route of this.config.routes) {
      const delivery = state.routes[route.id]?.active;
      if (delivery?.kind !== "delivery") continue;
      const part = delivery.parts.find((part) => part.id === partId);
      if (part) return { route, delivery, part };
    }
    return undefined;
  }

  callbackState(account: string, partId: string, token: string): "stale" | "unauthorized" | "current" {
    const current = this.currentPart(partId);
    if (!current || this.source(current.route, current.delivery.sourceId).binding.accountId !== account || current.part.status !== "sending") return "stale";
    return secretEqual(current.part.callbackToken!, token) ? "current" : "unauthorized";
  }

  async callback(account: string, partId: string, token: string, callback: StatusCallback): Promise<boolean> {
    const current = this.currentPart(partId);
    if (!current || this.source(current.route, current.delivery.sourceId).binding.accountId !== account || current.part.status !== "sending") return true;
    if (!secretEqual(current.part.callbackToken!, token)) return false;
    const live = this.live.get(partId);
    if (["REGISTERED", "PENDING", "QUEUED", "ACCEPTED", "SENT", "DELIVERED"].includes(callback.status) && callback.providerHandle) {
      await this.settle(partId, { status: "accepted", providerHandle: callback.providerHandle });
    } else if (["DECLINED", "ERROR"].includes(callback.status) && live?.running && live.attemptsStarted === 1) {
      await this.settle(partId, { status: "failed" });
    }
    if (this.live.get(partId)?.durable) delete this.workers.get(current.route.id)!.error;
    this.wake(current.route.id);
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
      for (const route of Object.values(state.routes)) {
        const delivery = route.active;
        if (delivery?.kind !== "delivery") continue;
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

  private async sendPart(route: GatewayRoute, partId: string): Promise<void> {
    const delivery = this.executionState().routes[route.id]!.active as Delivery;
    const outbound = this.source(route, delivery.sourceId).outbound;
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
        const request = outbound.send(current.part, callbackUrl, live.abort.signal);
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
      const unresolvedSend = active?.kind === "delivery" && active.parts.some(part => part.status === "sending" && !this.live.get(part.id)?.running);
      const errorCode = worker.error instanceof RouterError ? worker.error.code : worker.error ? "unknown" : undefined;
      return { routeId, state: worker.error ? (pending || unresolvedSend ? "unresolved" : "blocked") : worker.retryAt !== undefined ? "retrying"
        : unresolvedSend ? "unresolved" : active || state.routes[routeId]?.queue.length ? "running" : "idle",
        ...(errorCode || worker.retryCode ? { code: errorCode ?? worker.retryCode! } : {}) };
    });
  }
  errors(): string[] { return [...this.workers].filter(([, worker]) => worker.error).map(([id]) => id); }
  async close(): Promise<void> {
    this.ready = false;
    this.progress.close();
    for (const route of this.config.routes) this.typing(route, false);
    this.abort.abort();
    for (const worker of this.workers.values()) { clearTimeout(worker.timer); clearTimeout(worker.retryTimer); clearTimeout(worker.typingTimer); }
    await Promise.all([...this.workers.values()].map((worker) => worker.session?.close()));
    await this.idle();
    await Promise.all(this.cleanups);
  }
}

export function secretEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export class SubmissionFailure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
