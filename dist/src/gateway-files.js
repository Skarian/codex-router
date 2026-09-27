import { preparePrivateDirectory, assertPrivatePath, validateExistingPrivatePaths, assertNativeStoragePath, syncDirectory, noFollowFlag } from "./platform-storage.js";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve, basename } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileTypeFromFile } from "file-type";
import { RouterError } from "./errors.js";
import { delay } from "./gateway.js";
import { ADMISSION_FAILURE } from "./gateway-state.js";
import { sshProcessSpec } from "./transport.js";
const exec = promisify(execFile);
const MAX_SENDBLUE_BYTES = 100000000;
class FileOmission extends Error {
    reason;
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
export function safeFilename(value) {
    const name = value.replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 180);
    return !name || name === "." || name === ".." ? "attachment" : name;
}
function component(value) {
    if (!/^[a-zA-Z0-9_-]+$/.test(value))
        throw new FileOmission("unsafe_file");
    return value;
}
function localStorage(error) {
    return new RouterError("storage_failed", "A gateway file could not be stored.", { cause: error });
}
async function assertNoSymlinks(path) {
    if (!isAbsolute(path))
        throw new FileOmission("unsafe_file");
    if (process.platform === "win32") {
        try {
            assertNativeStoragePath(path);
        }
        catch {
            throw new FileOmission("unsafe_file");
        }
    }
    let cursor = resolve(path);
    while (true) {
        const stat = await lstat(cursor).catch(() => { throw new FileOmission("unsafe_file"); });
        if (stat.isSymbolicLink())
            throw new FileOmission("unsafe_file");
        if (cursor === dirname(cursor))
            break;
        cursor = dirname(cursor);
    }
}
export async function inspectLocal(path) {
    await assertNoSymlinks(path);
    const stat = await lstat(path, { bigint: true });
    if (!stat.isFile())
        throw new FileOmission("unsafe_file");
    return { size: Number(stat.size), identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") };
}
async function promote(temp, destination) {
    try {
        const file = await open(temp, constants.O_RDWR | noFollowFlag);
        try {
            await file.sync();
        }
        finally {
            await file.close();
        }
        await link(temp, destination);
        await rm(temp);
        await syncDirectory(dirname(destination));
    }
    catch (error) {
        throw localStorage(error);
    }
}
async function streamToLocal(source, destination, signal) {
    const temp = `${destination}.part-${randomUUID()}`;
    const output = createWriteStream(temp, { flags: "wx", mode: 0o600 });
    let writeFailure;
    output.on("error", (error) => { writeFailure = error; });
    try {
        await pipeline(source, output, { signal });
        await promote(temp, destination);
    }
    catch (error) {
        if (error instanceof RouterError)
            throw error;
        const failure = writeFailure;
        if (failure && (failure.syscall === "write" || failure.path === temp
            || ["ENOSPC", "EDQUOT", "EMFILE", "ENFILE"].includes(failure.code ?? "")))
            throw localStorage(failure);
        if (signal.aborted)
            throw new RouterError("interrupted", "The gateway file operation stopped.");
        throw new FileOmission("copy_failed");
    }
    finally {
        await rm(temp, { force: true }).catch(() => undefined);
    }
}
export async function copyLocal(source, destination, signal) {
    const before = await inspectLocal(source);
    await streamToLocal((await open(source, constants.O_RDONLY | noFollowFlag)).createReadStream(), destination, signal);
    const after = await inspectLocal(source);
    if (before.identity !== after.identity || (await inspectLocal(destination)).size !== before.size) {
        await rm(destination, { force: true });
        throw new FileOmission("changing_file");
    }
}
export async function hashFile(path, signal) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, signal ? { signal } : {}))
        hash.update(chunk);
    return hash.digest("hex");
}
const CHECK_PATH = 'cursor=$1; case "$cursor" in /*) ;; *) exit 23;; esac; while :; do if test -L "$cursor"; then exit 23; fi; test "$cursor" = / && break; cursor=${cursor%/*}; test -n "$cursor" || cursor=/; done; ';
async function ssh(route, script, args, signal) {
    const spec = sshProcessSpec(route.agent.sshHost, ["sh", "-c", script, "sh", ...args]);
    try {
        return (await exec(spec.command, spec.args, { signal, maxBuffer: 65536 })).stdout;
    }
    catch (error) {
        if (signal.aborted)
            throw new RouterError("interrupted", "The SSH file operation stopped.");
        throw new FileOmission(error.code === 23 ? "unsafe_file" : "copy_failed");
    }
}
async function remoteMetadata(route, path, session, signal) {
    const stat = session.serverInfo.platformOs === "macos" ? "stat -f '%d|%i|%z|%m|%c' \"$1\"" : "stat -c '%d|%i|%s|%y|%z' -- \"$1\"";
    const value = await ssh(route, CHECK_PATH + 'if ! test -e "$1"; then printf missing; exit 0; fi; test -f "$1" || exit 23; ' + stat, [path], signal);
    if (value === "missing")
        return undefined;
    const metadata = await session.filesystem("fs/getMetadata", { path });
    const size = Number(value.split("|")[2]);
    if (!metadata.isFile || metadata.isSymlink || !Number.isSafeInteger(size) || size < 0)
        throw new FileOmission("unsafe_file");
    return { size, identity: `${value}|${metadata.modifiedAtMs}` };
}
async function remoteUpload(route, source, destination, session, signal) {
    const expected = await inspectLocal(source);
    for (let attempt = 0; attempt < 3; attempt++) {
        let existing;
        try {
            existing = await remoteMetadata(route, destination, session, signal);
        }
        catch (error) {
            if (error instanceof RouterError || attempt === 2)
                throw error;
            await delay(250 * 2 ** attempt, signal);
            continue;
        }
        if (existing) {
            if (existing.size === expected.size)
                return;
            throw new RouterError("storage_failed", "The remote destination differs from the prepared input.");
        }
        const temp = `${destination}.part-${randomUUID()}`;
        const script = CHECK_PATH + 'umask 077; trap \'rm -f -- "$2"\' EXIT; cat >"$2" || exit 24; actual=$(wc -c <"$2"); test "$actual" -eq "$3" || exit 24; sync; ln -- "$2" "$1" || exit 24; rm -f -- "$2"; sync';
        const spec = sshProcessSpec(route.agent.sshHost, ["sh", "-c", script, "sh", destination, temp, String(expected.size)]);
        const child = spawn(spec.command, spec.args, { stdio: ["pipe", "ignore", "ignore"], signal });
        const exited = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => code === 0 ? resolve() : reject(new FileOmission("copy_failed")));
        });
        try {
            await Promise.all([pipeline(createReadStream(source), child.stdin, { signal }), exited]);
            const stored = await remoteMetadata(route, destination, session, signal);
            if (!stored || stored.size !== expected.size)
                throw new RouterError("storage_failed", "The remote input could not be reconciled.");
            if ((await inspectLocal(source)).identity !== expected.identity)
                throw new RouterError("storage_failed", "The prepared input changed during transfer.");
            return;
        }
        catch (error) {
            child.kill();
            await exited.catch(() => undefined);
            if (signal.aborted)
                throw new RouterError("interrupted", "The SSH file operation stopped.");
            if (error instanceof RouterError)
                throw error;
            let stored;
            try {
                stored = await remoteMetadata(route, destination, session, signal);
            }
            catch (error) {
                if (error instanceof RouterError || attempt === 2)
                    throw error;
            }
            if (stored) {
                if (stored.size === expected.size)
                    return;
                throw new RouterError("storage_failed", "The remote destination differs from the prepared input.");
            }
            if (attempt === 2)
                throw new FileOmission("copy_failed");
            await delay(250 * 2 ** attempt, signal);
        }
    }
}
async function remoteDownload(route, source, destination, session, signal) {
    const before = await remoteMetadata(route, source, session, signal);
    if (!before)
        throw new FileOmission("unsafe_file");
    const spec = sshProcessSpec(route.agent.sshHost, ["cat", "--", source]);
    const child = spawn(spec.command, spec.args, { stdio: ["ignore", "pipe", "ignore"], signal });
    const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve() : reject(new FileOmission("copy_failed")));
    });
    try {
        await Promise.all([streamToLocal(child.stdout, destination, signal), exited]);
        const after = await remoteMetadata(route, source, session, signal);
        if (before.identity !== after?.identity || (await inspectLocal(destination)).size !== before.size)
            throw new FileOmission("changing_file");
    }
    catch (error) {
        child.kill();
        await exited.catch(() => undefined);
        await rm(destination, { force: true }).catch(() => undefined);
        throw error;
    }
}
async function download(url, destination, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const abort = new AbortController();
        const stop = () => abort.abort();
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted)
            stop();
        let timer = setTimeout(stop, 60000);
        timer.unref();
        let retryable = true;
        try {
            let target = new URL(url);
            let response;
            for (let redirect = 0; redirect <= 5; redirect++) {
                if (target.protocol !== "https:")
                    throw new FileOmission("download_failed");
                response = await fetch(target, { signal: abort.signal, redirect: "manual" });
                if (![301, 302, 303, 307, 308].includes(response.status))
                    break;
                const location = response.headers.get("location");
                await response.body?.cancel();
                if (!location || redirect === 5)
                    throw new FileOmission("download_failed");
                target = new URL(location, target);
            }
            clearTimeout(timer);
            if (!response?.ok || !response.body) {
                retryable = !!response && ([408, 409, 429].includes(response.status) || response.status >= 500);
                await response?.body?.cancel();
                throw new FileOmission("download_failed");
            }
            const reset = () => { clearTimeout(timer); timer = setTimeout(stop, 60000); timer.unref(); };
            reset();
            const activity = new Transform({ transform(chunk, _encoding, callback) { reset(); callback(null, chunk); } });
            const source = Readable.fromWeb(response.body);
            const transfer = pipeline(source, activity, { signal: abort.signal });
            await Promise.all([transfer, streamToLocal(activity, destination, abort.signal)]);
            return;
        }
        catch (error) {
            if (error instanceof RouterError && error.code === "storage_failed")
                throw error;
            if (signal.aborted)
                throw new RouterError("interrupted", "The attachment download stopped.");
            if (!retryable || attempt === 2)
                throw new FileOmission("download_failed");
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", stop);
            abort.abort();
        }
        await delay(250 * 2 ** attempt, signal);
    }
}
function references(state) {
    const local = new Set();
    const host = new Set();
    const publications = new Set();
    for (const route of Object.values(state.routes)) {
        const active = route.active;
        const batches = [...route.queue, ...(route.openBatch ? [route.openBatch] : []), ...(active?.kind === "codex" ? active.batches : [])];
        for (const batch of batches)
            for (const event of batch.events)
                if (event.attachment?.state === "ready") {
                    local.add(event.attachment.localPath);
                    host.add(event.attachment.hostPath);
                }
        if (active?.kind === "codex")
            for (const id of active.publicationIds)
                publications.add(id);
        if (active?.kind === "delivery")
            for (const part of active.parts)
                if (part.payload.kind === "media")
                    local.add(part.payload.localPath);
    }
    return { local, host, publications };
}
export class GatewayFilePlane {
    directory;
    reconciled = new Map();
    root;
    constructor(directory) {
        this.directory = directory;
        this.root = directory;
    }
    spool(kind) { return join(this.root, kind); }
    home(session) {
        const home = session.serverInfo.codexHome;
        if (!home || !isAbsolute(home) || (session.serverInfo.platformFamily !== "unix" && !(process.platform === "win32" && session.serverInfo.platformFamily === "windows")))
            throw new RouterError("codex_unavailable", "The gateway requires an absolute Codex home on a supported host.");
        return join(home, "codex-router-gateway");
    }
    async cleanup(state) {
        await preparePrivateDirectory(this.directory);
        this.root = await realpath(this.directory);
        const keep = references(state).local;
        for (const name of await readdir(this.root)) {
            if (/^state-[a-f0-9-]{36}\.tmp$/.test(name))
                await rm(join(this.root, name), { force: true });
        }
        for (const path of keep)
            if (dirname(path) !== this.spool("inbox") && dirname(path) !== this.spool("outbox"))
                throw new RouterError("state_invalid", "A spool reference is outside gateway storage.");
        if (process.platform === "win32")
            await validateExistingPrivatePaths([this.spool("inbox"), this.spool("outbox"), ...keep]);
        for (const kind of ["inbox", "outbox"]) {
            const directory = this.spool(kind);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await assertPrivatePath(directory, true);
            for (const name of await readdir(directory)) {
                const path = join(directory, name);
                if (!keep.has(path))
                    await rm(path, { recursive: true, force: true });
            }
        }
    }
    reconcile(route, state, session, signal) {
        const key = `${route.agent.sshHost ?? "local"}\0${this.home(session)}`;
        let pending = this.reconciled.get(key);
        if (!pending) {
            pending = this.reconcileHost(route, state, session, signal).catch((error) => {
                if (this.reconciled.get(key) === pending)
                    this.reconciled.delete(key);
                throw error;
            });
            this.reconciled.set(key, pending);
        }
        return pending;
    }
    async directoryOnHost(route, path, session, signal) {
        if (route.agent.sshHost)
            await ssh(route, CHECK_PATH, [path], signal);
        else {
            let parent = path;
            while (true) {
                const stat = await lstat(parent).catch((error) => { if (error.code === "ENOENT")
                    return undefined; throw error; });
                if (stat?.isSymbolicLink())
                    throw new FileOmission("unsafe_file");
                if (parent === dirname(parent))
                    break;
                parent = dirname(parent);
            }
        }
        await session.filesystem("fs/createDirectory", { path, recursive: true });
        if (route.agent.sshHost)
            await ssh(route, CHECK_PATH + 'chmod 700 -- "$1"', [path], signal);
        else if (process.platform !== "win32") {
            const { chmod } = await import("node:fs/promises");
            await chmod(path, 0o700);
        }
        else
            await assertPrivatePath(path, true);
    }
    async reconcileHost(route, state, session, signal) {
        const root = this.home(session);
        const keep = references(state);
        if (!route.agent.sshHost && process.platform === "win32")
            await preparePrivateDirectory(root);
        await this.directoryOnHost(route, root, session, signal);
        if (!route.agent.sshHost && process.platform === "win32")
            await validateExistingPrivatePaths([
                join(root, "inbox"), join(root, "outbox"), ...[...keep.host].filter(path => dirname(path) === join(root, "inbox")),
            ]);
        for (const kind of ["inbox", "outbox"]) {
            const path = join(root, kind);
            await this.directoryOnHost(route, path, session, signal);
            const entries = await session.filesystem("fs/readDirectory", { path });
            for (const entry of entries.entries) {
                if (safeFilename(entry.fileName) !== entry.fileName)
                    throw new FileOmission("unsafe_file");
                const candidate = join(path, entry.fileName);
                if (kind === "inbox" ? !keep.host.has(candidate) : !keep.publications.has(entry.fileName)) {
                    await session.filesystem("fs/remove", { path: candidate, recursive: true, force: true });
                }
            }
        }
    }
    async prepareBatch(route, batch, session, signal) {
        const prepared = structuredClone(batch);
        if (process.platform === "win32") {
            const cached = [];
            for (const event of prepared.events)
                if (event.attachment?.state === "pending") {
                    const id = createHash("sha256").update(JSON.stringify([route.id, batch.id, event.messageHandle])).digest("hex");
                    cached.push(join(this.spool("inbox"), id));
                    if (!route.agent.sshHost)
                        cached.push(join(this.home(session), "inbox", id));
                }
            await validateExistingPrivatePaths(cached);
        }
        for (const event of prepared.events) {
            const attachment = event.attachment;
            if (attachment?.state !== "pending")
                continue;
            const name = safeFilename(attachment.name);
            const id = createHash("sha256").update(JSON.stringify([route.id, batch.id, event.messageHandle])).digest("hex");
            const localPath = join(this.spool("inbox"), id);
            const hostPath = join(this.home(session), "inbox", id);
            let result;
            try {
                if (!await lstat(localPath).catch(() => undefined))
                    await download(attachment.sourceUrl, localPath, signal);
                await inspectLocal(localPath);
                let type;
                try {
                    type = await fileTypeFromFile(localPath);
                }
                catch {
                    throw new FileOmission("invalid_media");
                }
                if (route.agent.sshHost)
                    await remoteUpload(route, localPath, hostPath, session, signal);
                else if (!await lstat(hostPath).catch(() => undefined))
                    await copyLocal(localPath, hostPath, signal);
                else if ((await inspectLocal(hostPath)).size !== (await inspectLocal(localPath)).size)
                    throw new RouterError("storage_failed", "The local input destination differs from the prepared file.");
                const mediaType = type?.mime ?? "application/octet-stream";
                result = { state: "ready", name, mediaType, inputKind: mediaType.startsWith("image/") ? "image" : "file", localPath, hostPath };
            }
            catch (error) {
                if (error instanceof RouterError)
                    throw error;
                const reason = error instanceof FileOmission ? error.reason : "copy_failed";
                result = { state: "omitted", name, reason: reason === "download_failed" || reason === "invalid_media" ? reason : "copy_failed" };
            }
            event.attachment = result;
        }
        return prepared;
    }
    async publication(route, id, session, signal) {
        const path = join(this.home(session), "outbox", component(id));
        await this.directoryOnHost(route, path, session, signal);
        return path;
    }
    async delivery(route, work, outcome, session, connector, signal) {
        const notices = [];
        const media = [];
        const hashes = new Set();
        const collect = async (name, source) => {
            const localPath = join(this.spool("outbox"), randomUUID());
            let retained = false;
            try {
                if ("path" in source) {
                    if (route.agent.sshHost)
                        await remoteDownload(route, source.path, localPath, session, signal);
                    else
                        await copyLocal(source.path, localPath, signal);
                }
                else {
                    const encoded = source.base64;
                    if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
                        throw new FileOmission("invalid_media");
                    async function* decode() { for (let i = 0; i < encoded.length; i += 65536)
                        yield Buffer.from(encoded.slice(i, i + 65536), "base64"); }
                    await streamToLocal(Readable.from(decode()), localPath, signal);
                }
                const hash = await hashFile(localPath, signal);
                if (hashes.has(hash))
                    return;
                hashes.add(hash);
                if ((await inspectLocal(localPath)).size > MAX_SENDBLUE_BYTES) {
                    notices.push(`File omitted: ${JSON.stringify(name)} (connector limit).`);
                    return;
                }
                const type = await fileTypeFromFile(localPath).catch(() => undefined);
                const mediaType = type?.mime ?? "application/octet-stream";
                let mediaUrl;
                try {
                    mediaUrl = await connector.upload(localPath, name, mediaType, signal);
                }
                catch (error) {
                    if (signal.aborted)
                        throw error;
                    notices.push(`File omitted: ${JSON.stringify(name)} (upload failed).`);
                    return;
                }
                media.push({ id: randomUUID(), status: "ready", payload: { kind: "media", localPath, name, mediaType, mediaUrl } });
                retained = true;
            }
            catch (error) {
                if (error instanceof RouterError || signal.aborted)
                    throw error;
                notices.push(`File omitted: ${JSON.stringify(name)} (${error instanceof FileOmission ? error.reason.replaceAll("_", " ") : "copy failed"}).`);
            }
            finally {
                if (!retained)
                    await rm(localPath, { force: true }).catch(() => undefined);
            }
        };
        let text;
        if (outcome.status === "completed") {
            for (const id of work.publicationIds) {
                const path = join(this.home(session), "outbox", component(id));
                let listing;
                try {
                    if (route.agent.sshHost)
                        await ssh(route, CHECK_PATH + 'test -d "$1" || exit 23', [path], signal);
                    else {
                        await assertNoSymlinks(path);
                        if (!(await lstat(path)).isDirectory())
                            throw new FileOmission("unsafe_file");
                    }
                    listing = await session.filesystem("fs/readDirectory", { path });
                    if (!route.agent.sshHost && process.platform === "win32")
                        await validateExistingPrivatePaths([
                            path, ...listing.entries.filter(entry => entry.isFile && safeFilename(entry.fileName) === entry.fileName).map(entry => join(path, entry.fileName)),
                        ]);
                }
                catch (error) {
                    if (signal.aborted)
                        throw error;
                    notices.push("Files omitted: the response directory is unavailable or unsafe.");
                    continue;
                }
                for (const entry of [...listing.entries].sort((a, b) => a.fileName.localeCompare(b.fileName, "en"))) {
                    const name = safeFilename(entry.fileName);
                    if (name !== entry.fileName || !entry.isFile)
                        notices.push(`File omitted: ${JSON.stringify(name)} (unsafe file).`);
                    else
                        await collect(name, { path: join(path, entry.fileName) });
                }
            }
            for (const item of outcome.imageGenerations) {
                if (work.artifactBaseline.includes(item.id))
                    continue;
                if (item.savedPath)
                    await collect(safeFilename(basename(item.savedPath)), { path: item.savedPath });
                else if (item.result)
                    await collect(`image-${safeFilename(item.id)}.png`, { base64: item.result });
            }
            text = outcome.finalText ?? "";
            if (!text && !notices.length && !media.length)
                text = "Codex finished without a response.";
        }
        else
            text = outcome.status === "failed" ? "Codex could not finish this request." : "Codex stopped before finishing this request.";
        if (work.admissionFailed)
            notices.push(ADMISSION_FAILURE);
        text = [text, ...notices].filter(Boolean).join("\n\n");
        const parts = [];
        // Split by Unicode scalar value so a boundary cannot split a surrogate pair.
        let chunk = "";
        for (const point of text) {
            if (chunk.length + point.length > 18995) {
                parts.push({ id: randomUUID(), status: "ready", payload: { kind: "text", text: chunk } });
                chunk = "";
            }
            chunk += point;
        }
        if (chunk)
            parts.push({ id: randomUUID(), status: "ready", payload: { kind: "text", text: chunk } });
        return [...parts, ...media];
    }
    async release(route, active, session) {
        const removeLocal = async (path, recursive = false) => {
            try {
                await lstat(path);
            }
            catch (error) {
                if (error.code === "ENOENT")
                    return;
                throw error;
            }
            await assertNoSymlinks(path);
            await rm(path, { force: true, recursive });
        };
        const removeHost = async (path, recursive = false) => {
            if (!route.agent.sshHost)
                return removeLocal(path, recursive);
            await ssh(route, CHECK_PATH + (recursive ? 'rm -rf -- "$1"' : 'rm -f -- "$1"'), [path], AbortSignal.timeout(15000));
        };
        if (active.kind === "delivery") {
            for (const part of active.parts)
                if (part.payload.kind === "media" && dirname(part.payload.localPath) === this.spool("outbox"))
                    await removeLocal(part.payload.localPath);
            return;
        }
        // Cleanup owns its filesystem operations; the execution session may already
        // be closed after the prepared delivery became durable.
        const home = session ? this.home(session) : undefined;
        for (const batch of active.batches)
            for (const event of batch.events)
                if (event.attachment?.state === "ready") {
                    if (dirname(event.attachment.localPath) === this.spool("inbox"))
                        await removeLocal(event.attachment.localPath);
                    if (home && dirname(event.attachment.hostPath) === join(home, "inbox"))
                        await removeHost(event.attachment.hostPath);
                }
        if (home)
            for (const id of active.publicationIds)
                await removeHost(join(home, "outbox", component(id)), true);
    }
}
//# sourceMappingURL=gateway-files.js.map