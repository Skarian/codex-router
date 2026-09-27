import { DesktopSession } from "./desktop-session.js";
import { RouterError } from "./errors.js";
import { TurnSession } from "./turn-session.js";
export function executionBinding(agent, session) {
    const codexHome = session.serverInfo.codexHome;
    if (!codexHome)
        throw new RouterError("app_server_protocol_failed", "The execution host did not identify its Codex home.");
    return { backend: session.backend ?? "stdio", host: agent.sshHost ?? "local", codexHome, threadId: agent.threadId };
}
export function verifyExecutionBinding(expected, actual) {
    if (expected.host !== actual.host || expected.codexHome !== actual.codexHome || expected.threadId !== actual.threadId) {
        throw new RouterError("state_invalid", "The recovered session does not match the stored execution target.");
    }
    // Desktop recovery needs its persisted input boundary. Do not downgrade it to
    // the direct adapter, whose recovery contract does not implement that boundary.
    if (expected.backend === "desktop" && actual.backend !== "desktop") {
        throw new RouterError("thread_busy", "Waiting for the Desktop owner to recover admitted work.");
    }
}
const discovery = {
    desktop: (agent, signal) => DesktopSession.discover(agent, signal),
    direct: (agent, signal) => TurnSession.open(agent, undefined, signal),
};
export async function openExecutionSession(agent, signal, binding, operations = discovery) {
    if (!agent.sshHost) {
        const desktop = await operations.desktop(agent, signal);
        if (desktop)
            return desktop;
        if (binding?.backend === "desktop")
            throw new RouterError("thread_busy", "Waiting for the Desktop owner to recover admitted work.");
    }
    return operations.direct(agent, signal);
}
//# sourceMappingURL=execution-session.js.map