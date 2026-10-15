import assert from "node:assert/strict";
import test from "node:test";
import { goalInput, goalRename } from "../src/index.js";

test("blank create names are omitted while renames must remain nonblank", () => {
  for (const name of [undefined, "", " \n\t "]) {
    assert.equal(
      goalInput.parse({ repository: "demo/example", prompt: "Fix arithmetic", name }).name,
      undefined,
    );
    assert.equal(goalRename.safeParse({ name }).success, false);
  }
  assert.equal(
    goalInput.parse({ repository: "demo/example", prompt: "Fix arithmetic", name: " Custom name " })
      .name,
    "Custom name",
  );
  assert.equal(
    goalInput.safeParse({
      repository: "demo/example",
      prompt: "Fix arithmetic",
      name: "x".repeat(121),
    }).success,
    false,
  );
});
