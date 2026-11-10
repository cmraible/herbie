import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Store } from "../src/store.js";
import { ApiError } from "@prompt-to-pr/contracts";

async function database(fn: (store: Store) => Promise<void>) {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("Use pnpm test to provision disposable Postgres");
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  try {
    const store = new Store(pool);
    await store.migrate();
    await fn(store);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
const repository = { id: 12, fullName: "owner/repo", defaultBranch: "main" };
const input = { repositoryId: 12, prompt: "Fix bug" };
const create = (store: Store, owner = "alice", key = randomUUID()) =>
  store.create(owner, input, key, repository, 3);

test("concurrent identical submissions create one durable run and one event", () =>
  database(async (store) => {
    const key = randomUUID();
    const runs = await Promise.all(Array.from({ length: 8 }, () => create(store, "alice", key)));
    assert.equal(new Set(runs.map((run) => run.id)).size, 1);
    assert.equal((await store.list("alice")).items.length, 1);
    assert.equal((await store.events("alice", runs[0].id, "0")).items.length, 1);
    await assert.rejects(
      store.create("alice", { ...input, prompt: "Different" }, key, repository, 3),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
  }));

test("run details and events enforce ownership", () =>
  database(async (store) => {
    const run = await create(store);
    await assert.rejects(
      store.get("bob", run.id),
      (error: unknown) => error instanceof ApiError && error.status === 404,
    );
    await assert.rejects(store.events("bob", run.id, "0"));
    assert.deepEqual((await store.list("bob")).items, []);
  }));

test("concurrent workers can claim only one global run", () =>
  database(async (store) => {
    await create(store);
    await create(store);
    const claims = await Promise.all(Array.from({ length: 5 }, () => store.claim(randomUUID())));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(
      (await store.list("alice")).items.filter((run) => run.status === "queued").length,
      1,
    );
  }));

test("expired execution becomes needs_attention and is not executed again", () =>
  database(async (store) => {
    const run = await create(store);
    const worker = randomUUID();
    await store.claim(worker);
    await store.pool.query(
      "UPDATE runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [run.id],
    );
    await store.markInterrupted();
    assert.equal((await store.get("alice", run.id)).status, "needs_attention");
    await assert.rejects(store.checkpoint(run.id, worker, { status: "succeeded" }));
    await create(store);
    assert.equal(await store.claim(randomUUID()), null);
  }));

test("artifact and cleanup checkpoints survive a new store instance", () =>
  database(async (store) => {
    const run = await create(store);
    const worker = randomUUID();
    await store.claim(worker);
    await store.checkpoint(
      run.id,
      worker,
      { base_sha: "a".repeat(40), cleanup_complete: true, stage: "publishing" },
      "Changes saved",
    );
    const reopened = new Store(store.pool);
    assert.equal((await reopened.get("alice", run.id)).stage, "publishing");
    await reopened.checkpoint(run.id, worker, {
      status: "succeeded",
      pull_request: { number: 1, url: "https://github.com/owner/repo/pull/1" },
    });
    assert.equal((await reopened.get("alice", run.id)).pullRequest?.number, 1);
    assert.equal(
      (await reopened.events("alice", run.id, "0")).items.at(-1)?.message,
      "Changes saved",
    );
  }));

test("queue quota is enforced atomically", () =>
  database(async (store) => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => create(store)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
    assert.equal((await store.list("alice")).items.length, 5);
  }));

test("publication recovery requires saved changes and confirmed cleanup", () =>
  database(async (store) => {
    const run = await create(store);
    const worker = randomUUID();
    await store.claim(worker);
    await store.checkpoint(run.id, worker, { status: "needs_attention" });
    await assert.rejects(store.claimPublication(run.id, randomUUID()));
    await store.pool.query(
      "UPDATE runs SET artifact=$2,base_sha=$3,cleanup_complete=true WHERE id=$1",
      [
        run.id,
        {
          repositoryId: 12,
          baseSha: "a".repeat(40),
          patch: "saved",
          result: { outcome: "changes", title: "Fix", summary: "Fix", verification: "Checked" },
        },
        "a".repeat(40),
      ],
    );
    const next = randomUUID();
    const recovered = await store.claimPublication(run.id, next);
    assert.equal(recovered.lease_owner, next);
    assert.equal(recovered.stage, "publishing");
    await assert.rejects(store.checkpoint(run.id, worker, { status: "succeeded" }));
    await assert.rejects(store.claimPublication(run.id, randomUUID()));
  }));
