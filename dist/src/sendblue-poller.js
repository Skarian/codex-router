/** Outbound-only intake. Provider offsets are reconciled by overlapping bounded sweeps. */
export const POLL_OVERLAP_MS = 24 * 60 * 60 * 1000;
export const POLL_STEP_MS = POLL_OVERLAP_MS / 2;
export const POLL_HORIZON_MS = 29 * POLL_OVERLAP_MS;
class PollFailure extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new PollFailure('poll_invalid_response');
    return value;
}
function timestamp(value) {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(time))
        throw new PollFailure('poll_invalid_message');
    return time;
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const stop = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
        signal.addEventListener('abort', stop, { once: true });
    });
}
export class SendbluePoller {
    options;
    now;
    wait;
    nextRequestAt = 0;
    sweeping = false;
    running = false;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.wait = options.wait ?? sleep;
    }
    status(value) {
        try {
            this.options.onStatus?.(value);
        }
        catch { /* Observers cannot stop intake. */ }
    }
    async sweep(signal) {
        if (this.sweeping)
            throw new PollFailure('poll_already_running');
        this.sweeping = true;
        try {
            signal.throwIfAborted();
            const state = this.options.state();
            const now = this.now();
            if (![state.activationAtMs, state.completedThroughMs].every(Number.isSafeInteger)
                || state.completedThroughMs < state.activationAtMs || state.completedThroughMs > now)
                throw new PollFailure('poll_invalid_state');
            if (now - state.completedThroughMs > POLL_HORIZON_MS)
                throw new PollFailure('poll_recovery_required');
            const lower = Math.max(state.activationAtMs, state.completedThroughMs - POLL_OVERLAP_MS);
            const upper = Math.min(now, state.completedThroughMs + POLL_STEP_MS);
            this.status({ state: 'running' });
            for (const line of new Set(this.options.routes.map(route => route.sendblueNumber))) {
                let offset = 0;
                let previousUpdated = -Infinity;
                let previousPage = new Set();
                for (let pageNumber = 0;; pageNumber++) {
                    signal.throwIfAborted();
                    // A pathological response must not consume unbounded memory or spin forever.
                    if (pageNumber >= 1000)
                        throw new PollFailure('poll_scan_too_large');
                    if (this.nextRequestAt > this.now())
                        await this.wait(this.nextRequestAt - this.now(), signal);
                    signal.throwIfAborted();
                    this.nextRequestAt = this.now() + 110; // Below the provider's 100 requests / 10 seconds account budget.
                    const page = object(await this.options.list({ is_outbound: 'false', message_type: 'message', status: 'RECEIVED',
                        sendblue_number: line, updated_at_gte: new Date(lower).toISOString(), updated_at_lte: new Date(upper).toISOString(),
                        order_by: 'updatedAt', order_direction: 'asc', offset, limit: 100 }, signal));
                    signal.throwIfAborted();
                    if (!Array.isArray(page.data) || page.data.length > 100)
                        throw new PollFailure('poll_invalid_response');
                    const pagination = object(page.pagination);
                    if (typeof pagination.hasMore !== 'boolean' || pagination.offset !== offset
                        || (pagination.limit !== undefined && (!Number.isSafeInteger(pagination.limit) || Number(pagination.limit) < page.data.length)))
                        throw new PollFailure('poll_invalid_response');
                    const identities = new Set();
                    let newIdentities = 0;
                    for (const raw of page.data) {
                        const row = object(raw);
                        if (typeof row.message_handle !== 'string' || !row.message_handle)
                            throw new PollFailure('poll_invalid_message');
                        const updated = timestamp(row.date_updated);
                        if (updated < lower || updated > upper || updated < previousUpdated)
                            throw new PollFailure('poll_invalid_order');
                        previousUpdated = updated;
                        if (!previousPage.has(row.message_handle))
                            newIdentities++;
                        identities.add(row.message_handle);
                        // A malformed row is not evidence that it is outside this subscription.
                        // Validate routing/direction before filtering or a checkpoint could hide it.
                        const statuses = ['REGISTERED', 'PENDING', 'SENT', 'DELIVERED', 'RECEIVED', 'QUEUED', 'ERROR', 'DECLINED', 'ACCEPTED', 'SUCCESS'];
                        if (typeof row.is_outbound !== 'boolean' || typeof row.status !== 'string' || !statuses.includes(row.status)
                            || typeof row.from_number !== 'string' || !/^\+[1-9]\d{6,14}$/.test(row.from_number)
                            || typeof row.sendblue_number !== 'string' || row.sendblue_number !== line
                            || (row.message_type !== 'message' && row.message_type !== 'group')
                            || (row.group_id != null && typeof row.group_id !== 'string'))
                            throw new PollFailure('poll_invalid_message');
                        if (row.is_outbound || row.message_type === 'group' || row.group_id || row.status !== 'RECEIVED')
                            continue;
                        const route = this.options.routes.find(route => route.sendblueNumber === row.sendblue_number && route.sender === row.from_number);
                        if (!route)
                            continue;
                        const activation = state.routeActivationAtMs[route.id];
                        if (!Number.isSafeInteger(activation))
                            throw new PollFailure('poll_invalid_state');
                        const sent = timestamp(row.date_sent);
                        if (sent < Math.max(activation, now - POLL_HORIZON_MS))
                            continue;
                        signal.throwIfAborted();
                        await this.options.receive(row);
                    }
                    if (!pagination.hasMore)
                        break;
                    if (!page.data.length || !newIdentities)
                        throw new PollFailure('poll_nonprogressing_page');
                    previousPage = identities;
                    offset += page.data.length;
                }
            }
            signal.throwIfAborted();
            await this.options.checkpoint(upper);
            this.status({ state: 'idle' });
            return { caughtUp: upper >= now, completedThroughMs: upper };
        }
        finally {
            this.sweeping = false;
        }
    }
    async run(signal) {
        if (this.running)
            throw new PollFailure('poll_already_running');
        this.running = true;
        let failures = 0;
        try {
            while (!signal.aborted) {
                let waitMs = this.options.intervalMs ?? 5000;
                try {
                    const result = await this.sweep(signal);
                    failures = 0;
                    if (!result.caughtUp)
                        continue;
                }
                catch (error) {
                    if (signal.aborted)
                        break;
                    const code = error instanceof PollFailure ? error.code : 'poll_request_failed';
                    const retry = error && typeof error === 'object' && 'retryAfterMs' in error ? error.retryAfterMs : undefined;
                    waitMs = Math.max(Math.min(60000, 5000 * 2 ** Math.min(failures++, 4)), typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? retry : 0);
                    this.status({ state: code === 'poll_recovery_required' ? 'blocked' : 'degraded', code, nextRetryAt: this.now() + waitMs });
                }
                try {
                    await this.wait(waitMs, signal);
                }
                catch (error) {
                    if (!signal.aborted)
                        throw error;
                }
            }
        }
        finally {
            this.running = false;
        }
    }
}
//# sourceMappingURL=sendblue-poller.js.map