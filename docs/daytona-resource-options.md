# Daytona resource configuration

Researched 2026-10-16 against official documentation, the published OpenAPI schema, and the pinned `@daytona/sdk@0.220.0` package.

Daytona exposes numeric CPU, memory, and disk allocations rather than a catalog of named machine sizes. CPU is measured in cores; memory and disk in GiB. The TypeScript image creation parameters accept `resources: { cpu, memory, disk }`. [SDK documentation](https://www.daytona.io/docs/en/typescript-sdk/daytona/)

## Discovering limits

Use `GET https://app.daytona.io/api/organizations/{organizationId}/usage` with `Authorization: Bearer <API key>`. Its `regionUsage` entries contain `regionId`, `sandboxClass`, per-sandbox maxima (`maxCpuPerSandbox`, `maxMemoryPerSandbox`, `maxDiskPerSandbox`, and `maxDiskPerNonEphemeralSandbox`), organization totals, and current usage. The maxima are nullable; do not interpret missing bounds as zero. This describes limits and usage, not guaranteed spare host capacity or a list of allowed machine combinations. [OpenAPI schemas: OrganizationUsageOverview and RegionUsageOverview](https://www.daytona.io/docs/openapi.json), [usage endpoint example](https://www.daytona.io/docs/en/organizations/#usage-overview)

API-key access to usage shipped in July 2026. The key needs `read:limits`; `read:billing` also works. Results are cached for 60 seconds. Older reports that this endpoint requires a dashboard JWT are obsolete for Daytona Cloud. [Daytona maintainer confirmation, September 7, 2026](https://github.com/daytonaio/daytona/issues/4643)

`GET /api-keys/current` returns the current key's details, including `organizationId`. `GET /organizations/{organizationId}/available-sandbox-classes` lists region/class/GPU availability, not CPU/RAM sizes. [OpenAPI](https://www.daytona.io/docs/openapi.json), [sandbox classes documentation](https://www.daytona.io/docs/en/organizations/#list-available-sandbox-classes)

Distinguish per-sandbox maximums from shared organization quotas: larger allocations consume the same regional pool used by concurrent sandboxes. A valid project setting can still fail at execution time if other sandboxes exhaust that pool. [Limits documentation](https://www.daytona.io/docs/en/limits/)

## Pinned SDK caveat

Live checks on 2026-10-16 confirmed that `@daytona/sdk@0.220.0` rejects snapshot creation with `resources` ("Cannot specify Sandbox resources when using a snapshot"). The documented stop/resize/start workflow also failed against this account: `POST /sandbox/{id}/resize` returned "Cannot POST". The temporary environment was deleted. Project overrides therefore apply only to image-based environments; configured snapshots retain their own allocation and reject overrides before provisioning. [SDK documentation](https://www.daytona.io/docs/en/typescript-sdk/daytona/), [resize documentation](https://www.daytona.io/docs/en/sandboxes/#resources)

A live image-based creation confirmed allocation of 4 CPUs, 8 GiB RAM, and 10 GiB disk. The quota endpoint worked with the existing API key, but `GET /organizations/{id}` did not. Limit discovery uses only the API-key details and usage endpoints. With multiple eligible CPU regions, configure an explicit target instead of guessing. Effective input maxima also respect the regional total quota; current usage remains a creation-time constraint.

For project settings, store CPU cores, memory GiB, and disk GiB; validate against fetched bounds and show shared usage separately. Keep the execution time budget independently configurable because more memory does not resolve a hard run deadline. This paragraph is an implementation recommendation, not a Daytona API requirement.
