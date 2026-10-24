import assert from "node:assert/strict";
import test from "node:test";
import { projectInput, projectRename } from "../src/index.js";

test("blank create names are omitted while renames must remain nonblank", () => {
  for (const name of [undefined, "", " \n\t "]) {
    assert.equal(
      projectInput.parse({ repository: "demo/example", prompt: "Fix arithmetic", name }).name,
      undefined,
    );
    assert.equal(projectRename.safeParse({ name }).success, false);
  }
  assert.equal(
    projectInput.parse({
      repository: "demo/example",
      prompt: "Fix arithmetic",
      name: " Custom name ",
    }).name,
    "Custom name",
  );
  assert.equal(
    projectInput.safeParse({
      repository: "demo/example",
      prompt: "Fix arithmetic",
      name: "x".repeat(121),
    }).success,
    false,
  );
});

test("models default for existing projects and can be configured or updated", async () => {
  const { projectUpdate } = await import("../src/index.js");
  const input = { repository: "demo/example", prompt: "Fix arithmetic" };
  assert.equal(projectInput.parse(input).model, "gpt-6-luna");
  assert.equal(projectInput.parse({ ...input, model: " custom-model " }).model, "custom-model");
  assert.deepEqual(projectUpdate.parse({ model: "custom-model" }), { model: "custom-model" });
  for (const model of ["", "   ", "x".repeat(201)]) {
    assert.equal(projectInput.safeParse({ ...input, model }).success, false);
    assert.equal(projectUpdate.safeParse({ model }).success, false);
  }
});

test("reasoning effort defaults for legacy projects and supports updates", async () => {
  const { projectUpdate } = await import("../src/index.js");
  const input = { repository: "demo/example", prompt: "Fix arithmetic" };
  assert.equal(projectInput.parse(input).reasoningEffort, "low");
  assert.equal(projectInput.parse({ ...input, reasoningEffort: "high" }).reasoningEffort, "high");
  assert.deepEqual(projectUpdate.parse({ reasoningEffort: "high" }), { reasoningEffort: "high" });
  assert.equal(projectUpdate.safeParse({ reasoningEffort: "" }).success, false);
});

test("environment sizing defaults to inherited and requires positive whole numbers", async () => {
  const { projectUpdate } = await import("../src/index.js");
  const input = { repository: "demo/example", prompt: "Optimize verification" };
  assert.equal(projectInput.parse(input).resources, null);
  assert.deepEqual(projectUpdate.parse({ resources: null }), { resources: null });
  for (const resources of [
    { cpu: 0, memory: 8, disk: 10 },
    { cpu: 4, memory: 1.5, disk: 10 },
    { cpu: 4, memory: 8 },
    { cpu: 4, memory: 8, disk: 10, gpu: 1 },
  ]) {
    assert.equal(projectInput.safeParse({ ...input, resources }).success, false);
  }
});

test("single PR workflows accept one slot and legacy inputs remain recurring", () => {
  const input = { repository: "demo/example", prompt: "Fix arithmetic" };
  assert.equal(projectInput.parse(input).workflow, "loop");
  assert.equal(projectInput.parse({ ...input, workflow: "single_pr" }).targetWip, 1);
  assert.equal(
    projectInput.safeParse({ ...input, workflow: "single_pr", targetWip: 2 }).success,
    false,
  );
  assert.equal(projectInput.safeParse({ ...input, workflow: "unknown" }).success, false);
});

test("reviewer accepts GitHub usernames and can be cleared on edit", async () => {
  const { projectUpdate } = await import("../src/index.js");
  const input = { repository: "demo/example", prompt: "Fix arithmetic" };
  assert.equal(projectInput.parse(input).reviewers, undefined);
  assert.deepEqual(projectInput.parse({ ...input, reviewers: [" octocat "] }).reviewers, [
    "octocat",
  ]);
  assert.deepEqual(projectUpdate.parse({ reviewers: null }), { reviewers: null });
  assert.deepEqual(projectUpdate.parse({ reviewers: ["another-user"] }), {
    reviewers: ["another-user"],
  });
  for (const reviewer of [
    "",
    "@octocat",
    "-user",
    "user-",
    "two--hyphens",
    "a/b",
    "x".repeat(40),
  ]) {
    assert.equal(projectInput.safeParse({ ...input, reviewers: [reviewer] }).success, false);
    assert.equal(projectUpdate.safeParse({ reviewers: [reviewer] }).success, false);
  }
});

test("setup scripts default for old projects, preserve Bash contents, and allow clearing", async () => {
  const { projectUpdate } = await import("../src/index.js");
  const input = { repository: "demo/example", prompt: "Work" };
  const setupScript = "#!/bin/bash\n  echo 'quoted'\n";
  assert.equal(projectInput.parse(input).setupScript, "");
  assert.equal(projectInput.parse({ ...input, setupScript }).setupScript, setupScript);
  assert.deepEqual(projectUpdate.parse({ setupScript: "" }), { setupScript: "" });
  for (const script of ["x".repeat(32_001), "echo\0bad"])
    assert.equal(projectInput.safeParse({ ...input, setupScript: script }).success, false);
});
