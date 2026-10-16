import assert from "node:assert/strict";
import test from "node:test";
import { createReasoningEffortLister } from "../src/reasoning-efforts.js";

test("reasoning options come from each model's catalog and share cached discovery", async () => {
  let calls = 0;
  const list = createReasoningEffortLister(async () => {
    calls++;
    return [
      { model: "fast", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
      {
        model: "deep",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "future" }],
      },
    ];
  });
  assert.deepEqual(await Promise.all([list("fast"), list("deep")]), [["low"], ["high", "future"]]);
  assert.deepEqual(await list("unknown"), []);
  assert.equal(calls, 1);
});

test("failed reasoning discovery can be retried", async () => {
  let calls = 0;
  const list = createReasoningEffortLister(async () => {
    if (++calls === 1) throw new Error("offline");
    return [];
  });
  await assert.rejects(list("model"), /offline/);
  assert.deepEqual(await list("model"), []);
  assert.equal(calls, 2);
});
