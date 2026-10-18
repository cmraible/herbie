import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectEvent } from "@herbie/contracts";
import { agentActivity, activityText, groupActivity } from "../src/agent-activity.js";

function event(method: string, params: Record<string, unknown>): ProjectEvent {
  return {
    id: 1,
    projectId: "project",
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

test("groups background activity without burying messages, running commands or failures", () => {
  const items = [
    { id: "1", type: "reasoning" },
    { id: "2", type: "commandExecution", status: "completed" },
    { id: "3", type: "agentMessage" },
    { id: "4", type: "commandExecution", status: "inProgress" },
    { id: "5", type: "commandExecution", status: "failed" },
    { id: "6", type: "commandExecution", exitCode: 1 },
    { id: "7", type: "plan" },
    { id: "8", type: "userMessage" },
    { id: "9", type: "reasoning" },
    { id: "10", type: "mcpToolCall", status: "completed" },
  ];
  assert.deepEqual(
    groupActivity(items).map((group) => group.map((item) => item.id)),
    [["1", "2"], ["3"], ["4"], ["5"], ["6"], ["7"], ["8"], ["9", "10"]],
  );
  assert.deepEqual(groupActivity([]), []);
});
