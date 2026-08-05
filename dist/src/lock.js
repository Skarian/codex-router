import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { RouterError } from "./errors.js";
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== "ESRCH";
    }
}
export async function acquireAgentLock(configPath, agentId) {
    const lockRoot = join(homedir(), ".codex-router", "locks");
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const digest = createHash("sha256").update(`${configPath}\0${agentId}`).digest("hex");
    const lockPath = join(lockRoot, `${digest}.lock`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const handle = await open(lockPath, "wx", 0o600);
            await handle.writeFile(`${process.pid}\n`, "utf8");
            await handle.close();
            let released = false;
            return {
                async release() {
                    if (released)
                        return;
                    released = true;
                    await unlink(lockPath).catch(() => undefined);
                },
            };
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const owner = Number.parseInt((await readFile(lockPath, "utf8").catch(() => "")).trim(), 10);
            if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) {
                throw new RouterError("agent_busy", `${agentId} is already working. Try again after the current turn finishes.`);
            }
            await unlink(lockPath).catch(() => undefined);
        }
    }
    throw new RouterError("agent_busy", `${agentId} is already working. Try again after the current turn finishes.`);
}
//# sourceMappingURL=lock.js.map