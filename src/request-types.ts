export interface SourcePolicy {
  batching: "immediate" | { quietMs: number; maximumMs: number };
  duplicateBehavior: "first" | "exact";
}

export interface NormalizedInput {
  text: string;
  attachment?: { sourceUrl: string; name: string };
}

/** Source IDs are scoped to their execution target; credentials never enter input. */
export interface Submission {
  sourceId: string;
  externalId: string;
  payloadHash?: string;
  input: NormalizedInput;
  providerTimeMs?: number;
}
