import assert from "node:assert/strict";
import test from "node:test";
import { CommandExitError } from "e2b";
import { createE2BProvider } from "../src/e2b.js";
import { e2bTemplateOptions } from "../src/e2b-template-options.js";

test("E2B automatically prepares a default template without operator configuration", async () => {
  let resolved = false;
  const provider = createE2BProvider(
    { apiKey: "test", openaiSecretName: "openai" },
    async (options) => {
      assert.equal(resolved, true);
      assert.equal(options.template, "generated-default");
      return {
        sandboxId: "generated",
        getInfo: async () => ({ cpuCount: 2, memoryMB: 4096 }) as never,
        files: {} as never,
        commands: {} as never,
        kill: async () => true,
      };
    },
    async () => {
      throw new Error("Unexpected connection");
    },
    async (resources, _signal, setupScript) => {
      assert.deepEqual(resources, { cpu: 2, memory: 4, disk: 10 });
      assert.equal(setupScript, "echo configured");
      resolved = true;
      return "generated-default";
    },
  );
  assert.equal(
    (await provider.create({ name: "test", timeoutMs: 1000, setupScript: "echo configured" })).id,
    "generated",
  );
});

test("failed template preparation and cancelled attempts never create a sandbox", async () => {
  const controller = new AbortController();
  let fail = true;
  const provider = createE2BProvider(
    { apiKey: "test", openaiSecretName: "openai" },
    async () => {
      throw new Error("Unexpected sandbox creation");
    },
    async () => {
      throw new Error("Unexpected connection");
    },
    async () => {
      if (fail) throw new Error("Template build failed");
      controller.abort(new Error("Stopped during build"));
      return "generated";
    },
  );
  await assert.rejects(provider.create({ name: "test", timeoutMs: 1000 }), /Template build failed/);
  fail = false;
  await assert.rejects(
    provider.create({ name: "test", timeoutMs: 1000, signal: controller.signal }),
    /Stopped during build/,
  );
});

test("E2B template build options convert GiB and reject invalid sizes before provisioning", () => {
  assert.deepEqual(e2bTemplateOptions(["runtime"]).options, { cpuCount: 2, memoryMB: 4096 });
  assert.deepEqual(e2bTemplateOptions(["large", "4", "8", "10"]).options, {
    cpuCount: 4,
    memoryMB: 8192,
    minFreeDiskMb: 10240,
  });
  for (const sizes of [
    ["4"],
    ["4", "8", "10", "20"],
    ["0", "8", "10"],
    ["2", "1.5", "10"],
    ["2", "8", "NaN"],
  ])
    assert.throws(() => e2bTemplateOptions(["runtime", ...sizes]));
});

test("E2B resolves a sized template and verifies allocations on creation and reconnection", async () => {
  const resources = { cpu: 4, memory: 8, disk: 10 };
  let allocated = { cpuCount: 4, memoryMB: 8192 };
  let disk = String(12 * 1024 ** 3);
  let exitCode = 0;
  let configurations = 0;
  const sandbox = {
    sandboxId: "sized",
    getInfo: async () => allocated as never,
    files: {} as never,
    commands: {
      run: async (command: string) => {
        if (command.startsWith("df ")) return { exitCode, stdout: disk, stderr: "" };
        configurations++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as never,
    kill: async () => true,
  };
  const provider = createE2BProvider(
    {
      apiKey: "key",
      template: "default",
      openaiSecretName: "secret",
    },
    async (options) => {
      assert.equal(options.template, "large");
      assert.deepEqual(options.metadata, { name: "test" });
      assert.equal(options.envs?.OPENAI_API_KEY, "herbie-egress-placeholder");
      return sandbox;
    },
    async () => sandbox,
    async (requested) => {
      assert.deepEqual(requested, resources);
      return "large";
    },
  );
  const environment = await provider.create({ name: "test", timeoutMs: 1000, resources });
  await environment.prepare();
  assert.equal(configurations, 1);
  const reconnected = await provider.connect!("sized", resources);
  await reconnected!.prepare();
  assert.equal(configurations, 2);
  for (const wrong of [
    { cpuCount: 2, memoryMB: 8192 },
    { cpuCount: 4, memoryMB: 4096 },
  ]) {
    allocated = wrong;
    await assert.rejects(environment.prepare(), /requested CPU and memory/);
  }
  allocated = { cpuCount: 4, memoryMB: 8192 };
  for (const wrong of [String(9 * 1024 ** 3), "", "NaN"]) {
    disk = wrong;
    await assert.rejects(environment.prepare(), /minimum disk/);
  }
  disk = String(12 * 1024 ** 3);
  exitCode = 1;
  await assert.rejects(environment.prepare(), /minimum disk/);
  assert.equal(configurations, 2);
});

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
        getInfo: async () => ({ cpuCount: 2, memoryMB: 4096 }) as never,
        commands: {
          run: async (command: string) => {
            if (command.startsWith("df "))
              return { exitCode: 0, stdout: String(20 * 1024 ** 3), stderr: "", error: "" };
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
    async () => {
      throw new Error("Unexpected connection");
    },
    async () => "test-template",
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
      getInfo: async () => {
        throw new Error("Unexpected sizing check");
      },
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
    async () => {
      throw new Error("Unexpected connection");
    },
    async () => "template",
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
      getInfo: async () => {
        throw new Error("Unexpected sizing check");
      },
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
    async () => {
      throw new Error("Unexpected connection");
    },
    async () => "template",
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
