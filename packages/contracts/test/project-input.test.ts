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
