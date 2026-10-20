import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { Daytona } from "@daytona/sdk";
import { projectSchema } from "@herbie/contracts";
import { createGithub } from "../src/github.js";
import { createLiveAdapters } from "../src/live.js";
import type { Execution } from "../src/adapters.js";

test("live checkout uses a repository-scoped read token and keeps it out of checkpoints", async (t) => {
  const tokenRequests: unknown[][] = [];
  const github = createGithub({
    appId: "fixture",
    clientId: "fixture",
    clientSecret: "fixture",
    privateKey: "fixture",
    callbackUrl: "https://herbie.example/callback",
    webhookSecret: "fixture",
  });
  t.mock.method(
    github,
    "installationToken",
    async (...args: Parameters<typeof github.installationToken>) => {
      tokenRequests.push(args);
      return "ghs_checkout-fixture";
    },
  );
  const commands: string[] = [];
  const uploads = new Map<string, string>();
  const states: unknown[] = [];
  let deleted = false;
  let model = false;
  const execute = async (command: string) => {
    commands.push(command);
    if (command.includes("agent-runner.js") && command.includes("nohup")) model = true;
    return {
      exitCode: 0,
      result: command.includes("printf running")
        ? "0"
        : command.includes("head -c") && model
          ? "herbie-attempt-completed\n"
          : "",
    };
  };
  const artifact = JSON.stringify({
    baseCommit: "a".repeat(40),
    patchBase64: Buffer.from("private patch").toString("base64"),
    pullRequestTitle: "Private fix",
    pullRequestBody: "Private fix details",
  });
  t.mock.method(
    Daytona.prototype,
    "get",
    async () =>
      ({
        id: "original-environment",
        fs: {
          uploadFile: async (contents: Buffer, path: string) => {
            uploads.set(path, contents.toString());
          },
          downloadFileStream: async () => Readable.from([Buffer.from(artifact)]),
        },
        git: { clone: async () => assert.fail("Must use authenticated checkout") },
        process: { executeCommand: execute },
        delete: async () => {
          deleted = true;
        },
      }) as unknown as Awaited<ReturnType<Daytona["get"]>>,
  );
  const adapters = createLiveAdapters({ apiKey: "fixture", openaiSecretName: "fixture" }, github, {
    userToken: async () => {
      throw new Error("Worker already authorized this checkout");
    },
  });
  const name = `herbie-attempt-${randomUUID()}`;
  const execution: Execution = {
    project: projectSchema.parse({
      id: randomUUID(),
      ownerId: "7",
      repository: "example/private",
      name: "Private project",
      prompt: "Fix private code",
      attemptCount: 1,
      state: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode: "live",
      stopRequested: null,
      pullRequest: null,
      error: null,
    }),
    repository: { repository: "example/private", installationId: 11, defaultBranch: "main" },
    attemptId: randomUUID(),
    branch: "herbie/attempt",
    durable: {
      checkpoint: {
        version: 1,
        name,
        environmentId: "original-environment",
        provider: "daytona",
        phase: "created",
        deadline: Date.now() + 60_000,
      },
      save: async (state) => {
        states.push(structuredClone(state));
      },
    },
  };
  const changes = await adapters.attempt(execution, async () => {});
  assert.equal(changes.patch.toString(), "private patch");
  assert.deepEqual(tokenRequests, [[11, "example/private", "read"]]);
  const credentials = [...uploads.entries()].filter(([path]) =>
    path.endsWith("-git-auth/input.json"),
  );
  assert.equal(credentials.length, 1);
  assert.deepEqual(JSON.parse(credentials[0][1]), {
    token: "ghs_checkout-fixture",
    repoUrl: "https://github.com/example/private.git",
    cwd: `/tmp/${name}/repo`,
  });
  assert.ok(!JSON.stringify({ commands, states, changes }).includes("ghs_checkout-fixture"));
  assert.ok(!uploads.get(`/tmp/${name}/attempt.json`)?.includes("ghs_checkout-fixture"));
  assert.equal(deleted, true);
});
