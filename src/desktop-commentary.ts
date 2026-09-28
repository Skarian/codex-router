import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { toNamespacedPath } from "node:path";

const MAX_SCAN = 8 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
const MAX_ITEMS = 4096;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** Read-only completion evidence. Snapshot order, never file order, establishes input attribution. */
export class DesktopCommentary {
  status: { state: "available" | "unavailable"; reason?: string } = { state: "unavailable", reason: "not_observed" };
  private identity?: string;
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private readonly completed = new Map<string, string>();
  private readonly emitted = new Set<string>();
  constructor(private readonly threadId: string) {}
  async poll(path: string, turnId: string, eligible: readonly Record<string, any>[]): Promise<Array<{ itemId: string; text: string }>> {
    try {
      const canonical = await realpath(path);
      if (toNamespacedPath(canonical) !== toNamespacedPath(path)) throw new Error("rollout_path_changed");
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe_rollout");
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino
          || (process.platform !== "win32" && stat.uid !== process.getuid?.())) throw new Error("unsafe_rollout");
        const identity = `${stat.dev}:${stat.ino}`;
        if (identity !== this.identity || stat.size < this.offset) {
          this.completed.clear(); this.pending = Buffer.alloc(0);
          const header = Buffer.alloc(65536); const first = await file.read(header, 0, header.length, 0);
          const newline = header.subarray(0, first.bytesRead).indexOf(10);
          if (newline < 0) throw new Error("missing_session_metadata");
          const meta = JSON.parse(header.subarray(0, newline).toString("utf8"));
          if (meta.type !== "session_meta" || meta.payload?.id !== this.threadId) throw new Error("rollout_identity_mismatch");
          if (meta.payload?.history_mode !== "paginated") throw new Error("unsupported_history_mode");
          // Recovery can omit older progress; it must never scan an unbounded transcript.
          this.offset = Math.max(0, stat.size - MAX_SCAN);
          if (this.offset) {
            const chunk = Buffer.alloc(MAX_LINE); const part = await file.read(chunk, 0, chunk.length, this.offset);
            const end = chunk.subarray(0, part.bytesRead).indexOf(10);
            if (end < 0) throw new Error("rollout_record_too_large");
            this.offset += end + 1;
          }
          this.identity = identity;
        }
        if (stat.size - this.offset > MAX_SCAN) throw new Error("rollout_reader_lagged");
        const chunk = Buffer.alloc(Math.min(MAX_SCAN, stat.size - this.offset));
        const read = await file.read(chunk, 0, chunk.length, this.offset); this.offset += read.bytesRead;
        const bytes = Buffer.concat([this.pending, chunk.subarray(0, read.bytesRead)]);
        let start = 0;
        for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
          if (end - start > MAX_LINE) throw new Error("rollout_record_too_large");
          const line = bytes.subarray(start, end); start = end + 1;
          if (!line.length) continue;
          const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
          const p = row.payload, item = p?.item;
          if (row.type !== "event_msg" || p?.type !== "item_completed" || p.thread_id !== this.threadId || p.turn_id !== turnId
            || item?.type !== "AgentMessage" || item.phase !== "commentary" || typeof item.id !== "string" || !Array.isArray(item.content)) continue;
          if (!item.content.every((part: any) => part.type === "Text" && typeof part.text === "string")) continue;
          const text = item.content.map((part: any) => part.text).join("");
          if (Buffer.byteLength(text) > 256 * 1024) throw new Error("commentary_too_large");
          const key = `${turnId}\0${item.id}`, hash = digest(text);
          if (this.completed.has(key) && this.completed.get(key) !== hash) throw new Error("conflicting_completion");
          this.completed.set(key, hash);
          if (this.completed.size > MAX_ITEMS) throw new Error("commentary_item_limit");
        }
        this.pending = Buffer.from(bytes.subarray(start));
        if (this.pending.length > MAX_LINE) throw new Error("rollout_record_too_large");
      } finally { await file.close(); }
      const messages = [];
      for (const item of eligible) {
        if (item.type !== "agentMessage" || item.phase !== "commentary" || typeof item.id !== "string" || typeof item.text !== "string") continue;
        const key = `${turnId}\0${item.id}`;
        if (this.emitted.has(key) || this.completed.get(key) !== digest(item.text)) continue;
        if (this.emitted.size >= MAX_ITEMS) throw new Error("commentary_item_limit");
        this.emitted.add(key); messages.push({ itemId: item.id, text: item.text });
      }
      this.status = { state: "available" }; return messages;
    } catch (error) {
      this.status = { state: "unavailable", reason: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "rollout_read_failed" };
      return [];
    }
  }
}
