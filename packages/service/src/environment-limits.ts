import { z } from "zod";
import { environmentLimits, type EnvironmentResources } from "@herbie/contracts";

export class EnvironmentLimitsError extends Error {}

export function createEnvironmentLimits(
  config: { apiKey: string; apiUrl?: string; target?: string; snapshot?: string },
  fetcher: typeof fetch = fetch,
) {
  let cached: { expires: number; value: z.infer<typeof environmentLimits> } | undefined;
  async function get(path: string) {
    const response = await fetcher(`${config.apiUrl ?? "https://app.daytona.io/api"}${path}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new EnvironmentLimitsError(
        "Could not load Daytona limits. Check the API key's read:limits permission.",
      );
    return response.json();
  }
  return async () => {
    if (config.snapshot)
      throw new EnvironmentLimitsError(
        "Custom resources require an image-based environment; configured snapshots use their own sizing.",
      );
    if (cached && cached.expires > Date.now()) return cached.value;
    const { organizationId } = z
      .object({ organizationId: z.string().uuid() })
      .parse(await get("/api-keys/current"));
    const usage = await get(`/organizations/${organizationId}/usage`);
    const regions = z
      .object({
        regionUsage: z.array(
          z.object({
            regionId: z.string(),
            sandboxClass: z.string(),
            totalCpuQuota: z.number(),
            totalMemoryQuota: z.number(),
            totalDiskQuota: z.number(),
            maxCpuPerSandbox: z.number().nullable(),
            maxMemoryPerSandbox: z.number().nullable(),
            maxDiskPerSandbox: z.number().nullable(),
            maxDiskPerNonEphemeralSandbox: z.number().nullable(),
          }),
        ),
      })
      .parse(usage).regionUsage;
    const matching = regions.filter(
      (region) =>
        (!config.target || region.regionId === config.target) &&
        region.sandboxClass === "container" &&
        region.totalCpuQuota > 0 &&
        region.totalMemoryQuota > 0,
    );
    if (matching.length !== 1)
      throw new EnvironmentLimitsError(
        "Configure a Daytona target with an available CPU resource pool to discover environment limits.",
      );
    const region = matching[0]!;
    const bound = (...values: (number | null)[]) =>
      Math.min(...values.filter((value) => value !== null));
    const value = environmentLimits.parse({
      cpu: bound(region.totalCpuQuota, region.maxCpuPerSandbox),
      memory: bound(region.totalMemoryQuota, region.maxMemoryPerSandbox),
      disk: bound(
        region.totalDiskQuota,
        region.maxDiskPerSandbox,
        region.maxDiskPerNonEphemeralSandbox,
      ),
    });
    cached = { value, expires: Date.now() + 60_000 };
    return value;
  };
}

export function validateEnvironmentResources(
  resources: EnvironmentResources,
  limits: z.infer<typeof environmentLimits>,
) {
  for (const key of ["cpu", "memory", "disk"] as const) {
    const max = limits[key];
    if (max !== null && resources[key] > max)
      throw new EnvironmentLimitsError(`Environment ${key} exceeds Daytona's limit of ${max}.`);
  }
}
