import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoalEvent } from "@herbie/contracts";
import { agentActivity, activityText } from "../src/agent-activity.js";

function event(method: string, params: Record<string, unknown>): GoalEvent {
  return {
    id: 1,
    goalId: "goal",
    type: "agent",
    createdAt: "now",
    message: JSON.stringify({ method, params: { threadId: "thread", turnId: "turn", ...params } }),
  };
}

test("assembles messages, thinking and tool output, then replaces previews with final items", () => {
  const records = [
    event("item/started", { item: { id: "a", type: "agentMessage", text: "" } }),
    event("item/agentMessage/delta", { itemId: "a", delta: "Hello " }),
    event("item/agentMessage/delta", { itemId: "a", delta: "world" }),
    event("item/started", { item: { id: "r", type: "reasoning", summary: [""], content: [] } }),
    event("item/reasoning/summaryTextDelta", { itemId: "r", delta: "Checking tests" }),
    event("item/started", {
      item: { id: "c", type: "commandExecution", command: "pnpm test", status: "inProgress" },
    }),
    event("item/commandExecution/outputDelta", { itemId: "c", delta: "passed" }),
  ];
  assert.deepEqual(agentActivity(records).map(activityText), [
    "Hello world",
    "Checking tests",
    "pnpm test\npassed",
  ]);
  records.push(
    event("item/completed", { item: { id: "a", type: "agentMessage", text: "Final response" } }),
  );
  records.push(
    event("item/completed", {
      item: {
        id: "c",
        type: "commandExecution",
        command: "pnpm test",
        aggregatedOutput: "passed",
        exitCode: 0,
      },
    }),
  );
  assert.deepEqual(agentActivity(records).map(activityText), [
    "Final response",
    "Checking tests",
    "pnpm test\npassed\nExit code: 0",
  ]);
});

test("keeps repair turns separate and retains unknown tool details", () => {
  const records = [
    event("item/completed", {
      item: {
        id: "tool",
        type: "mcpToolCall",
        arguments: { query: "test" },
        result: { text: "x".repeat(5000) },
      },
    }),
  ];
  records.push(
    event("item/completed", {
      turnId: "repair",
      item: { id: "tool", type: "agentMessage", text: "Fixed" },
    }),
  );
  assert.equal(agentActivity(records).length, 2);
  assert.ok(activityText(agentActivity(records)[0]!).includes("x".repeat(5000)));
});
