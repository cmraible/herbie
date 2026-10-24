/// <reference types="@cloudflare/vitest-plugin/types" />
import { SELF } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { createE2BProvider } from "../../loop/src/e2b.js";

it("runs request handling and Web Crypto inside the Workers runtime", async () => {
  const response = await SELF.fetch("https://workers.test/", {
    method: "POST",
    body: "herbie-workers-compatibility",
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    digest: "00d972b93d6edb7c3888d901a2aff512e2387a1f883a5f44e7761d3befa640f8",
  });
});

it("supports credential encryption and RSA signing primitives in the Workers runtime", async () => {
  const response = await SELF.fetch("https://workers.test/crypto", {
    method: "POST",
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    credentialRoundTrip: true,
    tamperedCiphertextRejected: true,
    signatureValid: true,
  });
});

it("rejects unsupported request methods in the Workers runtime", async () => {
  const response = await SELF.fetch("https://workers.test/", { method: "PUT" });
  expect(response.status).toBe(405);
});

it("loads the database, auth, and sandbox provider entrypoints in the Workers runtime", async () => {
  const response = await SELF.fetch("https://workers.test/", { method: "GET" });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    postgresPoolAvailable: true,
    betterAuthAvailable: true,
    daytonaAvailable: true,
    e2bProviderAvailable: true,
  });
});

it("creates, reconnects, executes, and cleans up through the E2B adapter in workerd", async () => {
  // Exercise the real adapter/runtime with injected SDK responses. This does not
  // certify remote E2B transport or provisioning; that requires a live sandbox.
  type Sandbox = Awaited<ReturnType<NonNullable<Parameters<typeof createE2BProvider>[1]>>>;
  const run = vi.fn<Sandbox["commands"]["run"]>().mockResolvedValue({
    exitCode: 0,
    stdout: "worker-compatible",
    stderr: "",
    error: undefined,
  });
  const kill = vi.fn<Sandbox["kill"]>().mockResolvedValue(true);
  const sandbox: Sandbox = {
    sandboxId: "workers-compatibility",
    // Vitest models the final overload; this fixture only uses foreground runs.
    commands: { run: run as Sandbox["commands"]["run"] },
    files: {
      read: async () => {
        throw new Error("Unexpected file read");
      },
      write: async () => {
        throw new Error("Unexpected file write");
      },
    },
    getInfo: async () => {
      throw new Error("Unexpected sandbox inspection");
    },
    kill,
  };
  const create = vi.fn().mockResolvedValue(sandbox);
  const connect = vi.fn().mockResolvedValue(sandbox);
  const resolveTemplate = vi.fn().mockResolvedValue("isolated-test-template");
  const provider = createE2BProvider(
    { apiKey: "test-only", openaiSecretName: "test-model-key" },
    create,
    connect,
    resolveTemplate,
  );
  const environment = await provider.create({ name: "workers-test", timeoutMs: 30_000 });
  expect(environment.id).toBe(sandbox.sandboxId);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      template: "isolated-test-template",
      network: expect.objectContaining({ allowPublicTraffic: false }),
      envs: { OPENAI_API_KEY: "herbie-egress-placeholder" },
    }),
  );
  await expect(environment.exec("printf worker-compatible", { timeoutMs: 1_000 })).resolves.toEqual(
    {
      exitCode: 0,
      result: "worker-compatible",
    },
  );
  expect(run).toHaveBeenCalledWith("printf worker-compatible", {
    timeoutMs: 1_000,
    user: "root",
    requestTimeoutMs: 30_000,
  });
  const reconnected = await provider.connect!(environment.id);
  expect(connect).toHaveBeenCalledWith(environment.id);
  await reconnected!.destroy();
  expect(kill).toHaveBeenCalledWith({ requestTimeoutMs: 60_000 });
});
