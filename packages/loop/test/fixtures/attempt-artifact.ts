import type { DaytonaAttemptArtifact } from "../../src/daytona-attempt.js";

export function createAttemptArtifact(
  overrides: Partial<DaytonaAttemptArtifact> = {},
): DaytonaAttemptArtifact {
  return {
    baseCommit: "a".repeat(40),
    patchBase64: Buffer.from("diff --git a/file.txt b/file.txt\n").toString("base64"),
    pullRequestTitle: "Fix addition totals",
    pullRequestBody:
      "Fixed addition to sum both operands so totals are correct. Verified with arithmetic tests.",
    ...overrides,
  };
}
