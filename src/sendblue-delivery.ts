import { randomUUID } from "node:crypto";
import type { Completion, DeliveryPart } from "./gateway-state.js";
import type { SendblueProvider } from "./gateway.js";

/** Upload immutable staged files and format the provider delivery before its first send. */
export async function prepareSendblueDelivery(completion: Completion, connector: Pick<SendblueProvider, "upload">, signal: AbortSignal): Promise<DeliveryPart[]> {
  const notices = [...completion.result.notices];
  const media: DeliveryPart[] = [];
  for (const artifact of completion.artifacts) {
    try {
      const mediaUrl = await connector.upload(artifact.localPath, artifact.name, artifact.mediaType, signal);
      if (mediaUrl.length > 8192 || artifact.name.length > 180 || artifact.mediaType.length > 256) { notices.push("File omitted: invalid media metadata."); continue; }
      media.push({ id: randomUUID(), status: "ready", payload: { kind: "media", localPath: artifact.localPath, name: artifact.name, mediaType: artifact.mediaType, mediaUrl } });
    } catch (error) { if (signal.aborted) throw error; notices.push(`File omitted: ${JSON.stringify(artifact.name)} (upload failed).`); }
  }
  const base = completion.result.text || (media.length ? "" : completion.result.status === "completed" ? "Codex finished without a response." : completion.result.status === "interrupted" ? "Codex stopped before finishing this request." : "Codex could not finish this request.");
  const text = [base, ...notices].filter(Boolean).join("\n\n");
  const parts: DeliveryPart[] = [];
  // Split by Unicode scalar value so a boundary cannot split a surrogate pair.
  let chunk = "";
  for (const point of text) {
    if (chunk.length + point.length > 18995) { parts.push({ id: randomUUID(), status: "ready", payload: { kind: "text", text: chunk } }); chunk = ""; }
    chunk += point;
  }
  if (chunk) parts.push({ id: randomUUID(), status: "ready", payload: { kind: "text", text: chunk } });
  return [...parts, ...media];
}
