/// <reference types="@cloudflare/vitest-plugin/types" />
import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

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
    signatureValid: true,
  });
});

it("rejects unsupported request methods in the Workers runtime", async () => {
  const response = await SELF.fetch("https://workers.test/", { method: "PUT" });
  expect(response.status).toBe(405);
});

it("loads the database, auth, and Daytona SDK entrypoints in the Workers runtime", async () => {
  const response = await SELF.fetch("https://workers.test/", { method: "GET" });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    postgresPoolAvailable: true,
    betterAuthAvailable: true,
    daytonaAvailable: true,
  });
});
