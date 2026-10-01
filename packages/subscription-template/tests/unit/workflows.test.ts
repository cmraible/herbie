import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
const Job = z.object({
  if: z.string(),
  concurrency: z.object({
    group: z.string(),
    queue: z.enum(["single", "max"]).default("single"),
    "cancel-in-progress": z.boolean(),
  }),
});
const Workflow = z.object({ jobs: z.record(z.string(), z.unknown()) });

test("disabling new previews keeps close cleanup eligible and cannot replace queued cleanup", async () => {
  const hosting = Workflow.parse(
    parse(await readFile("../../.github/workflows/subscription-template-hosting.yml", "utf8")),
  );
  const cleanup = Workflow.parse(
    parse(await readFile("../../.github/workflows/subscription-template-cleanup.yml", "utf8")),
  );
  const deployment = Job.parse(hosting.jobs.deploy),
    removal = Job.parse(cleanup.jobs.cleanup);
  // GitHub's declarative policy is the tested interface; no provider actions execute here.
  expect(deployment.if).toContain("SUBSCRIPTION_PREVIEW_ENABLED");
  expect(removal.if).not.toContain("SUBSCRIPTION_PREVIEW_ENABLED");
  expect(removal.if).toContain(
    "github.event.pull_request.head.repo.full_name == github.repository",
  );
  for (const job of [deployment, removal]) {
    expect(job.concurrency.queue).toBe("max");
    expect(job.concurrency["cancel-in-progress"]).toBe(false);
    expect(job.concurrency.group.replace(/\$\{\{.*?\}\}/, "12")).toBe("subscription-hosting-12");
  }
});
