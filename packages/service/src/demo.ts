import { createHash } from "node:crypto";
import type { Adapters } from "./adapters.js";
import { KnownRunFailure } from "./adapters.js";

// This deterministic adapter never calls GitHub, Daytona, a model, or host Git.
export function createDemoAdapters(): Adapters {
  return {
    mode: "demo",
    async repositories() {
      return [{ fullName: "demo/example", defaultBranch: "main", installationId: 0 }];
    },
    async authorize(_userId, repository) {
      if (repository !== "demo/example") throw new Error("Demo supports only demo/example");
      return { repository, defaultBranch: "main", installationId: 0 };
    },
    async reconciliationRepository(repository) {
      if (repository !== "demo/example") throw new Error("Demo supports only demo/example");
      return { repository, defaultBranch: "main", installationId: 0 };
    },
    async run(execution, report) {
      await report("DEMO: deterministic run started; no sandbox or model was used.");
      if (execution.project.prompt.includes("[demo:fail]"))
        throw new KnownRunFailure(
          "DEMO: requested simulated run failure; no publication occurred.",
        );
      const patch = Buffer.from("DEMO artifact; never eligible for live publication.");
      await report("DEMO: simulated run completed.");
      return { baseCommit: "0".repeat(40), patch };
    },
    async publish(execution, _changes, requireLease) {
      await requireLease();
      const number = Number.parseInt(
        createHash("sha256").update(execution.runId).digest("hex").slice(0, 7),
        16,
      );
      return {
        url: `https://demo.invalid/herbie/pull/${number}`,
        number,
        branch: execution.branch,
      };
    },
    async reconcile(execution) {
      return execution.project.pullRequests.find((pr) => pr.branch === execution.branch) ?? null;
    },
  };
}

export function demoProjectName(prompt: string): string {
  return (
    Array.from(prompt.replaceAll("[demo:fail]", "").trim()).slice(0, 120).join("").trim() ||
    "Demo project"
  );
}
