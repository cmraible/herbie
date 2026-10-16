import assert from "node:assert/strict";
import test from "node:test";
import { projectSchema, type ProjectEvent } from "@herbie/contracts";
import { groupAttempts } from "../src/attempts.js";
const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const project = projectSchema.parse({
  id: first,
  ownerId: "fixture",
  repository: "demo/example",
  name: "Project",
  prompt: "Project",
  mode: "demo",
  state: "awaiting_review",
  attemptCount: 2,
  createdAt: "2026-10-15",
  updatedAt: "2026-10-15",
  stopRequested: null,
  pullRequest: null,
  error: null,
  attempts: [first, second].map((id, i) => ({
    id,
    number: i + 1,
    state: "awaiting_review",
    createdAt: "2026-10-15",
    pullRequest: null,
  })),
});
function event(
  id: number,
  type: string,
  message: string,
  attemptId: string | null = null,
): ProjectEvent {
  return { id, projectId: project.id, type, message, attemptId, createdAt: "2026-10-15" };
}
test("explicit attribution keeps late events with the older attempt and retains project history", () => {
  const events = [
    event(1, "attempt", "First", first),
    event(2, "attempt", "Second", second),
    event(3, "pull_request_merged", "Merged", first),
    event(4, "renamed", "Project renamed"),
  ];
  const result = groupAttempts(project, events);
  assert.deepEqual(
    result.attempts.map((a) => a.number),
    [2, 1],
  );
  assert.deepEqual(
    result.attempts[1]!.events.map((e) => e.id),
    [1, 3],
  );
  assert.deepEqual(
    result.history.map((e) => e.id),
    [4],
  );
});
test("execution events follow numbered run starts; ambiguous PR events stay in history", () => {
  const events = [
    event(1, "attempt_started", "Run #1 started"),
    event(2, "attempt", "First"),
    event(3, "attempt_started", "Run #2 started"),
    event(4, "attempt", "Second"),
    event(5, "pull_request_merged", "Pull request merged"),
  ];
  const result = groupAttempts(project, events);
  assert.deepEqual(
    result.attempts[0]!.events.map((e) => e.id),
    [3, 4],
  );
  assert.deepEqual(
    result.attempts[1]!.events.map((e) => e.id),
    [1, 2],
  );
  assert.deepEqual(
    result.history.map((e) => e.id),
    [5],
  );
});
