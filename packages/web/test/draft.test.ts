import test from "node:test";
import assert from "node:assert/strict";
import { draftSchema, newDraft, parseDraft } from "../src/draft.js";

test("a new project needs only a repository and prompt", () => {
  const draft = { ...newDraft("demo/example"), prompt: "Add regression coverage" };
  assert.deepEqual(parseDraft(draft), {
    repository: "demo/example",
    prompt: "Add regression coverage",
    maxWip: 1,
    model: "gpt-6-luna",
  });
});

test("saved drafts from before test-command and run-limit removal still restore", () => {
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
    maxWip: 1,
    model: "gpt-6-luna",
  });
});

test("WIP defaults to one for saved drafts and rejects invalid limits", () => {
  const { maxWip: _maxWip, ...oldDraft } = {
    ...newDraft("demo/example"),
    prompt: "Fix arithmetic",
  };
  assert.equal(draftSchema.parse(oldDraft).maxWip, "1");
  for (const maxWip of ["0", "-1", "1.5", "no"])
    assert.throws(() => parseDraft({ ...oldDraft, maxWip }), /maxWip/);
});
