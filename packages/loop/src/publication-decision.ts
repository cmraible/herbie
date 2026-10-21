export type PublicationDecision = { action: "pause"; reason: string };

export function parsePublicationDecision(value: unknown): PublicationDecision {
  if (
    typeof value === "object" &&
    value !== null &&
    "action" in value &&
    value.action === "pause" &&
    "reason" in value &&
    typeof value.reason === "string" &&
    value.reason.trim() &&
    value.reason.length <= 2000
  )
    return { action: "pause", reason: value.reason.trim() };
  throw new Error("Invalid publication decision");
}
