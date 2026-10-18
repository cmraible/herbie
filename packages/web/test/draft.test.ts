import test from "node:test";
import assert from "node:assert/strict";
import { draftSchema, newDraft, parseDraft } from "../src/draft.js";

test("a new project needs only a repository and prompt", () => {
  const draft = { ...newDraft("demo/example"), prompt: "Add regression coverage" };
  assert.deepEqual(parseDraft(draft), {
    repository: "demo/example",
    prompt: "Add regression coverage",
    targetWip: 1,
    model: "gpt-6-luna",
    reasoningEffort: "low",
    resources: null,
  });
});

test("saved drafts from before test-command and attempt-limit removal still restore", () => {
  const draft = { ...newDraft("demo/example"), prompt: "Fix arithmetic" };
  assert.deepEqual(
    draftSchema.parse({ ...draft, test: '["npm","test"]', maxAttempts: "2" }),
    draft,
  );
});

test("legacy named drafts preserve the original request for idempotent retries", () => {
  const draft = { ...newDraft("demo/example"), prompt: "Fix arithmetic" };
  const restored = draftSchema.parse({ ...draft, name: "Old custom name" });
  assert.equal(restored.requestId, draft.requestId);
  assert.deepEqual(parseDraft(restored), {
    repository: "demo/example",
    name: "Old custom name",
    prompt: "Fix arithmetic",
    targetWip: 1,
    model: "gpt-6-luna",
    reasoningEffort: "low",
    resources: null,
  });
});

test("WIP defaults to one for saved drafts and rejects invalid limits", () => {
  const { targetWip: _targetWip, ...oldDraft } = {
    ...newDraft("demo/example"),
    prompt: "Fix arithmetic",
  };
  assert.equal(draftSchema.parse(oldDraft).targetWip, "1");
  for (const targetWip of ["0", "-1", "1.5", "no"])
    assert.throws(() => parseDraft({ ...oldDraft, targetWip }), /targetWip/);
});

test("old drafts default reasoning effort and new selections survive restoration", () => {
  const { reasoningEffort: _effort, ...legacy } = newDraft("demo/example");
  assert.equal(draftSchema.parse(legacy).reasoningEffort, "low");
  const restored = draftSchema.parse({
    ...legacy,
    reasoningEffort: "high",
    prompt: "Fix arithmetic",
  });
  assert.equal(parseDraft(restored).reasoningEffort, "high");
});

test("custom environment resources survive draft restoration", () => {
  const draft = {
    ...newDraft("demo/example"),
    prompt: "Optimize verification",
    resources: { cpu: 4, memory: 8, disk: 10 },
  };
  assert.deepEqual(parseDraft(draftSchema.parse(draft)).resources, draft.resources);
});
