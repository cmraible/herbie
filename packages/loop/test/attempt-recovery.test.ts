import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { runAgentAttempt, SessionDetached, type AttemptCheckpoint } from "../src/agent-attempt.js";
import type { Environment, EnvironmentProvider } from "../src/environment.js";

for (const phase of ["collected", "deleted"] as const) {
  test(`saved patches survive replacement ${phase === "collected" ? "during" : "after"} environment deletion`, async () => {
    let checkpoint: AttemptCheckpoint = {
      version: 1,
      name: `herbie-attempt-${randomUUID()}`,
      environmentId: "same-environment",
      phase,
      deadline: Date.now() + 60_000,
      artifact: JSON.stringify({
        baseCommit: "a".repeat(40),
        patchBase64: Buffer.from("patch").toString("base64"),
        pullRequestTitle: "Saved title",
        pullRequestBody: "Saved body",
      }),
    };
    let connects = 0;
    const provider: EnvironmentProvider = {
      name: "fixture",
      create: async () => {
        throw new Error("Must not create a replacement environment");
      },
      connect: async (id) => {
        connects++;
        assert.equal(id, "same-environment");
        return null;
      },
    };
    const changes = await runAgentAttempt(
      provider,
      {
        repoUrl: "https://github.com/example/repo.git",
        project: "Original instructions",
        durable: {
          checkpoint,
          save: async (state) => {
            checkpoint = structuredClone(state);
          },
        },
      },
      () => {},
      new URL("../dist/", import.meta.url),
    );
    assert.equal(changes.patch.toString(), "patch");
    assert.equal(changes.verification?.sandboxDeleted, true);
    assert.equal(checkpoint.phase, "deleted");
    assert.equal(connects, phase === "deleted" ? 0 : 1);
  });
}

test("observer loss never destroys a running environment", async () => {
  let destroys = 0;
  const environment = {
    id: "original",
    exec: async () => {
      throw new Error("Network disconnected");
    },
    destroy: async () => {
      destroys++;
    },
    readFile: async () => Readable.from([]),
  } as unknown as Environment;
  const checkpoint: AttemptCheckpoint = {
    version: 1,
    name: `herbie-attempt-${randomUUID()}`,
    environmentId: "original",
    phase: "running",
    deadline: Date.now() + 60_000,
  };
  await assert.rejects(
    runAgentAttempt(
      {
        name: "fixture",
        create: async () => {
          throw new Error("Unexpected create");
        },
        connect: async () => environment,
      },
      {
        repoUrl: "https://github.com/example/repo.git",
        project: "Original",
        durable: { checkpoint, save: async () => {} },
      },
      () => {},
      new URL("../dist/", import.meta.url),
    ),
    SessionDetached,
  );
  assert.equal(destroys, 0);
});

