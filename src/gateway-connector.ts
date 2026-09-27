import type { DeliveryPart } from "./gateway-state.js";

export interface SourcePolicy {
  batching: "immediate" | { quietMs: number; maximumMs: number };
  duplicateBehavior: "first" | "exact";
  retainTerminalResult: boolean;
}

export interface NormalizedInput {
  text: string;
  attachment?: { sourceUrl: string; name: string };
}

/** Source IDs are scoped to their configured route; credentials never enter input. */
export interface Submission {
  sourceId: string;
  externalId: string;
  payloadHash?: string;
  input: NormalizedInput;
  providerTimeMs?: number;
}

export interface TerminalResult {
  status: "completed" | "failed" | "interrupted";
  text: string;
  notices: string[];
}

/** Both plans commit through the gateway's canonical state writer. */
export type CompletionPlan =
  | { kind: "retain"; result: TerminalResult }
  | { kind: "deliver"; result: TerminalResult; parts: DeliveryPart[] };
