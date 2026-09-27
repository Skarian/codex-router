import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import writeFileAtomic from "write-file-atomic";
import { assertPrivatePath, validateExistingPrivatePaths, noFollowFlag } from "./platform-storage.js";
import { RouterError } from "./errors.js";
const { tryLock } = createRequire(import.meta.url)("fs-native-extensions");
export const GATEWAY_OWNER_FILE = "owner.json";
/** Local-filesystem exclusion belongs to the kernel, not PID or heartbeat age.
 * Never unlink/replace the sentinel: all processes must lock the same file. */
export async function acquireGatewayLock(directory) {
    const path = join(directory, "lock");
    await validateExistingPrivatePaths([path]);
    try {
        await assertPrivatePath(path, false);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const file = await open(path, constants.O_RDWR | constants.O_CREAT | noFollowFlag, 0o600);
    let acquired = false;
    try {
        await assertPrivatePath(path, false);
        const opened = await file.stat(), named = await lstat(path);
        if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino)
            throw new RouterError("state_invalid", "The gateway lock file changed while opening it.");
        if (!tryLock(file.fd))
            throw new RouterError("gateway_running", "Another gateway process owns this state directory.");
        acquired = true;
        const ownerPath = join(directory, GATEWAY_OWNER_FILE);
        await validateExistingPrivatePaths([ownerPath]);
        try {
            await assertPrivatePath(ownerPath, false);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        await writeFileAtomic(ownerPath, JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() }), { mode: 0o600, fsync: false });
        let closing;
        return () => closing ??= (async () => {
            try {
                await rm(ownerPath, { force: true });
            }
            finally {
                await file.close();
            }
        })();
    }
    catch (error) {
        // Failed metadata publication or canonical-state startup must not strand a lock.
        // The owner file is diagnostic only and may remain after an abrupt failure.
        await file.close();
        if (!acquired && !(error instanceof RouterError))
            throw new RouterError("state_invalid", "The operating-system gateway lock could not be acquired.", { cause: error });
        throw error;
    }
}
//# sourceMappingURL=gateway-lock.js.map