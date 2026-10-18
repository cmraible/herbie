import assert from "node:assert/strict";
import test from "node:test";
import { Daytona } from "@daytona/sdk";
import { SessionDetached } from "@herbie/loop/agent-attempt";
import { createLiveAdapters } from "../src/live.js";
import { createGithub } from "../src/github.js";
import type { Execution } from "../src/adapters.js";

test("resuming an existing environment does not depend on limits discovery", async (t) => {
  let limitsRequests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    limitsRequests++;
    throw new Error("Limits API unavailable");
  });
  let connections = 0;
  t.mock.method(Daytona.prototype, "get", async (id: string) => {
    assert.equal(id, "original-environment");
    connections++;
    throw new Error("Reconnect interrupted");
  });
  const adapters = createLiveAdapters(
    { apiKey: "fixture", openaiSecretName: "fixture" },
    createGithub({
      appId: "fixture",
      clientId: "fixture",
      clientSecret: "fixture",
      privateKey: "fixture",
      callbackUrl: "https://herbie.example/callback",
      webhookSecret: "fixture",
    }),
    {
      userToken: async () => {
        throw new Error("Unexpected authorization");
      },
    },
  );
  const execution: Execution = {
    project: {
      id: "id",
      ownerId: "user",
      repository: "demo/example",
      name: "Disabled work",
      resources: null,
      prompt: "Disabled work",
      attemptCount: 0,
      targetWip: 1,
      model: "gpt-6-luna",
      reasoningEffort: "low",
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

  execution.project.resources = { cpu: 2, memory: 4, disk: 10 };
  execution.durable = {
    checkpoint: {
      version: 1,
      name: "herbie-attempt-1234",
      environmentId: "original-environment",
      provider: "daytona",
      phase: "running",
      deadline: Date.now() + 60_000,
    },
    save: async () => {},
  };
  await assert.rejects(
    adapters.attempt(execution, async () => {}),
    SessionDetached,
  );
  assert.equal(connections, 1);
  assert.equal(limitsRequests, 0);
});
