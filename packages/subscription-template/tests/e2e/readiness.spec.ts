import { test, expect } from "@playwright/test";
import worker from "../../src/worker";
import { testEnv } from "../../scripts/test-env";
test("readiness proves database/schema access and sanitizes failures", async () => {
  const env = { ...testEnv(), ASSETS: { fetch: async () => new Response("") } };
  const ready = await worker.fetch(new Request(env.APP_ORIGIN + "/ready"), env);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ ok: true });
  const missing = new URL(env.DATABASE_URL);
  missing.pathname = "/missing_" + crypto.randomUUID().replaceAll("-", "");
  const failed = await worker.fetch(new Request(env.APP_ORIGIN + "/ready"), {
    ...env,
    DATABASE_URL: missing.toString(),
  });
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: "Service not ready" });
});
