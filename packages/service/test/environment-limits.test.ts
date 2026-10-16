import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvironmentLimits,
  validateEnvironmentResources,
} from "../src/environment-limits.js";

const organizationId = "41dfe3ad-81cd-4070-9606-292561eb4e55";
const region = {
  regionId: "us",
  sandboxClass: "container",
  totalCpuQuota: 10,
  totalMemoryQuota: 10,
  totalDiskQuota: 30,
  maxCpuPerSandbox: null,
  maxMemoryPerSandbox: 8,
  maxDiskPerSandbox: 20,
  maxDiskPerNonEphemeralSandbox: 10,
};
test("limit discovery uses the API-key endpoint and regional quota, caches, and ignores unrelated pools", async () => {
  const paths: string[] = [];
  const list = createEnvironmentLimits({ apiKey: "test-key" }, async (url, options) => {
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer test-key");
    const path = new URL(String(url)).pathname;
    paths.push(path);
    return Response.json(
      path.endsWith("current")
        ? { organizationId }
        : { regionUsage: [region, { ...region, regionId: "earth", totalCpuQuota: 0 }] },
    );
  });
  assert.deepEqual(await list(), { cpu: 10, memory: 8, disk: 10 });
  await list();
  assert.deepEqual(paths, ["/api/api-keys/current", `/api/organizations/${organizationId}/usage`]);
  assert.throws(
    () =>
      validateEnvironmentResources(
        { cpu: 4, memory: 9, disk: 10 },
        { cpu: 10, memory: 8, disk: 10 },
      ),
    /memory.*8/,
  );
});
test("failed discovery can recover without caching its error", async () => {
  let offline = true;
  const list = createEnvironmentLimits({ apiKey: "key", target: "us" }, async (url) => {
    if (offline) return new Response("private upstream details", { status: 403 });
    return Response.json(
      String(url).endsWith("current") ? { organizationId } : { regionUsage: [region] },
    );
  });
  await assert.rejects(list(), /read:limits/);
  offline = false;
  assert.deepEqual(await list(), { cpu: 10, memory: 8, disk: 10 });
});
test("snapshot overrides are rejected without calling Daytona", async () => {
  const list = createEnvironmentLimits({ apiKey: "key", snapshot: "runtime" }, async () => {
    throw new Error("unexpected request");
  });
  await assert.rejects(list(), /image-based environment/);
});
test("ambiguous CPU regions require an explicit target", async () => {
  const list = createEnvironmentLimits({ apiKey: "key" }, async (url) =>
    Response.json(
      String(url).endsWith("current")
        ? { organizationId }
        : { regionUsage: [region, { ...region, regionId: "eu" }] },
    ),
  );
  await assert.rejects(list(), /Configure a Daytona target/);
});
