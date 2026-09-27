import { DesktopCommentary } from "./desktop-commentary.js";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopIpc, DesktopResponseError, record } from "./desktop-ipc.js";
import { RouterError } from "./errors.js";
import { emitSafely, semanticMessage } from "./turn-state.js";
const unresolved = (message) => new RouterError("thread_unavailable", message, { ambiguous: true });
/** Desktop's complete-history state contains ordered turns, not app-server thread objects. */
export function desktopTurns(snapshot) {
    if (!Array.isArray(snapshot.turns))
        throw new RouterError("app_server_protocol_failed", "Desktop history has no ordered turns.");
    let ordered = snapshot.turns;
    if (snapshot.turnHistory !== undefined) {
        const history = record(snapshot.turnHistory);
        const canonical = record(history.history);
        const islands = canonical.islands;
        if (history.kind !== "canonical" || canonical.isComplete !== true || !Array.isArray(islands) || islands.length !== 1)
            throw unresolved("Desktop history is incomplete or has ambiguous ordering.");
        const island = record(islands[0]);
        if (island.olderBoundary?.status !== "exhausted" || island.newerBoundary?.status !== "exhausted" || !Array.isArray(island.entries))
            throw unresolved("Desktop history has an unresolved ordering boundary.");
        const entities = record(canonical.entitiesByKey);
        const keys = new Set();
        ordered = island.entries.map((value) => {
            const entry = record(value);
            if (typeof entry.value !== "string" || entry.key !== entry.value || keys.has(entry.value) || !entities[entry.value])
                throw unresolved("Desktop history has invalid entity references.");
            keys.add(entry.value);
            return entities[entry.value];
        });
        // Canonical history is the authoritative ordered view. Live tail entries must
        // agree when duplicated; never append a second copy of an accepted turn.
        for (const value of snapshot.turns) {
            const tail = record(value);
            if (tail.turnId === null)
                continue;
            const existing = ordered.find(value => record(value).turnId === tail.turnId);
            if (!existing)
                throw unresolved("Desktop live tail is not represented in complete canonical history.");
            else if (JSON.stringify(existing) !== JSON.stringify(tail))
                throw unresolved("Desktop live history disagrees with canonical history.");
        }
    }
    const ids = new Set();
    return ordered.flatMap(value => {
        const turn = record(value);
        if (turn.turnId === null)
            return []; // Optimistic drafts are not accepted turns.
        if (typeof turn.turnId !== "string" || ids.has(turn.turnId) || !Array.isArray(turn.items))
            throw new RouterError("app_server_protocol_failed", "Desktop history contains invalid or duplicate turns.");
        if (turn.itemsPagination?.hasLoadedOldest === false)
            throw unresolved("Desktop turn items are incomplete.");
        ids.add(turn.turnId);
        return [turn];
    });
}
// Desktop records accepted steering separately from ordinary user messages.
// The server's steered item establishes ordering; optimistic drafts do not.
function admissionBoundaries(turn, uuid) {
    return turn.items.flatMap((item, index) => {
        if (item.type === "userMessage" && item.clientId === uuid)
            return [index];
        if (item.type !== "steeringUserMessage" || item.clientUserMessageId !== uuid || item.status !== "accepted"
            || item.targetTurnId !== turn.turnId || typeof item.serverUserMessageId !== "string")
            return [];
        return turn.items.flatMap((marker, position) => marker.type === "steered" && marker.id === item.serverUserMessageId ? [position] : []);
    });
}
function correlated(turns, uuid) {
    // Desktop accepts steering before a running tool finishes. Its server marker
    // arrives when the input is consumed, and remains required for output ordering.
    const matches = turns.flatMap(turn => turn.items.filter((item) => (item.type === "userMessage" && item.clientId === uuid)
        || (item.type === "steeringUserMessage" && item.clientUserMessageId === uuid
            && item.status === "accepted" && item.targetTurnId === turn.turnId)).map(() => turn));
    if (matches.length > 1 || (matches[0] && admissionBoundaries(matches[0], uuid).length > 1)) {
        throw unresolved("Desktop history contains duplicate acceptances of the saved message.");
    }
    return matches[0];
}
export function desktopOutcome(turn, uuid, baseline) {
    if (!["completed", "failed", "interrupted"].includes(turn.status))
        return undefined;
    const items = turn.items;
    const boundaries = admissionBoundaries(turn, uuid);
    if (boundaries.length !== 1)
        throw unresolved("Desktop output has no authoritative user-message boundary.");
    const ids = new Set();
    for (const item of items) {
        if (typeof item.id !== "string" || ids.has(item.id))
            throw unresolved("Desktop output ordering cannot be verified.");
        ids.add(item.id);
    }
    const preceding = new Set(baseline);
    const eligible = items.slice(boundaries[0] + 1).filter(item => !preceding.has(item.id));
    const texts = eligible.filter(item => item.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string");
    const finalText = texts.at(-1)?.text;
    if (finalText && Buffer.byteLength(finalText) > 256 * 1024)
        throw new RouterError("output_too_large", "Desktop response exceeds the text limit.");
    const imageGenerations = eligible.filter(item => item.type === "imageGeneration" && item.status === "completed").map(item => ({ id: item.id, ...(typeof item.savedPath === "string" ? { savedPath: item.savedPath } : {}), ...(typeof item.result === "string" ? { result: item.result } : {}) }));
    return { turnId: turn.turnId, status: turn.status, ...(finalText === undefined ? {} : { finalText }), imageGenerations };
}
export class DesktopSession {
    agent;
    ipc;
    owner;
    home;
    signal;
    backend = "desktop";
    get capabilities() { return { steer: true, commentary: this.commentary.status }; }
    serverInfo;
    snapshot;
    commentary;
    get commentaryStatus() { return this.commentary.status; }
    revision = -1;
    streamError;
    baseline = [];
    boundary;
    acceptedTurn;
    admissionBusy;
    disposed = false;
    removeListener;
    constructor(agent, ipc, owner, home, signal) {
        this.agent = agent;
        this.ipc = ipc;
        this.owner = owner;
        this.home = home;
        this.signal = signal;
        this.commentary = new DesktopCommentary(agent.threadId);
        this.serverInfo = { codexHome: home, platformFamily: process.platform === "win32" ? "windows" : "unix", platformOs: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", userAgent: "codex-desktop-ipc" };
        this.removeListener = ipc.onFrame(frame => {
            const params = record(frame.params);
            if (frame.type !== "broadcast" || frame.method !== "thread-stream-state-changed" || params.conversationId !== agent.threadId)
                return;
            if (frame.sourceClientId !== owner || !Array.isArray(frame.targetClientIds) || !frame.targetClientIds.includes(ipc.clientId) || params.hostId !== "local" || frame.version !== 11) {
                this.streamError = new RouterError("app_server_protocol_failed", "Desktop snapshot identity or protocol version mismatch.");
                return;
            }
            const change = record(params.change);
            if (change.type !== "snapshot")
                return; // Every read below requests a full snapshot; patches are never applied partially.
            if (!Number.isSafeInteger(change.revision) || change.revision < 0) {
                this.streamError = new RouterError("app_server_protocol_failed", "Desktop snapshot revision is invalid.");
                return;
            }
            if (change.revision >= this.revision) {
                this.revision = change.revision;
                this.snapshot = record(change.conversationState);
            }
        });
        ipc.follow(owner, agent.threadId, true);
    }
    static async discover(agent, signal) {
        if (agent.sshHost)
            return undefined;
        let home;
        try {
            home = await realpath(process.env.CODEX_HOME || join(homedir(), ".codex"));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
        const ipc = await DesktopIpc.connect(home, signal);
        if (!ipc)
            return undefined;
        try {
            let response;
            try {
                response = await ipc.request("thread-owner-discovery", { hostId: "local", conversationId: agent.threadId }, 1);
            }
            catch (error) {
                if (error instanceof DesktopResponseError && error.response.error === "no-client-found") {
                    ipc.close();
                    return undefined;
                }
                throw error;
            }
            if (typeof response.handledByClientId !== "string")
                throw new RouterError("app_server_protocol_failed", "Desktop owner discovery returned no owner.");
            const session = new DesktopSession(agent, ipc, response.handledByClientId, home, signal);
            try {
                await session.history();
                return session;
            }
            catch (error) {
                await session.close();
                throw error;
            }
        }
        catch (error) {
            ipc.close();
            throw error;
        }
    }
    get artifactBaseline() { return [...this.baseline]; }
    async history() {
        if (this.disposed)
            throw new RouterError("app_server_disconnected", "Desktop session is closed.");
        const response = await this.ipc.request("thread-follower-load-complete-history", { conversationId: this.agent.threadId }, 1, this.owner);
        const revision = response.result?.revision;
        if (!Number.isSafeInteger(revision) || revision < 0)
            throw new RouterError("app_server_protocol_failed", "Desktop history acknowledgement has no revision.");
        const deadline = Date.now() + 15_000;
        while (this.revision < revision || !this.snapshot) {
            if (this.streamError)
                throw this.streamError;
            if (this.ipc.closed)
                throw new RouterError("app_server_disconnected", "Desktop disconnected before the requested history arrived.");
            if (Date.now() >= deadline)
                throw new RouterError("timeout", "Desktop history snapshot timed out.");
            await delay(20, undefined, this.signal ? { signal: this.signal } : {});
        }
        if (this.streamError)
            throw this.streamError;
        const snapshot = this.snapshot;
        if (snapshot.id !== this.agent.threadId || snapshot.hostId !== "local" || typeof snapshot.cwd !== "string" || await realpath(snapshot.cwd) !== await realpath(this.agent.cwd))
            throw new RouterError("thread_unavailable", "Desktop task identity does not match the configured local task.");
        if (typeof snapshot.rolloutPath !== "string" || !isAbsolute(snapshot.rolloutPath))
            throw new RouterError("thread_unavailable", "Desktop task does not identify its Codex home.");
        const rollout = await realpath(snapshot.rolloutPath);
        const suffix = relative(this.home, rollout);
        if (suffix.startsWith(`..${sep}`) || isAbsolute(suffix) || !["sessions", "archived_sessions"].includes(suffix.split(sep)[0]))
            throw new RouterError("thread_unavailable", "Desktop task belongs to a different Codex home.");
        return desktopTurns(snapshot);
    }
    async resume() {
        this.admissionBusy = undefined;
        const turns = await this.history();
        this.admissionBusy = this.snapshot?.threadRuntimeStatus?.type !== "idle" || turns.some(turn => !["completed", "failed", "interrupted"].includes(turn.status));
        if (!this.boundary)
            this.baseline = turns.flatMap(turn => turn.items.flatMap((item) => typeof item.id === "string" ? [item.id] : []));
        const active = this.snapshot?.threadRuntimeStatus?.type === "idle" ? undefined : turns.find(turn => !["completed", "failed", "interrupted"].includes(turn.status));
        return { thread: { ...this.snapshot, status: { type: active ? "active" : "idle" }, turns: turns.map(turn => ({ ...turn, id: turn.turnId })) }, ...(active ? { activeTurn: { ...active, id: active.turnId } } : {}) };
    }
    async admit(input, intent) {
        if (intent.expectedTurnId) {
            if (!this.snapshot)
                throw new RouterError("thread_busy", "Desktop steering requires a current turn snapshot.");
            const turns = desktopTurns(this.snapshot);
            const active = turns.find(turn => turn.turnId === intent.expectedTurnId && !["completed", "failed", "interrupted"].includes(turn.status));
            if (!active)
                throw new RouterError("thread_busy", "The active Desktop turn changed before steering.");
            try {
                const response = await this.ipc.request("thread-follower-steer-turn", {
                    conversationId: this.agent.threadId, clientUserMessageId: intent.clientUserMessageId, input,
                    restoreMessage: { context: { commentAttachments: [] }, responsesapiClientMetadata: {} },
                }, 1, this.owner);
                const id = response.result?.result?.turnId;
                if (id !== intent.expectedTurnId)
                    throw unresolved("Desktop steering did not confirm the expected turn.");
                this.boundary ??= intent.clientUserMessageId;
                this.acceptedTurn = id;
                return id;
            }
            catch (error) {
                throw new RouterError(error instanceof RouterError ? error.code : "app_server_disconnected", "Desktop steering must be reconciled before any retry.", { ambiguous: true, cause: error });
            }
        }
        if (this.acceptedTurn)
            throw new RouterError("thread_busy", "Desktop requires an active turn identity for follow-up input.");
        // Gateway refreshes history before persisting the admission intent. Nothing
        // before the start request may perform fallible asynchronous preflight work.
        if (this.admissionBusy !== false)
            throw new RouterError("thread_busy", "The Desktop task has no confirmed idle state or active turn identity.");
        this.boundary = intent.clientUserMessageId;
        try {
            const response = await this.ipc.request("thread-follower-start-turn", { conversationId: this.agent.threadId, turnStart: { request: { threadId: this.agent.threadId, clientUserMessageId: intent.clientUserMessageId, input, model: this.agent.model, ...(this.agent.reasoning ? { effort: this.agent.reasoning } : {}) }, context: { inheritThreadSettings: true } } }, 2, this.owner);
            const id = response.result?.result?.turn?.id;
            if (typeof id !== "string" || !id)
                throw unresolved("Desktop accepted a request without an authoritative turn identity.");
            this.acceptedTurn = id;
            return id;
        }
        catch (error) {
            throw new RouterError(error instanceof RouterError ? error.code : "app_server_disconnected", "Desktop admission must be reconciled before any retry.", { ambiguous: true, cause: error });
        }
    }
    async accepted(uuid) {
        const deadline = Date.now() + 15_000;
        while (true) {
            const match = correlated(await this.history(), uuid);
            if (match)
                return match;
            if (Date.now() >= deadline)
                throw unresolved("Desktop history does not yet prove acceptance of the saved message.");
            await delay(250, undefined, this.signal ? { signal: this.signal } : {});
        }
    }
    async restore(turnId, intent, baseline, clientUserMessageId) {
        this.baseline = [...baseline];
        this.boundary = clientUserMessageId ?? intent?.clientUserMessageId;
        if (!this.boundary)
            throw unresolved("Desktop recovery requires the saved client message identity.");
        const match = await this.accepted(this.boundary);
        if ((turnId && match.turnId !== turnId) || (intent?.expectedTurnId && match.turnId !== intent.expectedTurnId))
            throw unresolved("Desktop recovery found a different accepted turn.");
        if (intent && (await this.accepted(intent.clientUserMessageId)).turnId !== match.turnId)
            throw unresolved("Desktop pending input belongs to a different turn.");
        this.acceptedTurn = match.turnId;
        return match.turnId;
    }
    async observe(turnId, emit = () => undefined) {
        if (!this.boundary || (this.acceptedTurn && this.acceptedTurn !== turnId))
            throw unresolved("Desktop observation has no saved admission identity.");
        while (true) {
            const turn = await this.accepted(this.boundary);
            if (turn.turnId !== turnId)
                throw unresolved("Desktop observation found a different turn.");
            const boundary = admissionBoundaries(turn, this.boundary)[0] ?? -1;
            const eligible = boundary < 0 ? [] : turn.items.slice(boundary + 1).filter((item) => !this.baseline.includes(item.id));
            for (const message of await this.commentary.poll(this.snapshot.rolloutPath, turnId, eligible)) {
                emitSafely(emit, semanticMessage("commentary", message.text, message.itemId, turnId));
            }
            const outcome = desktopOutcome(turn, this.boundary, this.baseline);
            if (outcome)
                return outcome;
            await delay(1_000, undefined, this.signal ? { signal: this.signal } : {});
        }
    }
    async interrupt(expectedTurnId) {
        if (!this.snapshot || !desktopTurns(this.snapshot).some(turn => turn.turnId === expectedTurnId
            && !["completed", "failed", "interrupted"].includes(turn.status))) {
            throw new RouterError("thread_busy", "The active Desktop turn changed before interruption.");
        }
        try {
            const response = await this.ipc.request("thread-follower-interrupt-turn", {
                conversationId: this.agent.threadId, expectedTurnId, mode: "user-stop",
            }, 4, this.owner);
            if (response.result?.ok !== true || response.result.interruptedTurnId !== expectedTurnId) {
                throw new RouterError("app_server_protocol_failed", "Desktop did not confirm interruption of the expected turn.", { ambiguous: true });
            }
        }
        catch (cause) {
            throw new RouterError("thread_unavailable", "Desktop interruption was not confirmed. Check the turn before trying again.", { cause, ambiguous: true });
        }
    }
    async filesystem(method, params) {
        const p = record(params);
        if (typeof p.path !== "string" || !isAbsolute(p.path))
            throw new RouterError("input_invalid", "Desktop filesystem paths must be absolute.");
        if (method === "fs/createDirectory") {
            await mkdir(p.path, { recursive: p.recursive === true });
            return {};
        }
        if (method === "fs/remove") {
            await rm(p.path, { recursive: p.recursive === true, force: p.force === true });
            return {};
        }
        if (method === "fs/readDirectory")
            return { entries: (await readdir(p.path, { withFileTypes: true })).map(e => ({ fileName: e.name, isFile: e.isFile(), isDirectory: e.isDirectory(), isSymlink: e.isSymbolicLink() })) };
        const s = await lstat(p.path);
        return { isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink(), size: s.size, modifiedAtMs: s.mtimeMs };
    }
    async close() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.removeListener();
        try {
            this.ipc.follow(this.owner, this.agent.threadId, false);
        }
        catch { /* Disconnected followers need no cleanup request. */ }
        this.ipc.close();
    }
}
//# sourceMappingURL=desktop-session.js.map