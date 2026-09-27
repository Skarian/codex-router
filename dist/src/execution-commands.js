import { randomUUID } from "node:crypto";
import { RouterError } from "./errors.js";
import { openExecutionSession } from "./execution-session.js";
import { acceptedTurnId, textResult } from "./turn-state.js";
/** Commands use the same owner discovery as gateway turns, without gateway state. */
export async function sendTurn(agent, text, emit, signal = new AbortController().signal, open = openExecutionSession) {
    if (signal.aborted)
        throw new RouterError("interrupted", "The Codex turn was interrupted by the caller.");
    const session = await open(agent, signal);
    try {
        const resumed = await session.resume();
        const turnId = await session.admit([{ type: "text", text, text_elements: [] }], {
            clientUserMessageId: randomUUID(),
            ...(resumed.activeTurn ? { expectedTurnId: acceptedTurnId(resumed.activeTurn, "thread/resume") } : {}),
        });
        return { result: textResult(await session.observe(turnId, emit)), transportKind: session.backend ?? "stdio" };
    }
    finally {
        await session.close();
    }
}
export async function cancelTurn(agent, open = openExecutionSession) {
    const session = await open(agent, new AbortController().signal);
    try {
        const resumed = await session.resume();
        if (!resumed.activeTurn)
            return { type: "already_idle", agent: agent.id };
        const turnId = acceptedTurnId(resumed.activeTurn, "thread/resume");
        if (!session.interrupt)
            throw new RouterError("thread_unavailable", "This connection cannot interrupt the active turn.");
        await session.interrupt(turnId);
        return { type: "interrupt_requested", agent: agent.id, turn_id: turnId };
    }
    finally {
        await session.close().catch(() => undefined);
    }
}
//# sourceMappingURL=execution-commands.js.map