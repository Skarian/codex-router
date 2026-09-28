import { randomUUID } from "node:crypto";
import type { GatewayConfig, SendblueConfig, SendblueConversation } from "./config.js";
import type { SendblueProvider, GatewayFiles, IncomingMessage } from "./gateway.js";
import type { GatewayState, SourceBinding, RouteBinding, Destination } from "./gateway-state.js";
import type { RequestAdapter, RuntimeTarget } from "./request-runtime.js";
import { prepareSendblueDelivery } from "./sendblue-delivery.js";
import { RouterError } from "./errors.js";

export function sendblueBinding(account: SendblueConfig, conversation: SendblueConversation): SourceBinding {
  const namespace = JSON.stringify(["sendblue", account.id]);
  return { id: conversation.id, namespace, destination: { id: conversation.id, namespace,
    properties: { accountId: account.id, sender: conversation.sender, sendblueNumber: conversation.sendblueNumber } } };
}

export function runtimeBindings(config: GatewayConfig): Array<{ id: string; binding: RouteBinding }> {
  return config.agents.map(agent => ({ id: agent.id, binding: {
    target: { sshHost: agent.sshHost ?? null, threadId: agent.threadId, cwd: agent.cwd },
    sources: [ ...(config.http?.api ? [{ id: "http", namespace: "http" }] : []),
      ...config.sendblue.flatMap(account => account.conversations.filter(conversation => conversation.agent.id === agent.id)
        .map(conversation => sendblueBinding(account, conversation))) ],
  } }));
}

export function outboundTransport(config: GatewayConfig, connector: (id: string) => SendblueProvider,
  destination: Destination): NonNullable<RequestAdapter["outbound"]> {
  const account = config.sendblue.find(account => account.id === destination.properties.accountId);
  if (!account || destination.namespace !== JSON.stringify(["sendblue", account.id])
    || !destination.properties.sender || !destination.properties.sendblueNumber) {
    throw new RouterError("config_invalid", "The delivery account is unavailable.");
  }
  const provider = connector(account.id);
  return {
    callbackNamespace: account.id, line: destination.properties.sendblueNumber, maxPerSecond: 10,
    prepare: (completion, _destination, signal) => prepareSendblueDelivery(completion, provider, signal),
    callbackUrl: (partId, token) => account.mode === "webhook"
      ? `${account.publicUrl}/callbacks/sendblue/${account.id}/${partId}/${token}` : undefined,
    send: (part, callbackUrl, signal, savedDestination) => provider.send({
      sender: savedDestination.properties.sender!, sendblueNumber: savedDestination.properties.sendblueNumber!,
    }, part, callbackUrl, signal),
  };
}

export function runtimeTargets(config: GatewayConfig, files: GatewayFiles, connector: (id: string) => SendblueProvider): RuntimeTarget[] {
  return runtimeBindings(config).map(({ id, binding }) => {
    const agent = config.agents.find(agent => agent.id === id)!;
    const target: RuntimeTarget = { id, agent, binding, adapters: [] };
    target.adapters = binding.sources.map(source => {
      if (!source.destination) return {
        binding: source, policy: { batching: "immediate", duplicateBehavior: "exact" },
        async prepare(batch) { return batch; }, async instructions() { return {}; },
      } satisfies RequestAdapter;
      const destination = source.destination;
      const account = config.sendblue.find(account => account.id === destination.properties.accountId)!;
      const conversation = account.conversations.find(conversation => conversation.id === destination.id)!;
      const provider = connector(account.id);
      return {
        binding: source,
        policy: { batching: { quietMs: account.batchQuietMs ?? 5000, maximumMs: 30000 }, duplicateBehavior: "first" },
        prepare: (batch, session, signal) => files.prepareBatch(target, batch, session, signal),
        async instructions(session, signal) {
          const publicationId = randomUUID();
          const directory = await files.publication(target, publicationId, session, signal);
          const instructions = provider.agentInstructions?.(directory);
          return { publicationId, ...(instructions === undefined ? {} : { instructions }) };
        },
        typing: (active, signal) => provider.typing(conversation, active ? "start" : "stop", signal),
        readReceipt: signal => provider.readReceipt?.(conversation, signal) ?? Promise.resolve(),
        outbound: outboundTransport(config, connector, destination),
      } satisfies RequestAdapter;
    });
    return target;
  });
}

export function matchIncoming(config: GatewayConfig, accountId: string, message: IncomingMessage): { agentId: string; sourceId: string } | undefined {
  const account = config.sendblue.find(account => account.id === accountId);
  const conversation = account?.conversations.find(conversation => conversation.sender === message.sender && conversation.sendblueNumber === message.sendblueNumber);
  return conversation ? { agentId: conversation.agent.id, sourceId: conversation.id } : undefined;
}

/** Persist activation before network intake; never reset existing checkpoints. */
export function initializePolling(state: GatewayState, config: GatewayConfig, now: number): void {
  const polling = state.polling ??= {};
  for (const account of config.sendblue) {
    if (account.mode === "webhook") continue;
    const initial = account.pollStart === undefined ? now : Date.parse(account.pollStart);
    if (!Number.isSafeInteger(initial) || initial < 0 || initial > now) throw new RouterError("config_invalid", "Polling start must not be in the future.");
    const existing = polling[account.id];
    const poll = polling[account.id] ??= { activationAtMs: initial, completedThroughMs: initial, routeActivationAtMs: {} };
    for (const conversation of account.conversations) poll.routeActivationAtMs[conversation.id] ??= existing ? now : initial;
  }
}
