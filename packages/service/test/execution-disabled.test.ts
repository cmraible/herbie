import assert from "node:assert/strict";
import test from "node:test";
import { createLiveAdapters } from "../src/live.js";
import { createGithub } from "../src/github.js";
import type { Execution } from "../src/adapters.js";

test("live adapters without approved execution configuration cannot start an attempt or publication", async () => {
  const github = createGithub({
    appId: "fixture",
    clientId: "fixture",
    clientSecret: "fixture",
    privateKey: "fixture",
    callbackUrl: "https://herbie.example/api/auth/callback",
    webhookSecret: "fixture",
  });
  const adapters = createLiveAdapters(undefined, github, {
    userToken: async () => {
      throw new Error("Execution must stop before reading user credentials");
    },
  });
  const execution: Execution = {
    project: {
      id: "id",
      ownerId: "user",
      repository: "demo/example",
      name: "Disabled work",
      prompt: "Disabled work",
      attemptCount: 0,
      maxWip: 1,
      model: "gpt-6-luna",
      pullRequests: [],
      state: "queued",
      cleanupStatus: "not_required",
      stopRequested: null,
      mode: "live",
      pullRequest: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    repository: { repository: "demo/example", installationId: 1, defaultBranch: "main" },
    attemptId: "id",
    branch: "herbie/attempt",
  };
  await assert.rejects(
    adapters.attempt(execution, async () => undefined),
    /execution is disabled/,
  );
  await assert.rejects(
    adapters.publish(
      execution,
      { baseCommit: "0".repeat(40), patch: Buffer.from("unused") },
      async () => undefined,
    ),
    /execution is disabled/,
  );
  assert.equal(adapters.mode, "live");
});
