import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
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
const batchSchema = v.strictObject({ id: str, openedAtMs: number, quietDeadlineMs: number, maximumDeadlineMs: number, events: v.array(eventSchema) });
const intentSchema = v.strictObject({ batchId: str, clientUserMessageId: str, publicationId: str, expectedTurnId: v.optional(str) });
const workSchema = v.strictObject({
    kind: v.literal("codex"), ownerBatchId: str, joinedBatchIds: v.array(str), batches: v.array(batchSchema), turnId: v.optional(str),
    pendingAdmission: v.optional(intentSchema), publicationIds: v.array(str), artifactBaseline: v.array(str), admissionFailed: v.optional(v.literal(true)),
});
const payloadSchema = v.variant("kind", [
    v.strictObject({ kind: v.literal("text"), text: v.string() }),
    v.strictObject({ kind: v.literal("media"), localPath: str, name: str, mediaType: str, mediaUrl: str }),
]);
const partSchema = v.strictObject({ id: str, payload: payloadSchema, status: v.picklist(["ready", "sending", "accepted", "failed", "skipped"]), callbackToken: v.optional(str), providerHandle: v.optional(str) });
const deliverySchema = v.strictObject({ kind: v.literal("delivery"), id: str, batchIds: v.array(str), parts: v.array(partSchema) });
const bindingSchema = v.strictObject({ sendblueId: str, sender: str, sendblueNumber: str, target: v.strictObject({ sshHost: v.nullable(str), threadId: str, cwd: str }) });
const routeSchema = v.strictObject({
    binding: bindingSchema, nextSequence: number,
    seenMessages: v.array(v.strictObject({ sendblueId: str, messageHandle: str, receivedAtMs: number })),
    openBatch: v.optional(batchSchema), queue: v.array(batchSchema), active: v.optional(v.variant("kind", [workSchema, deliverySchema])),
});
const stateSchema = v.strictObject({ version: v.literal(1), routes: v.record(str, routeSchema) });
export const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ADMISSION_FAILURE = "Codex did not confirm the latest input. It was not sent again.";
export function routeBinding(route) {
    return { sendblueId: route.sendblueId, sender: route.sender, sendblueNumber: route.sendblueNumber,
        target: { sshHost: route.agent.sshHost ?? null, threadId: route.agent.threadId, cwd: route.agent.cwd } };
}
export function validateState(value) {
    const parsed = v.safeParse(stateSchema, value);
    if (!parsed.success)
        throw new RouterError("state_invalid", "The canonical gateway state is invalid.");
    const state = parsed.output;
    for (const route of Object.values(state.routes)) {
        const work = route.active;
        const batchIds = new Set();
        for (const batch of [...(route.openBatch ? [route.openBatch] : []), ...route.queue, ...(work?.kind === "codex" ? work.batches : [])]) {
            if (batchIds.has(batch.id) || !batch.events.length || batch.quietDeadlineMs < batch.openedAtMs || batch.maximumDeadlineMs < batch.openedAtMs) {
                throw new RouterError("state_invalid", "The gateway batch references are invalid.");
            }
            batchIds.add(batch.id);
        }
        if (work?.kind === "codex") {
            const owned = new Set(work.batches.map((batch) => batch.id));
            if (!owned.has(work.ownerBatchId) || work.joinedBatchIds.some((id) => !owned.has(id) || id === work.ownerBatchId)
                || new Set(work.joinedBatchIds).size !== work.joinedBatchIds.length
                || (work.pendingAdmission && (!owned.has(work.pendingAdmission.batchId)
                    || !work.publicationIds.includes(work.pendingAdmission.publicationId)
                    || work.joinedBatchIds.includes(work.pendingAdmission.batchId)))) {
                throw new RouterError("state_invalid", "The gateway admission references are invalid.");
            }
        }
        if (work?.kind === "delivery") {
            const ids = new Set();
            let unfinished = false;
            let blocked = false;
            for (const part of work.parts) {
                if (ids.has(part.id) || (part.status === "sending" ? !part.callbackToken || !!part.providerHandle
                    : part.status === "accepted" ? !part.providerHandle || !!part.callbackToken : !!part.callbackToken || !!part.providerHandle)
                    || (unfinished && (part.status === "accepted" || part.status === "sending"))
                    || (blocked && part.status !== "skipped"))
                    throw new RouterError("state_invalid", "The gateway delivery order is invalid.");
                ids.add(part.id);
                unfinished ||= part.status !== "accepted";
                blocked ||= part.status === "failed";
            }
        }
    }
    return state;
}
export function bindRoutes(state, config) {
    for (const [id, stored] of Object.entries(state.routes)) {
        const current = config.routes.find((route) => route.id === id);
        const pending = stored.openBatch || stored.queue.length || stored.active;
        if (pending && (!current || JSON.stringify(stored.binding) !== JSON.stringify(routeBinding(current)))) {
            throw new RouterError("config_invalid", "A route with pending work changed its recipient or Codex target.");
        }
    }
    for (const route of config.routes) {
        const previous = Object.hasOwn(state.routes, route.id) ? state.routes[route.id] : undefined;
        state.routes[route.id] = previous
            ? { ...previous, binding: routeBinding(route) }
            : { binding: routeBinding(route), nextSequence: 0, seenMessages: [], queue: [] };
    }
}
async function ownerOnly(path, directory) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
        || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new RouterError("state_invalid", "Gateway storage must be owner-only and must not use symlinks.");
    }
}
async function lock(directory) {
    const path = join(directory, "lock");
    const ownerPath = join(path, "owner.json");
    const token = randomUUID();
    const claim = async () => {
        await mkdir(path, { mode: 0o700 });
        await writeSynced(ownerPath, JSON.stringify({ pid: process.pid, host: hostname(), token }));
    };
    try {
        await claim();
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        await ownerOnly(path, true);
        let reclaim;
        let reclaimed = false;
        try {
            reclaim = await open(join(path, "reclaim"), "wx", 0o600);
            const owner = JSON.parse(await readFile(ownerPath, "utf8"));
            if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || owner.host !== hostname())
                throw new Error("unverifiable owner");
            try {
                process.kill(Number(owner.pid), 0);
                throw new Error("live owner");
            }
            catch (failure) {
                if (failure.code !== "ESRCH")
                    throw failure;
            }
            const stale = join(directory, `stale-lock-${token}`);
            await rename(path, stale);
            reclaimed = true;
            await claim();
            await rm(stale, { recursive: true });
        }
        catch (cause) {
            throw new RouterError("gateway_running", "The gateway state is locked or its owner cannot be verified.", { cause });
        }
        finally {
            await reclaim?.close();
            // A live owner's directory must not retain this contender's claim.
            if (reclaim && !reclaimed)
                await rm(join(path, "reclaim"), { force: true }).catch(() => undefined);
        }
    }
    return async () => {
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        if (owner.token === token)
            await rm(path, { recursive: true });
    };
}
async function writeSynced(path, data) {
    const file = await open(path, "wx", 0o600);
    try {
        await file.writeFile(data);
        await file.sync();
    }
    finally {
        await file.close();
    }
}
export class GatewayStore {
    directory;
    state;
    unlock;
    beforeWrite;
    queue = Promise.resolve();
    poisoned = false;
    closed = false;
    closeFlight;
    constructor(directory, state, unlock, beforeWrite) {
        this.directory = directory;
        this.state = state;
        this.unlock = unlock;
        this.beforeWrite = beforeWrite;
    }
    static async open(directory, beforeWrite) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await ownerOnly(directory, true);
        const unlock = await lock(directory);
        try {
            let state = { version: 1, routes: {} };
            try {
                await ownerOnly(join(directory, "state.json"), false);
                state = validateState(JSON.parse(await readFile(join(directory, "state.json"), "utf8")));
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw new RouterError("state_invalid", "The canonical gateway state cannot be loaded.", { cause: error });
            }
            return new GatewayStore(directory, state, unlock, beforeWrite);
        }
        catch (error) {
            await unlock();
            throw error;
        }
    }
    snapshot() { return structuredClone(this.state); }
    transaction(change) {
        if (this.closeFlight)
            return Promise.reject(new RouterError("storage_failed", "The gateway state writer is closed."));
        const operation = this.queue.then(async () => {
            if (this.closed || this.poisoned)
                throw new RouterError("storage_failed", "The gateway state writer is unavailable.");
            const draft = structuredClone(this.state);
            const result = change(draft);
            const cutoff = Date.now() - SEEN_RETENTION_MS;
            for (const route of Object.values(draft.routes))
                route.seenMessages = route.seenMessages.filter((seen) => seen.receivedAtMs >= cutoff);
            validateState(draft);
            await this.beforeWrite?.();
            const temp = join(this.directory, `state-${randomUUID()}.tmp`);
            let renamed = false;
            try {
                await writeSynced(temp, JSON.stringify(draft));
                await rename(temp, join(this.directory, "state.json"));
                renamed = true;
                const directory = await open(this.directory, constants.O_RDONLY);
                try {
                    await directory.sync();
                }
                finally {
                    await directory.close();
                }
                this.state = draft;
            }
            catch (cause) {
                if (renamed)
                    this.poisoned = true;
                throw new RouterError("storage_failed", "The gateway snapshot could not be stored.", { cause });
            }
            finally {
                await rm(temp, { force: true }).catch(() => undefined);
            }
            return result;
        });
        this.queue = operation.catch(() => undefined);
        return operation;
    }
    close() {
        this.closeFlight ??= (async () => { await this.queue; this.closed = true; await this.unlock(); })();
        return this.closeFlight;
    }
}
export function unresolved(state) {
    return { unresolved: Object.entries(state.routes).flatMap(([routeId, route]) => {
            if (route.active?.kind === "codex" && route.active.pendingAdmission)
                return [{ routeId, effectId: route.active.pendingAdmission.clientUserMessageId, kind: "codex_admission" }];
            if (route.active?.kind === "delivery")
                return route.active.parts.filter((part) => part.status === "sending")
                    .map((part) => ({ routeId, effectId: part.id, kind: "send" }));
            return [];
        }) };
}
export function settlePart(part, delivery, outcome) {
    part.status = outcome.status;
    delete part.callbackToken;
    if (outcome.status === "accepted")
        part.providerHandle = outcome.providerHandle;
    else
        for (const later of delivery.parts.slice(delivery.parts.indexOf(part) + 1))
            if (later.status === "ready")
                later.status = "skipped";
}
export function resolveEffect(state, routeId, effectId, resolution, providerHandle) {
    const active = state.routes[routeId]?.active;
    if (active?.kind === "codex" && active.pendingAdmission?.clientUserMessageId === effectId && resolution === "failed") {
        delete active.pendingAdmission;
        active.admissionFailed = true;
    }
    else if (active?.kind === "delivery") {
        const part = active.parts.find((part) => part.id === effectId && part.status === "sending");
        if (!part || (resolution === "accepted" && !providerHandle))
            throw new RouterError("effect_not_found", "The unresolved effect was not found.");
        settlePart(part, active, resolution === "accepted" ? { status: "accepted", providerHandle: providerHandle } : { status: "failed" });
    }
    else
        throw new RouterError("effect_not_found", "The unresolved effect was not found.");
    return { type: "resolved", routeId, effectId, resolution, ...(resolution === "accepted" ? { providerHandle } : {}) };
}
//# sourceMappingURL=gateway-state.js.map