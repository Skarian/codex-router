import { preparePrivateDirectory, validateExistingPrivatePaths, assertPrivatePath, noFollowFlag } from "./platform-storage.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import writeFileAtomic from "write-file-atomic";
import * as v from "valibot";
import { unresolved, validateState } from "./gateway-state.js";
import type { ProcessingStatus } from "./gateway.js";
import type { SendbluePollStatus } from "./sendblue-poller.js";

const text = v.pipe(v.string(), v.maxLength(256));
const code = v.pipe(text, v.regex(/^[a-z0-9_]+$/));
const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const ownerSchema = v.strictObject({ pid: v.pipe(time, v.minValue(1)), host: text, token: text });
const effectSchema = v.strictObject({ routeId: text, effectId: text, kind: v.picklist(["codex_admission", "send"]) });
const pollSchema = v.strictObject({ accountId: text, state: v.picklist(["running", "idle", "degraded", "blocked"]), code: v.optional(code), lastSuccessAt: v.optional(time), nextRetryAt: v.optional(time) });
const snapshotSchema = v.strictObject({ owner: ownerSchema, capturedAt: time, ready: v.boolean(),
  polling: v.array(pollSchema), routes: v.array(v.strictObject({ routeId: text, state: v.picklist(["idle", "running", "retrying", "blocked", "unresolved"]), code: v.optional(code) })), unresolved: v.array(effectSchema) });
type Owner = v.InferOutput<typeof ownerSchema>;
type Snapshot = v.InferOutput<typeof snapshotSchema>;
export interface DiagnosticView { ready: boolean; polling: Array<SendbluePollStatus & { accountId: string; lastSuccessAt?: number }>; routes: ProcessingStatus[]; unresolved: ReturnType<typeof unresolved>["unresolved"] }
const MAX_BYTES = 256 * 1024;

const privateDirectory = (path: string) => assertPrivatePath(path, true);
const privateFile = (path: string) => assertPrivatePath(path, false);
async function readJson(path: string, limit = MAX_BYTES): Promise<unknown> {
  await privateFile(path);
  const file = await open(path, constants.O_RDONLY | noFollowFlag);
  try {
    const s = await file.stat();
    if (!s.isFile() || (process.platform !== "win32" && (s.uid !== process.getuid?.() || (s.mode & 0o077))) || s.size > limit) throw new Error("unsafe_file");
    const bytes = Buffer.alloc(Math.min(limit + 1, s.size + 1));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error("oversized_file");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
async function owner(directory: string): Promise<Owner | undefined> {
  try {
    await privateFile(join(directory, "lock"));
    return v.parse(ownerSchema, await readJson(join(directory, "owner.json")));
  } catch (error) { if (missing(error)) return undefined; throw error; }
}
function alive(value: Owner): boolean {
  if (value.host !== hostname()) throw new Error("unknown_host");
  try { process.kill(value.pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function same(a: Owner | undefined, b: Owner | undefined): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** Disposable diagnostics only; never opens, reclaims or changes the canonical writer lock. */
export interface GatewayStatus { unresolved: DiagnosticView["unresolved"]; runtime: { state: "live" | "stale" | "stopped" | "unavailable"; capturedAt?: number; ready?: boolean; polling?: Snapshot["polling"]; routes?: Snapshot["routes"] } }
export async function readGatewayStatus(directory: string, clock: () => number = Date.now): Promise<GatewayStatus> {
  const unavailable: GatewayStatus = { unresolved: [] as ReturnType<typeof unresolved>["unresolved"], runtime: { state: "unavailable" } };
  try {
    await preparePrivateDirectory(directory, false);
    await validateExistingPrivatePaths(["lock", "owner.json"].map(name => join(directory, name)));
    const first = await owner(directory);
    if (first && alive(first)) {
      await validateExistingPrivatePaths([join(directory, "status.json")]);
      const snapshot = v.parse(snapshotSchema, await readJson(join(directory, "status.json")));
      if (!same(first, snapshot.owner) || !same(first, await owner(directory))) return unavailable;
      const now = clock();
      if (snapshot.capturedAt > now || now - snapshot.capturedAt > 15000) return { ...unavailable, runtime: { state: "stale", capturedAt: snapshot.capturedAt } };
      const { owner: _owner, unresolved, ...runtime } = snapshot;
      return { unresolved, runtime: { state: "live", ...runtime } };
    }
    await validateExistingPrivatePaths([join(directory, "state.json")]);
    let effects: ReturnType<typeof unresolved>;
    try { effects = unresolved(validateState(await readJson(join(directory, "state.json"), 64 * 1024 * 1024))); }
    catch (error) { if (!missing(error)) throw error; effects = { unresolved: [] }; }
    if (!same(first, await owner(directory)) || (first && alive(first))) return unavailable;
    return { ...effects, runtime: { state: "stopped" } };
  } catch { return unavailable; }
}

/** At most one write, on a fixed cadence. Message processing never awaits diagnostic I/O. */
export function startDiagnostics(directory: string, view: () => DiagnosticView,
  options: { intervalMs?: number; write?: typeof writeFileAtomic; report?: (failed: boolean) => void } = {}) {
  let closed = false, failed = false;
  const report = (value: boolean) => { try { options.report?.(value); } catch { /* Diagnostics cannot fail message handling. */ } };
  let currentOwner: Owner | undefined;
  let flight: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (flight) return flight;
    flight = (async () => {
      try {
        await privateDirectory(directory);
        currentOwner ??= await owner(directory);
        if (!currentOwner || currentOwner.pid !== process.pid || currentOwner.host !== hostname()) throw new Error("owner_unavailable");
        const path = join(directory, "status.json");
        try { await privateFile(path); } catch (error) { if (!missing(error)) throw error; }
        const snapshot: Snapshot = v.parse(snapshotSchema, { ...view(), owner: currentOwner, capturedAt: Date.now() });
        const data = JSON.stringify(snapshot);
        if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("snapshot_too_large");
        await (options.write ?? writeFileAtomic)(path, data, { mode: 0o600, fsync: false });
        if (failed) { failed = false; report(false); }
      } catch {
        if (!failed) { failed = true; report(true); }
      }
    })().finally(() => { flight = undefined; });
    return flight;
  };
  const timer = setInterval(() => { void refresh(); }, options.intervalMs ?? 5000); timer.unref();
  void refresh();
  return { refresh, close() { closed = true; clearInterval(timer); } };
}
