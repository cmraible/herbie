import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, evidence, questions, summary, validateAnswers } from "./classify-pr.mjs";

const pr = {
  title: "Fix worker",
  body: "Details",
  base: { sha: "base" },
  head: { sha: "head" },
  changed_files: 1,
  state: "open",
  labels: [{ name: "human-label" }, { name: "ai:risk:high" }],
};
const file = {
  filename: "packages/service/worker.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
};
const answers = () =>
  questions.map((question) =>
    question.type === "choice"
      ? {
          name: question.name,
          type: "choice",
          choice: question.name === "risk" ? "low" : "bug_fix",
          confidence: 0.9,
        }
      : { name: question.name, type: "predicate", probability: 0.2 },
  );

function fixture({ current = pr, files = [file], output = answers(), initial = pr } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    options: {
      number: 42,
      applyLabels: true,
      github: async (path, method = "GET", body) => {
        calls.push({ path, method, body });
        if (path === "/pulls/42") return reads++ === 0 ? initial : current;
        if (path.startsWith("/pulls/42/files?")) {
          const page = Number(new URL(path, "https://example.test").searchParams.get("page"));
          return files.slice((page - 1) * 100, page * 100);
        }
        if (path.startsWith("/labels/") && method === "GET")
          throw Object.assign(new Error("missing"), { status: 404 });
        return {};
      },
      decide: async (body) => {
        assert.equal(body.model, "gpt-6-luna");
        assert.deepEqual(body.questions, questions);
        assert.equal(JSON.parse(body.input).head_sha, "head");
        return { model: body.model, answers: output, usage: { total_tokens: 100 } };
      },
    },
  };
}

test("publishes only classifier labels and preserves unrelated labels", async () => {
  const { options, calls } = fixture();
  const result = await classify(options);
  assert.deepEqual(result.classification, { change_type: "bug_fix", risk: "low" });
  assert.deepEqual(calls.find((call) => call.path === "/issues/42/labels").body, {
    labels: ["ai:change_type:bug_fix", "ai:risk:low"],
  });
  assert.deepEqual(
    calls.filter((call) => call.method === "DELETE").map((call) => call.path),
    ["/issues/42/labels/ai%3Arisk%3Ahigh"],
  );
  assert.match(summary(result), /confidence 0.90/);
});

test("missing, truncated, or capped patches and missing files force insufficient context", async () => {
  for (const files of [
    [{ ...file, patch: undefined }],
    [{ ...file, patch: "+new" }],
    [],
    [{ ...file, patch: file.patch + "\n " + "x".repeat(120_000) }],
  ]) {
    const { options } = fixture({ files });
    const result = await classify(options);
    assert.equal(result.classification.risk, "insufficient_context");
    assert.equal(result.answers.find((answer) => answer.name === "risk").choice, "low");
    assert.match(summary(result), /risk forced to insufficient_context/);
  }
  assert.equal(evidence(pr, [file]).incomplete, false);
});

test("reads every page of files", async () => {
  const many = { ...pr, changed_files: 101 };
  const { options, calls } = fixture({
    files: Array(101).fill(file),
    initial: many,
    current: many,
  });
  const result = await classify(options);
  assert.equal(result.incomplete, false);
  assert.equal(calls.filter((call) => call.path.includes("/files?")).length, 2);
});

test("stale PRs and manual runs never mutate labels", async () => {
  for (const current of [
    { ...pr, head: { sha: "new" } },
    { ...pr, base: { sha: "new" } },
    { ...pr, body: "edited" },
    { ...pr, title: "edited" },
  ]) {
    const { options, calls } = fixture({ current });
    assert.equal((await classify(options)).stale, true);
    assert.ok(calls.every((call) => call.method === "GET"));
  }
  for (const current of [pr, { ...pr, state: "closed" }]) {
    const { options, calls } = fixture({ current });
    await classify({ ...options, applyLabels: current.state === "closed" });
    assert.ok(calls.every((call) => call.method === "GET"));
  }
});

test("refusals become unknown classifications, never low risk", async () => {
  const output = answers().map((answer) => ({ name: answer.name, type: "refusal" }));
  const { options } = fixture({ output });
  const result = await classify(options);
  assert.deepEqual(result.classification, { change_type: "unclear", risk: "insufficient_context" });
  assert.match(summary(result), /refused/);
});

test("malformed responses and API failures do not mutate labels", async () => {
  for (const output of [
    [],
    [...answers().slice(1), answers()[1]],
    answers().map((answer) =>
      answer.name === "risk" ? { ...answer, choice: "injected-label" } : answer,
    ),
    answers().map((answer) =>
      answer.type === "predicate" ? { ...answer, probability: 2 } : answer,
    ),
  ]) {
    const { options, calls } = fixture({ output });
    await assert.rejects(classify(options));
    assert.ok(calls.every((call) => call.method === "GET"));
  }
  const { options, calls } = fixture();
  await assert.rejects(
    classify({
      ...options,
      decide: async () => {
        throw new Error("HTTP 429");
      },
    }),
    /429/,
  );
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.throws(() => validateAnswers(null));
});
