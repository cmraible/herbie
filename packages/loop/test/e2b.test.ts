import assert from "node:assert/strict";
import test from "node:test";
import { CommandExitError } from "e2b";
import { createE2BProvider } from "../src/e2b.js";

test("E2B uses a template and proxy secret, transfers bytes, and confirms absent environments", async () => {
  const calls: string[] = [];
  const provider = createE2BProvider(
    { apiKey: "test-key", template: "test-template", openaiSecretName: "openai" },
    async (options) => {
      assert.equal(options.template, "test-template");
      assert.equal(options.timeoutMs, 35 * 60_000);
      assert.equal(options.envs?.OPENAI_API_KEY, "herbie-egress-placeholder");
      assert.ok(JSON.stringify(options.network).includes("${e2b.secrets.openai}"));
      return {
        sandboxId: "e2b-id",
        commands: {
          run: async (command: string) => {
            calls.push(command);
            return { exitCode: 0, stdout: "output", stderr: "", error: "" };
          },
        } as never,
        files: {
          write: async (path: string, bytes: ArrayBuffer) => {
            assert.equal(path, "/tmp/file");
            assert.equal(Buffer.from(bytes).toString(), "contents");
          },
          read: async () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("artifact"));
                controller.close();
              },
            }),
        } as never,
        kill: async () => false,
      };
    },
  );
  await assert.rejects(
    provider.create({ name: "test", timeoutMs: 1, resources: { cpu: 2, memory: 4, disk: 10 } }),
    /template/,
  );
  const environment = await provider.create({ name: "test", timeoutMs: 35 * 60_000 });
  await environment.prepare();
  await environment.clone(
    "https://github.com/a/b.git",
    "/tmp/repo",
    "feature/'quoted",
    "a".repeat(40),
  );
  assert.ok(calls[1]?.includes("'feature/'\\''quoted'"));
  await environment.writeFile(Buffer.from("contents"), "/tmp/file");
  const stream = await environment.readFile("/tmp/file", {
    timeoutMs: 1000,
    signal: new AbortController().signal,
  });
  const chunks = [];
  for await (const chunk of stream) {
    assert.ok(Buffer.isBuffer(chunk));
    chunks.push(chunk);
  }
  assert.equal(Buffer.concat(chunks).toString(), "artifact");
  await environment.destroy();
});

test("E2B normalizes nonzero exits without hiding transport or cleanup failures", async () => {
  const error = new CommandExitError({
    exitCode: 2,
    stdout: "out",
    stderr: "err",
    error: "failed",
  });
  const provider = createE2BProvider(
    { apiKey: "key", template: "template", openaiSecretName: "secret" },
    async () => ({
      sandboxId: "id",
      files: {} as never,
      commands: {
        run: async () => {
          throw error;
        },
      } as never,
      kill: async () => {
        throw new Error("cleanup unavailable");
      },
    }),
  );
  const environment = await provider.create({ name: "test", timeoutMs: 1000 });
  assert.deepEqual(await environment.exec("false", { timeoutMs: 1000 }), {
    exitCode: 2,
    result: "outerr",
  });
  await assert.rejects(environment.prepare());
  await assert.rejects(environment.destroy(), /cleanup unavailable/);
});

test("E2B streams a bounded reader and aborting it never kills the environment", async () => {
  const controller = new AbortController();
  let destroyed = false;
  const provider = createE2BProvider(
    { apiKey: "key", template: "template", openaiSecretName: "secret" },
    async () => ({
      sandboxId: "id",
      files: {} as never,
      commands: {
        run: async (
          _: string,
          options: {
            signal: AbortSignal;
            timeoutMs: number;
            onStdout: (chunk: string) => Promise<void>;
          },
        ) => {
          assert.equal(options.signal, controller.signal);
          assert.equal(options.timeoutMs, 70_000);
          await options.onStdout("data");
          options.signal.throwIfAborted();
        },
      } as never,
      kill: async () => {
        destroyed = true;
        return true;
      },
    }),
  );
  const environment = await provider.create({ name: "test", timeoutMs: 1000 });
  await assert.rejects(
    environment.streamCommand!(
      "reader",
      async () => {
        controller.abort(new Error("Observer detached"));
      },
      controller.signal,
    ),
    /Observer detached/,
  );
  assert.equal(destroyed, false);
});