for (const state of ["running", "failed", "completed"] as const) {
  const fails = state !== "completed";
  test(`stream observation with ${state} execution ${fails ? "failure releases the observer without deletion" : "reconnects and saves the completed agent's patches"}`, async () => {
    let launches = 0,
      destroys = 0,
      streams = 0,
      reads = 0;
    const records: string[] = [];
    const environment = {
      id: "original",
      exec: async (command: string) => {
        if (command.includes("nohup")) {
          launches++;
          return { exitCode: 0, result: "" };
        }
        if (command.includes("printf running")) {
          reads++;
          return {
            exitCode: 0,
            result: state === "running" ? "running" : state === "failed" ? "1" : "0",
          };
        }
        if (command.includes("head -c"))
          return { exitCode: 0, result: "herbie-attempt-completed\n" };
        throw new Error("Unexpected polling");
      },
      streamCommand: async (command: string, receive: (chunk: string) => Promise<void>) => {
        streams++;
        if (fails) {
          await receive("!invalid!\n");
          return;
        }
        if (streams === 1) {
          await receive(Buffer.from("{}\n").toString("base64") + "\n");
          throw new Error("Connection reset");
        }
        assert.ok(command.endsWith(" 3"));
        await receive("done\n");
      },
      readFile: async () =>
        Readable.from([
          Buffer.from(
            JSON.stringify({
              baseCommit: "a".repeat(40),
              patchBase64: Buffer.from("patch").toString("base64"),
              pullRequestTitle: "Saved",
              pullRequestBody: "Original work",
            }),
          ),
        ]),
      destroy: async () => {
        destroys++;
      },
    } as unknown as Environment;
    const attempt = runAgentAttempt(
      {
        name: "fixture",
        create: async () => {
          throw new Error("Must not replace the environment");
        },
        connect: async () => environment,
      },
      {
        repoUrl: "https://github.com/example/repo.git",
        project: "Original",
        durable: {
          checkpoint: {
            version: 1,
            name: `herbie-attempt-${randomUUID()}`,
            environmentId: "original",
            phase: "running",
            deadline: Date.now() + 60_000,
          },
          save: async () => {},
        },
        onActivity: async (record) => {
          records.push(record);
        },
      },
      () => {},
      new URL("../dist/", import.meta.url),
    );
    if (fails) {
      await assert.rejects(attempt, SessionDetached);
      assert.equal(destroys, 0);
      assert.ok(reads <= 1);
    } else {
      assert.equal((await attempt).patch.toString(), "patch");
      assert.deepEqual(records, ["{}"]);
      assert.equal(streams, 2);
      assert.equal(destroys, 1);
    }
    assert.equal(launches, 1);
  });
}

test("explicit cancellation reconnects and deletes the original environment without executing again", async () => {
  let destroys = 0;
  const environment = {
    id: "original",
    exec: async () => {
      throw new Error("Must not execute after cancellation");
    },
    destroy: async () => {
      destroys++;
    },
  } as unknown as Environment;
  const controller = new AbortController();
  controller.abort(new Error("Project cancelled"));
  const checkpoint: AttemptCheckpoint = {
    version: 1,
    name: `herbie-attempt-${randomUUID()}`,
    environmentId: "original",
    phase: "running",
    deadline: Date.now() + 60_000,
  };
  await assert.rejects(
    runAgentAttempt(
      {
        name: "fixture",
        create: async () => {
          throw new Error("Unexpected create");
        },
        connect: async () => environment,
      },
      {
        repoUrl: "https://github.com/example/repo.git",
        project: "Original",
        signal: controller.signal,
        durable: { checkpoint, save: async () => {} },
      },
      () => {},
      new URL("../dist/", import.meta.url),
    ),
    (error: unknown) => {
      assert.equal((error as { cleanup: string }).cleanup, "confirmed");
      return true;
    },
  );
  assert.equal(destroys, 1);
});

test("cancellation discovers an environment created before its ID was checkpointed", async () => {
  let destroyed = 0;
  const checkpoint: AttemptCheckpoint = {
    version: 1,
    name: `herbie-attempt-${randomUUID()}`,
    phase: "created",
    deadline: Date.now() + 60_000,
  };
  const controller = new AbortController();
  controller.abort(new Error("Project cancelled during deployment"));
  const environment = {
    id: "created-before-crash",
    destroy: async () => {
      destroyed++;
    },
  } as unknown as Environment;
  await assert.rejects(
    runAgentAttempt(
      {
        name: "fixture",
        find: async (name) => {
          assert.equal(name, checkpoint.name);
          return environment;
        },
        create: async () => {
          throw new Error("Cancellation must not create an environment");
        },
      },
      {
        repoUrl: "https://github.com/example/repo.git",
        project: "Original",
        signal: controller.signal,
        durable: { checkpoint, save: async () => {} },
      },
      () => {},
      new URL("../dist/", import.meta.url),
    ),
    (error: unknown) => {
      assert.equal((error as { cleanup: string }).cleanup, "confirmed");
      return true;
    },
  );
  assert.equal(destroyed, 1);
});
