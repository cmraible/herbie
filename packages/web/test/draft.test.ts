import test from "node:test";
import assert from "node:assert/strict";
import { draftSchema, newDraft, parseDraft } from "../src/draft.js";

test("a new project needs only a repository and prompt", () => {
  const draft = { ...newDraft("demo/example"), prompt: "Add regression coverage" };
  assert.deepEqual(parseDraft(draft), {
    repository: "demo/example",
    prompt: "Add regression coverage",
    targetWip: 1,
    workflow: "loop",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    resources: null,
    setupScript: "",
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
    workflow: "loop",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    resources: null,
    setupScript: "",
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

test("single PR drafts preserve workflow and request ID across reloads", () => {
  const draft = {
    ...newDraft("demo/example"),
    workflow: "single_pr" as const,
    prompt: "Fix this ticket",
  };
  const restored = draftSchema.parse(JSON.parse(JSON.stringify(draft)));
  assert.equal(restored.requestId, draft.requestId);
  assert.equal(parseDraft(restored).workflow, "single_pr");
  assert.equal(parseDraft(restored).targetWip, 1);
  assert.throws(() => parseDraft({ ...restored, targetWip: "2" }), /targetWip/);
  const { workflow: _workflow, ...legacy } = draft;
  assert.equal(draftSchema.parse(legacy).workflow, "loop");
});

test("reviewer survives saved drafts and blank usernames use the owner", () => {
  const draft = {
    ...newDraft("demo/example"),
    prompt: "Fix arithmetic",
    reviewer: " octocat, hubot ",
  };
  assert.deepEqual(parseDraft(draftSchema.parse(draft)).reviewers, ["octocat", "hubot"]);
  assert.equal(parseDraft({ ...draft, reviewer: " " }).reviewers, undefined);
  const { reviewer: _reviewer, ...legacy } = draft;
  assert.equal(draftSchema.parse(legacy).reviewer, "");
});

test("setup scripts survive draft restoration and old drafts default to no setup", () => {
  const draft = { ...newDraft("demo/example"), prompt: "Work", setupScript: "echo ready\n" };
  assert.equal(parseDraft(draftSchema.parse(draft)).setupScript, draft.setupScript);
  const { setupScript: _script, ...oldDraft } = draft;
  assert.equal(draftSchema.parse(oldDraft).setupScript, "");
});
