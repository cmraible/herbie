import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectSchema, type ProjectEvent } from "@herbie/contracts";
import { AttemptHistory } from "../src/AttemptHistory.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("run details separate session transcripts and retain historical activity", () => {
  const project = projectSchema.parse({
    id: id(1),
    ownerId: "test",
    repository: "test/repo",
    name: "Test",
    prompt: "Test",
    state: "awaiting_review",
    mode: "demo",
    attemptCount: 1,
    createdAt: "now",
    updatedAt: "now",
    stopRequested: null,
    cleanupStatus: "complete",
    error: null,
    pullRequest: null,
    attempts: [
      {
        id: id(2),
        number: 1,
        state: "awaiting_review",
        createdAt: "now",
        pullRequest: null,
        sessions: ["implementation", "pr_feedback"].map((kind, i) => ({
          id: id(i + 3),
          kind,
          state: "completed",
          model: "test-model",
          reasoningEffort: "low",
          startedAt: "now",
          finishedAt: "later",
          cleanup: "confirmed",
          environment: { provider: i ? "e2b" : "daytona", id: `env-${i}` },
          usage: null,
          threadId: null,
        })),
      },
    ],
  });
  const events: ProjectEvent[] = [
    "Initial implementation",
    "Feedback response",
    "Historical transcript",
  ].map((text, i) => ({
    id: i + 1,
    projectId: id(1),
    attemptId: id(2),
    agentSessionId: i < 2 ? id(i + 3) : null,
    createdAt: "now",
    type: "agent",
    message: JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { id: "same-item", type: "agentMessage", text },
      },
    }),
  }));
  const html = renderToStaticMarkup(
    createElement(AttemptHistory, {
      project,
      selected: id(2),
      events,
      eventsState: "ready",
      eventsError: null,
      time: (value) => value,
    }),
  );
  for (const text of [
    "Initial implementation",
    "Feedback response",
    "Historical transcript",
    "Session 1",
    "Session 2",
    "daytona",
    "e2b",
  ])
    assert.ok(html.includes(text), text);
  assert.equal(html.split("Initial implementation").length, 2);
});
