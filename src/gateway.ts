import type { GatewayConfig, SendblueConversation } from "./config.js";
import type { GatewayStore, Batch, CodexWork, StagedArtifact, DeliveryPart, GatewayState, StagedCompletion } from "./gateway-state.js";
import { matchIncoming, runtimeTargets, outboundTransport } from "./gateway-adapters.js";
import { RequestRuntime, type RuntimeTarget, type SendOutcome } from "./request-runtime.js";
import type { ExecutionSession } from "./execution-session.js";
import type { TurnOutcome } from "./turn-state.js";
export { delay, secretEqual, SubmissionFailure } from "./request-runtime.js";
export type { SendOutcome, ProcessingStatus } from "./request-runtime.js";

export type SendblueRecipient = Pick<SendblueConversation, "sender" | "sendblueNumber">;

export interface IncomingMessage {
  messageHandle: string;
  sender: string;
  sendblueNumber: string;
  providerTimeMs: number;
  text: string;
  attachment?: { sourceUrl: string; name: string };
}
export interface StatusCallback { status: string; providerHandle?: string }
export interface SendblueProvider {
  readonly signingSecret: string;
  agentInstructions?(outputDirectory: string): string;
  readReceipt?(route: SendblueRecipient, signal: AbortSignal): Promise<void>;
  inbound(value: unknown): IncomingMessage | undefined;
  callback(value: unknown): StatusCallback;
  send(route: SendblueRecipient, part: DeliveryPart, callbackUrl: string | undefined, signal: AbortSignal): Promise<SendOutcome>;
  upload(path: string, name: string, mediaType: string, signal: AbortSignal): Promise<string>;
  typing(route: SendblueRecipient, state: "start" | "stop", signal: AbortSignal): Promise<void>;
}
export type GatewaySession = ExecutionSession;
export interface GatewayFiles {
  cleanup(state: GatewayState): Promise<void>;
  release?(target: RuntimeTarget, active: CodexWork | readonly StagedArtifact[], session?: GatewaySession): Promise<void>;
  reconcile(target: RuntimeTarget, state: GatewayState, session: GatewaySession, signal: AbortSignal): Promise<void>;
  prepareBatch(target: RuntimeTarget, batch: Batch, session: GatewaySession, signal: AbortSignal): Promise<Batch>;
  publication(target: RuntimeTarget, publicationId: string, session: GatewaySession, signal: AbortSignal): Promise<string>;
  stage(target: RuntimeTarget, work: CodexWork, outcome: TurnOutcome, session: GatewaySession, signal: AbortSignal): Promise<StagedCompletion>;
}
export interface GatewayOperations {
  connector(id: string): SendblueProvider;
  files: GatewayFiles;
  openSession?(route: RuntimeTarget, signal: AbortSignal): Promise<GatewaySession>;
  now?(): number;
  retryDelayMs?(attempt: number): number;
}

/** Static connector composition. Durable work belongs to RequestRuntime. */
export class Gateway extends RequestRuntime {
  constructor(readonly config: GatewayConfig, store: GatewayStore, readonly operations: GatewayOperations) {
    super({ targets: runtimeTargets(config, operations.files, operations.connector),
      ...(config.maxRequests === undefined ? {} : { maxRequests: config.maxRequests }),
      ...(config.retainedBytes === undefined ? {} : { retainedBytes: config.retainedBytes }) }, store, {
      cleanup: state => operations.files.cleanup(state),
      outbound: destination => outboundTransport(config, operations.connector, destination),
      reconcile: (target, state, session, signal) => operations.files.reconcile(target, state, session, signal),
      release: (target, work, session) => operations.files.release?.(target, work, session) ?? Promise.resolve(),
      stage: (target, work, outcome, session, signal) => operations.files.stage(target, work, outcome, session, signal),
      ...(operations.openSession ? { openSession: operations.openSession } : {}),
      ...(operations.now ? { now: operations.now } : {}),
      ...(operations.retryDelayMs ? { retryDelayMs: operations.retryDelayMs } : {}),
    });
  }
  async receive(accountId: string, message: IncomingMessage): Promise<void> {
    const match = matchIncoming(this.config, accountId, message);
    if (!match) return;
    await this.submit(match.agentId, { sourceId: match.sourceId, externalId: message.messageHandle,
      input: { text: message.text, ...(message.attachment ? { attachment: message.attachment } : {}) }, providerTimeMs: message.providerTimeMs });
  }
  async callback(account: string, partId: string, token: string, callback: StatusCallback): Promise<boolean> {
    return super.callback(account, partId, token, {
      status: ["REGISTERED", "PENDING", "QUEUED", "ACCEPTED", "SENT", "DELIVERED"].includes(callback.status) ? "accepted"
        : ["DECLINED", "ERROR"].includes(callback.status) ? "failed" : "pending",
      ...(callback.providerHandle === undefined ? {} : { providerHandle: callback.providerHandle }),
    });
  }
}
