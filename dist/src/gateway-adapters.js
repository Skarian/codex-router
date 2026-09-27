import { randomUUID } from "node:crypto";
import { routeSources } from "./config.js";
/** Static composition: provider-specific behavior stops at this boundary. */
export function sourceAdapters(config, route, files, connector) {
    return routeSources(route).map(binding => {
        if (binding.kind === "https")
            return {
                binding, policy: { batching: "immediate", retainTerminalResult: true, duplicateBehavior: "exact" },
                async prepare(batch) { return batch; },
                async instructions() { return {}; },
                async complete(_work, outcome) {
                    return { kind: "retain", result: { status: outcome.status, text: outcome.finalText ?? "",
                            notices: outcome.imageGenerations.length ? ["attachments_omitted"] : [] } };
                },
            };
        const provider = connector(binding.accountId);
        return {
            binding, policy: { batching: { quietMs: config.sendblue.find(account => account.id === binding.accountId)?.batchQuietMs ?? 5000, maximumMs: 30000 }, retainTerminalResult: false, duplicateBehavior: "first" },
            prepare: (batch, session, signal) => files.prepareBatch(route, batch, session, signal),
            async instructions(session, signal) {
                const publicationId = randomUUID();
                const directory = await files.publication(route, publicationId, session, signal);
                const instructions = provider.agentInstructions?.(directory);
                return { publicationId, ...(instructions === undefined ? {} : { instructions }) };
            },
            async complete(work, outcome, session, signal) {
                const parts = work.admissionFailed && !work.turnId
                    ? [{ id: randomUUID(), status: "ready", payload: { kind: "text", text: "Codex did not confirm the latest input. It was not sent again." } }]
                    : await files.delivery(route, work, outcome, session, provider, signal);
                return { kind: "deliver", parts, result: { status: outcome.status, text: outcome.finalText ?? "", notices: [] } };
            },
            typing: (active, signal) => provider.typing(route, active ? "start" : "stop", signal),
            readReceipt: async (signal) => { await provider.readReceipt?.(route, signal); },
            outbound: {
                line: binding.sendblueNumber, maxPerSecond: 10,
                callbackUrl: (partId, token) => config.sendblue.find(account => account.id === binding.accountId)?.mode === "webhook"
                    ? `${config.publicUrl}/callbacks/sendblue/${binding.accountId}/${partId}/${token}` : undefined,
                send: (part, callbackUrl, signal) => provider.send(route, part, callbackUrl, signal),
            },
        };
    });
}
export function matchIncoming(config, accountId, message) {
    for (const route of config.routes) {
        const binding = routeSources(route).find(b => b.kind === "sendblue" && b.accountId === accountId && b.sender === message.sender && b.sendblueNumber === message.sendblueNumber);
        if (binding)
            return { route, sourceId: binding.id };
    }
    return undefined;
}
//# sourceMappingURL=gateway-adapters.js.map