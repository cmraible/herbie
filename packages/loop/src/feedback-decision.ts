export type FeedbackDecision =
  | { action: "ignore"; reason: string }
  | { action: "reply" | "update"; reply: string };

export function parseFeedbackDecision(value: unknown): FeedbackDecision {
  if (typeof value !== "object" || value === null || !("action" in value))
    throw new Error("Missing PR feedback decision");
  if (
    value.action === "ignore" &&
    "reason" in value &&
    typeof value.reason === "string" &&
    value.reason.trim() &&
    value.reason.length <= 60000
  )
    return { action: "ignore", reason: value.reason.trim() };
  if (
    (value.action === "reply" || value.action === "update") &&
    "reply" in value &&
    typeof value.reply === "string" &&
    value.reply.trim() &&
    value.reply.length <= 60000
  )
    return { action: value.action, reply: value.reply.trim() };
  throw new Error("Invalid PR feedback decision");
}
