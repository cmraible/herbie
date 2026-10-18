import type { ProjectEvent } from "@herbie/contracts";

type Item = { id: string; type: string; [key: string]: unknown };
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Completed items replace streamed previews; the original records remain in the transcript.
export function agentActivity(events: ProjectEvent[]): Item[] {
  const items = new Map<string, Item>();
  for (const event of events) {
    if (event.type !== "agent") continue;
    let message: unknown;
    try {
      message = JSON.parse(event.message);
    } catch {
      continue;
    }
    if (!object(message) || !object(message.params)) continue;
    const { params, method } = message;
    const key = `${params.threadId}:${params.turnId}:`;
    if (
      object(params.item) &&
      typeof params.item.id === "string" &&
      typeof params.item.type === "string"
    ) {
      items.set(key + params.item.id, { ...params.item } as Item);
    } else if (typeof params.itemId === "string" && typeof params.delta === "string") {
      const id = key + params.itemId;
      const reasoning = typeof method === "string" && method.startsWith("item/reasoning/");
      const output = method === "item/commandExecution/outputDelta";
      const item = items.get(id) ?? {
        id,
        type: reasoning ? "reasoning" : output ? "commandExecution" : "agentMessage",
      };
      if (reasoning) {
        const field = method === "item/reasoning/textDelta" ? "content" : "summary";
        const position = field === "content" ? params.contentIndex : params.summaryIndex;
        const index =
          typeof position === "number" && Number.isSafeInteger(position) && position >= 0
            ? position
            : 0;
        const blocks = Array.isArray(item[field]) ? [...item[field]] : [];
        blocks[index] = String(blocks[index] ?? "") + params.delta;
        item[field] = blocks;
      } else {
        const field = output ? "aggregatedOutput" : "text";
        item[field] = (typeof item[field] === "string" ? item[field] : "") + params.delta;
      }
      items.set(id, item);
    }
  }
  return [...items.entries()].map(([id, item]) => ({ ...item, id }));
}

export function activityText(item: Item): string {
  if (item.type === "agentMessage" || item.type === "plan") return String(item.text ?? "");
  if (item.type === "reasoning") {
    const blocks = [item.summary, item.content].flatMap((value) =>
      Array.isArray(value) ? value : [],
    );
    return blocks.length ? blocks.join("\n\n") : String(item.text ?? "");
  }
  if (item.type === "commandExecution")
    return [
      item.command,
      item.aggregatedOutput,
      item.exitCode == null ? null : `Exit code: ${item.exitCode}`,
    ]
      .filter((value) => value != null)
      .join("\n");
  const { id: _id, type: _type, ...details } = item;
  return JSON.stringify(details, null, 2);
}

// Keep messages, instructions, running work and failures outside collapsed activity groups.
export function groupActivity(items: Item[]): Item[][] {
  const groups: Item[][] = [];
  let pending: Item[] = [];
  for (const item of items) {
    if (
      ["agentMessage", "plan", "userMessage"].includes(item.type) ||
      item.status === "inProgress" ||
      item.status === "failed" ||
      (typeof item.exitCode === "number" && item.exitCode !== 0)
    ) {
      if (pending.length) groups.push(pending);
      groups.push([item]);
      pending = [];
    } else {
      pending.push(item);
    }
  }
  if (pending.length) groups.push(pending);
  return groups;
}
