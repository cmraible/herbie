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

it("rejects unsupported request methods in the Workers runtime", async () => {
  const response = await SELF.fetch("https://workers.test/");
  expect(response.status).toBe(405);
});
