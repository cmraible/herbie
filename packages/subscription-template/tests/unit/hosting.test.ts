import { test, expect } from "vitest";
import { assertCurrentTarget, findBranch, target, canCleanup } from "../../scripts/hosting";
test("a queued preview is rejected after closure, a new commit, or a fork substitution", async () => {
  const sha = "a".repeat(40),
    repository = "example/template";
  const approved = {
    state: "open",
    head: { sha, repo: { full_name: repository } },
    author_association: "OWNER",
  };
  await expect(
    assertCurrentTarget(async () => approved, repository, sha, "12"),
  ).resolves.toBeUndefined();
  for (const snapshot of [
    { ...approved, state: "closed" },
    { ...approved, head: { ...approved.head, sha: "b".repeat(40) } },
    { ...approved, head: { ...approved.head, repo: { full_name: "attacker/template" } } },
  ]) {
    await expect(assertCurrentTarget(async () => snapshot, repository, sha, "12")).rejects.toThrow(
      "no longer eligible",
    );
  }
  await expect(
    assertCurrentTarget(async () => ({ commit: { sha: "b".repeat(40) } }), repository, sha),
  ).rejects.toThrow("superseded");
});
test("cleanup selection refuses a default database and confines Worker names to numeric PRs", async () => {
  expect(target("12")).toBe("herbie-subscription-pr-12");
  expect(() => target("../agent-factory")).toThrow();
  await expect(
    findBranch(
      async () => [
        {
          project_ref: "production",
          parent_project_ref: "parent",
          name: "herbie-subscription-pr-12",
          is_default: true,
        },
      ],
      "parent",
      "herbie-subscription-pr-12",
    ),
  ).rejects.toThrow("Refusing default");
});

test("delayed cleanup skips a reopened PR", async () => {
  const current = { state: "closed", head: { repo: { full_name: "example/template" } } };
  expect(await canCleanup(async () => current, "example/template", "12")).toBe(true);
  current.state = "open";
  expect(await canCleanup(async () => current, "example/template", "12")).toBe(false);
});
