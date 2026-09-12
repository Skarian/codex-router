import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { RouterError } from "./errors.js";
import { RpcRequestError } from "./json-rpc.js";
import { TurnSession, TurnEndedError } from "./turn-session.js";
import { ADMISSION_FAILURE, bindRoutes, settlePart } from "./gateway-state.js";
export function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
        const abort = () => { finish(); reject(new RouterError("interrupted", "The gateway operation stopped.")); };
        const timer = setTimeout(() => { finish(); resolve(); }, Math.max(0, ms));
        timer.unref();
        if (signal.aborted)
            abort();
        else
            signal.addEventListener("abort", abort, { once: true });
    });
}
function batchInput(batch, publication) {
    const input = [];
    for (const event of [...batch.events].sort((a, b) => a.providerTimeMs - b.providerTimeMs || a.receiptSequence - b.receiptSequence)) {
        if (event.text)
            input.push({ type: "text", text: event.text, text_elements: [] });
        const file = event.attachment;
        if (file?.state === "ready") {
            if (file.inputKind === "image")
                input.push({ type: "localImage", path: file.hostPath });
            else
                input.push({ type: "text", text: `Attached file: ${JSON.stringify(file.name)} (${file.mediaType}) at ${JSON.stringify(file.hostPath)}.`, text_elements: [] });
        }
        else if (file?.state === "omitted")
            input.push({ type: "text", text: `Attachment omitted: ${JSON.stringify(file.name)} (${file.reason}).`, text_elements: [] });
    }
    input.push({ type: "text", text: `Put intentional response files in ${JSON.stringify(publication)}. Only files in this directory and native generated images will be delivered.`, text_elements: [] });
    return input;
}
function staleSteer(error) {
    return error instanceof RpcRequestError && error.payload.code === -32600 &&
        (error.payload.message === "no active turn to steer" || /^expected active turn id `[^`]+` but found `[^`]+`$/.test(error.payload.message ?? ""));
}
export class Gateway {
    config;
    store;
    operations;
    ready = false;
    abort = new AbortController();
    workers = new Map();
    live = new Map();
    lineStarts = new Map();
    now;
    constructor(config, store, operations) {
        this.config = config;
        this.store = store;
        this.operations = operations;
        this.now = operations.now ?? Date.now;
        for (const route of config.routes)
            this.workers.set(route.id, { again: false });
    }
    async start() {
        await this.store.transaction((state) => bindRoutes(state, this.config));
        await this.operations.files.cleanup(this.store.snapshot());
        this.ready = true;
        for (const route of this.config.routes)
            this.wake(route.id);
    }
    async receive(accountId, message) {
        if (!this.ready)
            throw new RouterError("storage_failed", "Gateway intake is not ready.");
        const route = this.config.routes.find((route) => route.sendblueId === accountId && route.sender === message.sender && route.sendblueNumber === message.sendblueNumber);
        if (!route)
            return;
        const now = this.now();
        const accepted = await this.store.transaction((state) => {
            if (Object.values(state.routes).some((route) => route.seenMessages.some((seen) => seen.sendblueId === accountId && seen.messageHandle === message.messageHandle)))
                return false;
            const target = state.routes[route.id];
            if (target.openBatch && Math.min(target.openBatch.quietDeadlineMs, target.openBatch.maximumDeadlineMs) <= now) {
                target.queue.push(target.openBatch);
                delete target.openBatch;
            }
            target.openBatch ??= { id: randomUUID(), openedAtMs: now, quietDeadlineMs: now + 5000, maximumDeadlineMs: now + 30000, events: [] };
            const event = { messageHandle: message.messageHandle, providerTimeMs: message.providerTimeMs, receiptSequence: target.nextSequence++, text: message.text,
                ...(message.attachment ? { attachment: { state: "pending", ...message.attachment } } : {}) };
            target.openBatch.events.push(event);
            target.openBatch.quietDeadlineMs = now + 5000;
            target.seenMessages.push({ sendblueId: accountId, messageHandle: message.messageHandle, receivedAtMs: now });
            return true;
        });
        if (accepted) {
            this.typing(route, true);
            this.wake(route.id);
        }
    }
    typing(route, active) {
        const worker = this.workers.get(route.id);
        if (worker.typingTimer) {
            if (active)
                return;
            clearTimeout(worker.typingTimer);
            delete worker.typingTimer;
        }
        void this.operations.connector(route.sendblueId).typing(route, active ? "start" : "stop", this.abort.signal).catch(() => undefined);
        if (active) {
            worker.typingTimer = setTimeout(() => { delete worker.typingTimer; this.typing(route, true); }, 240000);
            worker.typingTimer.unref();
        }
    }
    wake(routeId) {
        const worker = this.workers.get(routeId);
        if (this.abort.signal.aborted || worker.error)
            return;
        worker.again = true;
        if (worker.running)
            return;
        const route = this.config.routes.find((route) => route.id === routeId);
        worker.running = (async () => {
            while (worker.again && !worker.error && !this.abort.signal.aborted) {
                worker.again = false;
                await this.step(route, worker);
            }
        })().catch((error) => { worker.error = error; this.typing(route, false); })
            .finally(() => { delete worker.running; if (worker.again && !worker.error)
            this.wake(route.id); });
    }
    async session(route, worker) {
        if (!worker.session) {
            worker.session = await (this.operations.openSession?.(route, this.abort.signal) ?? TurnSession.open(route.agent, undefined, this.abort.signal));
            await this.operations.files.reconcile(route, this.store.snapshot(), worker.session, this.abort.signal);
        }
        return worker.session;
    }
    observe(route, worker, turnId) {
        if (worker.observation)
            return;
        worker.observation = worker.session.observe(turnId).then((outcome) => { worker.outcome = outcome; this.wake(route.id); }, (error) => { worker.error = error; this.typing(route, false); });
    }
    async step(route, worker) {
        let stored = this.store.snapshot().routes[route.id];
        if (worker.timer) {
            clearTimeout(worker.timer);
            delete worker.timer;
        }
        if (stored.openBatch) {
            const remaining = Math.min(stored.openBatch.quietDeadlineMs, stored.openBatch.maximumDeadlineMs) - this.now();
            if (remaining <= 0) {
                await this.store.transaction((state) => {
                    const target = state.routes[route.id];
                    if (target.openBatch && Math.min(target.openBatch.quietDeadlineMs, target.openBatch.maximumDeadlineMs) <= this.now()) {
                        target.queue.push(target.openBatch);
                        delete target.openBatch;
                    }
                });
                stored = this.store.snapshot().routes[route.id];
            }
            else {
                worker.timer = setTimeout(() => this.wake(route.id), remaining);
                worker.timer.unref();
            }
        }
        const active = stored.active;
        if (active?.kind === "delivery") {
            const sending = active.parts.find((part) => part.status === "sending");
            if (sending) {
                this.typing(route, false);
                return;
            }
            const next = active.parts.find((part) => part.status === "ready");
            if (next) {
                await this.store.transaction((state) => {
                    const delivery = state.routes[route.id].active;
                    const part = delivery.parts.find((part) => part.id === next.id);
                    part.status = "sending";
                    part.callbackToken = randomUUID();
                });
                await this.sendPart(route, next.id);
                worker.again = true;
            }
            else {
                await this.store.transaction((state) => { delete state.routes[route.id].active; });
                await worker.session?.close();
                delete worker.session;
                delete worker.observation;
                delete worker.outcome;
                for (const part of active.parts)
                    this.live.delete(part.id);
                this.typing(route, false);
                worker.again = true;
            }
            return;
        }
        if (active?.kind === "codex") {
            if (active.admissionFailed && !active.turnId) {
                await this.freeze(route, active, [{ id: randomUUID(), status: "ready", payload: { kind: "text", text: ADMISSION_FAILURE } }]);
                worker.again = true;
                return;
            }
            const session = await this.session(route, worker);
            if (!worker.observation) {
                const intent = active.pendingAdmission;
                const turnId = await session.restore(active.turnId, intent ? { clientUserMessageId: intent.clientUserMessageId,
                    ...(intent.expectedTurnId ? { expectedTurnId: intent.expectedTurnId } : {}) } : undefined, active.artifactBaseline);
                await this.store.transaction((state) => {
                    const work = state.routes[route.id].active;
                    work.turnId = turnId;
                    if (work.pendingAdmission && work.pendingAdmission.batchId !== work.ownerBatchId)
                        work.joinedBatchIds.push(work.pendingAdmission.batchId);
                    delete work.pendingAdmission;
                });
                this.observe(route, worker, turnId);
                stored = this.store.snapshot().routes[route.id];
            }
            const work = stored.active;
            if (worker.outcome && !work.pendingAdmission) {
                const parts = await this.operations.files.delivery(route, work, worker.outcome, session, this.operations.connector(route.sendblueId), this.abort.signal);
                await this.freeze(route, work, parts);
                worker.again = true;
                return;
            }
            if (work.admissionFailed || work.pendingAdmission || !stored.queue.length)
                return;
        }
        else if (!stored.queue.length) {
            if (!stored.openBatch)
                this.typing(route, false);
            return;
        }
        const session = await this.session(route, worker);
        const resumed = await session.resume();
        const expectedTurnId = active?.kind === "codex" ? active.turnId : resumed.activeTurn?.id;
        const first = stored.queue[0];
        const batch = await this.operations.files.prepareBatch(route, first, session, this.abort.signal);
        if (worker.outcome) {
            worker.again = true;
            return;
        }
        const intent = { batchId: batch.id, clientUserMessageId: randomUUID(), publicationId: randomUUID(), ...(expectedTurnId ? { expectedTurnId } : {}) };
        await this.store.transaction((state) => {
            const target = state.routes[route.id];
            if (target.queue[0]?.id !== batch.id)
                throw new RouterError("state_invalid", "The admission queue changed unexpectedly.");
            target.queue.shift();
            const firstAdmission = !target.active;
            target.active ??= { kind: "codex", ownerBatchId: batch.id, joinedBatchIds: [], batches: [], publicationIds: [], artifactBaseline: session.artifactBaseline };
            const work = target.active;
            work.batches.push(batch);
            work.publicationIds.push(intent.publicationId);
            work.pendingAdmission = intent;
            if (firstAdmission && resumed.activeTurn && Array.isArray(resumed.activeTurn.items)) {
                work.artifactBaseline = resumed.activeTurn.items.flatMap((item) => item.type === "imageGeneration" && item.id ? [item.id] : []);
            }
        });
        const publication = await this.operations.files.publication(route, intent.publicationId, session, this.abort.signal);
        try {
            const turnId = await session.admit(batchInput(batch, publication), intent);
            await this.store.transaction((state) => {
                const work = state.routes[route.id].active;
                work.turnId = turnId;
                if (batch.id !== work.ownerBatchId)
                    work.joinedBatchIds.push(batch.id);
                delete work.pendingAdmission;
            });
            this.observe(route, worker, turnId);
        }
        catch (error) {
            if (!(error instanceof RpcRequestError) && !(error instanceof TurnEndedError))
                throw error;
            await this.store.transaction((state) => {
                const target = state.routes[route.id];
                const work = target.active;
                delete work.pendingAdmission;
                if (expectedTurnId && (staleSteer(error) || error instanceof TurnEndedError)) {
                    work.batches = work.batches.filter((value) => value.id !== batch.id);
                    work.publicationIds = work.publicationIds.filter((value) => value !== intent.publicationId);
                    target.queue.unshift(batch);
                    if (!work.turnId)
                        delete target.active;
                }
                else
                    work.admissionFailed = true;
            });
            if (!this.store.snapshot().routes[route.id].active) {
                await session.close();
                delete worker.session;
            }
        }
        this.typing(route, true);
        worker.again = true;
    }
    async freeze(route, work, parts) {
        await this.store.transaction((state) => {
            const current = state.routes[route.id].active;
            if (current?.kind !== "codex" || current.pendingAdmission)
                throw new RouterError("state_invalid", "The response still has an unresolved admission.");
            state.routes[route.id].active = { kind: "delivery", id: randomUUID(), batchIds: work.batches.map((batch) => batch.id), parts };
        });
    }
    currentPart(partId) {
        const state = this.store.snapshot();
        for (const route of this.config.routes) {
            const delivery = state.routes[route.id]?.active;
            if (delivery?.kind !== "delivery")
                continue;
            const part = delivery.parts.find((part) => part.id === partId);
            if (part)
                return { route, delivery, part };
        }
        return undefined;
    }
    async callback(account, partId, token, callback) {
        const current = this.currentPart(partId);
        if (!current || current.route.sendblueId !== account || current.part.status !== "sending")
            return true;
        if (!secretEqual(current.part.callbackToken, token))
            return false;
        const live = this.live.get(partId);
        if (["REGISTERED", "PENDING", "QUEUED", "ACCEPTED", "SENT", "DELIVERED"].includes(callback.status) && callback.providerHandle) {
            await this.settle(partId, { status: "accepted", providerHandle: callback.providerHandle });
        }
        else if (["DECLINED", "ERROR"].includes(callback.status) && live?.running && live.attemptsStarted === 1) {
            await this.settle(partId, { status: "failed" });
        }
        if (this.live.get(partId)?.durable)
            delete this.workers.get(current.route.id).error;
        this.wake(current.route.id);
        return true;
    }
    settle(partId, outcome) {
        let live = this.live.get(partId);
        if (!live) {
            live = { attemptsStarted: 0, abort: new AbortController(), durable: false, running: false };
            this.live.set(partId, live);
        }
        live.settlement ??= outcome;
        live.abort.abort();
        if (live.persistence)
            return live.persistence;
        const selected = live.settlement;
        const entry = live;
        entry.persistence = this.store.transaction((state) => {
            for (const route of Object.values(state.routes)) {
                const delivery = route.active;
                if (delivery?.kind !== "delivery")
                    continue;
                const part = delivery.parts.find((part) => part.id === partId && part.status === "sending");
                if (part)
                    settlePart(part, delivery, selected);
            }
        }).then(() => { entry.durable = true; }).catch((error) => { delete entry.persistence; throw error; });
        return entry.persistence;
    }
    async lineSlot(number, signal) {
        while (true) {
            if (signal.aborted)
                throw new RouterError("interrupted", "The send operation stopped.");
            const starts = (this.lineStarts.get(number) ?? []).filter((time) => time > this.now() - 1000);
            this.lineStarts.set(number, starts);
            if (starts.length < 10)
                return;
            await delay(starts[0] + 1000 - this.now(), signal);
        }
    }
    async sendPart(route, partId) {
        const live = { attemptsStarted: 0, abort: new AbortController(), durable: false, running: true };
        this.live.set(partId, live);
        const onAbort = () => live.abort.abort();
        this.abort.signal.addEventListener("abort", onAbort, { once: true });
        let uncertain = false;
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                await this.lineSlot(route.sendblueNumber, live.abort.signal);
                const current = this.currentPart(partId);
                if (!current || current.part.status !== "sending" || live.abort.signal.aborted || live.settlement)
                    break;
                // No await separates limiter reservation, eligibility, and the physical request.
                const starts = this.lineStarts.get(route.sendblueNumber);
                if (starts.length >= 10) {
                    attempt--;
                    continue;
                }
                starts.push(this.now());
                live.attemptsStarted++;
                const callbackUrl = `${this.config.publicUrl}/callbacks/sendblue/${route.sendblueId}/${partId}/${current.part.callbackToken}`;
                const request = this.operations.connector(route.sendblueId).send(route, current.part, callbackUrl, live.abort.signal);
                const result = await request.catch(() => ({ status: "uncertain", retryable: true }));
                if (live.settlement)
                    break;
                if (result.status === "accepted") {
                    await this.settle(partId, result);
                    break;
                }
                if (!uncertain && result.status === "rejected" && !result.retryable) {
                    await this.settle(partId, { status: "failed" });
                    break;
                }
                uncertain = true;
                if (!result.retryable || attempt === 2)
                    break;
                await delay(result.retryAfterMs ?? 500 * 2 ** attempt, live.abort.signal);
            }
        }
        catch (error) {
            if (!live.abort.signal.aborted)
                throw error;
        }
        finally {
            live.running = false;
            this.abort.signal.removeEventListener("abort", onAbort);
            if (live.persistence)
                await live.persistence;
        }
    }
    async idle() {
        while ([...this.workers.values()].some((worker) => worker.running)) {
            await Promise.all([...this.workers.values()].map((worker) => worker.running));
        }
    }
    errors() { return [...this.workers].filter(([, worker]) => worker.error).map(([id]) => id); }
    async close() {
        this.ready = false;
        for (const route of this.config.routes)
            this.typing(route, false);
        this.abort.abort();
        for (const worker of this.workers.values()) {
            clearTimeout(worker.timer);
            clearTimeout(worker.typingTimer);
        }
        await Promise.all([...this.workers.values()].map((worker) => worker.session?.close()));
        await this.idle();
    }
}
export function secretEqual(left, right) {
    return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}
//# sourceMappingURL=gateway.js.map