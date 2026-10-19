import test from "node:test";
import assert from "node:assert/strict";
import { projectSchema } from "@herbie/contracts";
import { focusQueue } from "../src/focus-queue.js";

const legacyProject = projectSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  ownerId: "owner",
  repository: "example/repo",
  name: "Legacy project",
  prompt: "Review the change",
  mode: "live",
  state: "awaiting_review",
  attemptCount: 1,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  stopRequested: null,
  error: null,
  pullRequest: {
    number: 42,
    branch: "change",
    title: "Reviewable change",
    state: "open",
    url: "https://github.com/example/repo/pull/42",
    draft: false,
    checksPassed: true,
  },
  attempts: undefined,
});

test("focus queue includes review-ready project-level PRs when attempts are unavailable", () => {
  const queue = focusQueue([legacyProject], "owner");

  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.id, `${legacyProject.id}/pr/42`);
  assert.equal(queue[0]?.project, legacyProject);
  assert.equal(queue[0]?.attempt, undefined);
  assert.equal(queue[0]?.attention, false);
});
