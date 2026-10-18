import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { demoProjectName } from "../src/demo.js";
import { Store } from "../src/store.js";
import { hasValidPublicationEvidence } from "@herbie/loop/publish-patch";

const databaseUrl = process.env.HERBIE_TEST_DATABASE_URL;
const admin = new Pool({ connectionString: databaseUrl });
let store: Store;
let schema: string;
beforeEach(async () => {
  if (!databaseUrl) return;
  schema = `store_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  store = new Store(
    new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` }),
    Math.random,
    demoProjectName,
  );
  await store.migrate();
});
afterEach(async () => {
  if (!databaseUrl) return;
  await store.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => {
  await admin.end();
});
const integration = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !databaseUrl }, fn);
const input = () => ({ repository: `example/repo-${randomUUID()}`, prompt: "Fix arithmetic" });

integration(
  "migration removes old limits and preserves projects, artifacts, and request replays",
  async () => {
    await store.pool.query("ALTER TABLE projects DROP COLUMN name");
    await store.pool.query(
      "ALTER TABLE projects ADD COLUMN max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 5)",
    );
    await store.pool.query(
      "ALTER TABLE jobs DROP CONSTRAINT jobs_cycle_check, ADD CONSTRAINT jobs_cycle_check CHECK (cycle BETWEEN 1 AND 5)",
    );
    await store.pool.query("ALTER TABLE projects ALTER COLUMN test_command SET NOT NULL");
    const id = randomUUID();
    await store.pool.query(
      `INSERT INTO projects(id,owner_id,repository,prompt,test_command,max_attempts,mode,state)
    VALUES($1,'owner','example/repo','Legacy project','["npm","test"]',1,'live','queued')`,
      [id],
    );
    const unicodeId = randomUUID();
    await store.pool.query(
      `INSERT INTO projects(id,owner_id,repository,prompt,test_command,max_attempts,mode,state)
    VALUES($1,'owner','example/repo',$2,'["npm","test"]',1,'live','completed')`,
      [unicodeId, "[demo:fail] \n" + "🥁".repeat(130)],
    );
    const key = randomUUID();
    const legacyRequest = {
      repository: "example/repo",
      prompt: "Legacy project",
      testCommand: ["npm", "test"],
      maxAttempts: 1,
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ...legacyRequest, mode: "live" }))
      .digest("hex");
    await store.pool.query(
      "INSERT INTO project_requests(owner_id,request_key,fingerprint,project_id) VALUES($1,$2,$3,$4)",
      ["owner", key, fingerprint, id],
    );
    await store.migrate();
    await store.migrate();
    assert.equal((await store.getProject(unicodeId))?.name, "🥁".repeat(120));
    assert.equal((await store.getProject(unicodeId))?.state, "completed");
    const oldProject = await store.getProject(id);
    assert.equal(oldProject?.prompt, "Legacy project");
    assert.equal(oldProject?.name, "Legacy project");
    await store.renameProject(id, "owner", "Renamed legacy project");
    assert.ok(!("testCommand" in oldProject!));
    assert.ok(!("maxAttempts" in oldProject!));
    assert.equal(
      (
        await store.pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='projects' AND column_name='max_attempts'",
        )
      ).rowCount,
      0,
    );
    const request = { repository: "EXAMPLE/REPO", prompt: "Legacy project" };
    const replay = await store.createProject("owner", request, "live", key);
    assert.equal(replay.created, false);
    assert.equal(replay.project.id, id);
    for (const change of [{ prompt: "Different project" }, { repository: "example/other" }]) {
      await assert.rejects(
        store.createProject("owner", { ...request, ...change }, "live", key),
        /different request/,
      );
    }
    await assert.rejects(store.createProject("owner", request, "demo", key), /different request/);
    assert.ok((await store.createProject("owner", input(), "live", randomUUID())).created);
    assert.deepEqual(
      (await store.pool.query("SELECT test_command FROM projects WHERE id=$1", [id])).rows[0]
        .test_command,
      ["npm", "test"],
    );
    await store.editProjectPrompt(id, "owner", "Updated legacy project");
    await store.editProjectPrompt(id, "owner", "Updated again");
    assert.equal(
      (await store.createProject("owner", request, "live", key)).project.prompt,
      "Updated again",
    );
    await assert.rejects(
      store.createProject("owner", { ...request, prompt: "Updated again" }, "live", key),
      /different request/,
    );

    const baseCommit = "a".repeat(40),
      patch = Buffer.from("legacy patch");
    const evidence = {
      version: 2,
      repoUrl: "https://github.com/example/repo.git",
      baseCommit,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      goalCompleted: true,
      sandboxDeleted: true,
    };
    await store.pool.query("UPDATE projects SET state='needs_attention' WHERE id=$1", [id]);
    await store.pool.query(
      `INSERT INTO jobs(id,project_id,cycle,branch,stage,artifact) VALUES($1,$2,6,$3,'publishing',$4)`,
      [
        randomUUID(),
        id,
        `herbie/${id}`,
        JSON.stringify({
          baseCommit,
          patchBase64: patch.toString("base64"),
          testResult: { exitCode: 0, stdout: "passed", stderr: "" },
          verification: { ...evidence, testCommand: ["npm", "test"] },
        }),
      ],
    );
    const candidate = await store.publicationRetryCandidate(id, "owner");
    assert.ok(candidate && "job" in candidate && candidate.job.artifact);
    assert.deepEqual(candidate.job.artifact, { baseCommit, patch, verification: evidence });
    assert.ok(hasValidPublicationEvidence("example/repo", candidate.job.artifact));
  },
);

for (const paused of [false, true])
  integration(
    `saved artifact activity describes capture without claiming tests passed (paused: ${paused})`,
    async () => {
      const { project } = await store.createProject("owner", input(), "live", randomUUID());
      const job = await store.claim("worker");
      assert.ok(job);
      if (paused) await store.control(project.id, "owner", "pause");
      await store.saveArtifact(job.id, "worker", {
        baseCommit: "a".repeat(40),
        patch: Buffer.from("captured patch"),
      });
      const events = await store.events(project.id);
      assert.equal(
        events.at(-1)?.message,
        paused ? "Captured artifact held while paused" : "Captured artifact saved durably",
      );
    },
  );

integration(
  "projects survive a new store and creation replay is scoped to owner and exact payload",
  async () => {
    const owner = randomUUID();
    const request = input();
    const key = randomUUID();
    const first = await store.createProject(owner, request, "demo", key);
    assert.equal(first.created, true);
    assert.equal(first.project.state, "queued");
    const fresh = new Store(store.pool);
    assert.deepEqual(await fresh.getProject(first.project.id, owner), first.project);
    assert.equal(await fresh.getProject(first.project.id, "another-owner"), null);
    const replay = await fresh.createProject(owner, request, "demo", key);
    assert.equal(replay.created, false);
    assert.equal(replay.project.id, first.project.id);
    await assert.rejects(
      store.createProject(owner, { ...request, prompt: "different" }, "demo", key),
      /different request/,
    );
    const concurrent = await store.createProject("another-owner", request, "demo", key);
    assert.equal(concurrent.created, true);
    assert.notEqual(concurrent.project.id, first.project.id);
    assert.equal((await store.events(first.project.id)).length, 1);
  },
);

integration(
  "one worker claims work and a paused artifact resumes without repeating the attempt",
  async () => {
    const owner = randomUUID();
    const { project } = await store.createProject(owner, input(), "demo", randomUUID());
    const claimed = await Promise.all([store.claim("worker-a"), store.claim("worker-b")]);
    const job = claimed.find((candidate) => candidate !== null);
    assert.ok(job);
    assert.equal(claimed.filter((candidate) => candidate !== null).length, 1);
    assert.equal(job.project.attemptCount, 1);
    const worker = claimed[0] ? "worker-a" : "worker-b";
    const pausing = await store.control(project.id, owner, "pause");
    assert.equal(pausing.stopRequested, "pause");
    const changes = {
      pullRequestTitle: "Fix addition totals",
      pullRequestBody: "Fixed addition so totals include both operands. Arithmetic tests passed.",
      baseCommit: "abc",
      patch: Buffer.from("tested patch"),
      verification: {
        version: 3 as const,
        repoUrl: "https://github.com/example/repo",
        baseCommit: "abc",
        patchSha256: "sha256",
        goalCompleted: true,
        sandboxDeleted: true,
      },
    };
    const held = await store.saveArtifact(job.id, worker, {
      ...changes,
      verification: { ...changes.verification, goalCompleted: true, sandboxDeleted: true },
    });
    assert.equal(held.project.state, "paused");
    assert.equal(await store.beginPublication(job.id, worker), false);
    assert.equal(await store.claim("another-worker"), null);
    await store.control(project.id, owner, "resume");
    const resumed = await store.claim("another-worker");
    assert.ok(resumed);
    assert.equal(resumed.stage, "ready");
    assert.equal(resumed.project.attemptCount, 1);
    assert.deepEqual(resumed.artifact, changes);
    assert.equal(await store.beginPublication(resumed.id, "another-worker"), true);
    const published = await store.completePublication(resumed.id, "another-worker", {
      url: "https://github.com/example/repo/pull/1",
      number: 1,
      branch: resumed.branch,
    });
    assert.equal(published.state, "awaiting_review");
  },
);

integration(
  "expired attempts require attention and expired publications only reconcile",
  async () => {
    const owner = randomUUID();
    const { project } = await store.createProject(owner, input(), "demo", randomUUID());
    const running = await store.claim("lost-worker", 150);
    assert.ok(running);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(await store.heartbeat(running.id, "lost-worker"), false);
    assert.equal(await store.recoverExpired(), 1);
    assert.equal((await store.getProject(project.id))?.state, "needs_attention");
    assert.equal(await store.claim("restarted-worker"), null);
    await assert.rejects(
      store.saveArtifact(running.id, "lost-worker", {
        baseCommit: "abc",
        patch: Buffer.from("late"),
      }),
      /lease/,
    );
    await store.control(project.id, owner, "cancel");
    const next = await store.createProject(owner, input(), "demo", randomUUID());
    const publishing = await store.claim("publisher", 150);
    assert.ok(publishing);
    await store.saveArtifact(publishing.id, "publisher", {
      baseCommit: "abc",
      patch: Buffer.from("verified"),
    });
    await store.beginPublication(publishing.id, "publisher");
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(await store.recoverExpired(), 1);
    const resumed = await store.claim("restarted-worker");
    assert.ok(resumed);
    assert.equal(resumed.stage, "publishing");
    assert.equal(resumed.project.id, next.project.id);
    await assert.rejects(
      store.beginPublication(resumed.id, "restarted-worker"),
      /first publication/,
    );
    await store.publicationUncertain(
      resumed.id,
      "restarted-worker",
      "Remote publication outcome is not confirmed",
    );
    assert.equal((await store.getProject(next.project.id))?.state, "needs_attention");
    assert.equal(await store.claim("restarted-worker"), null);
  },
);

integration(
  "merge advances once beyond five iterations and close unmerged preserves a paused project",
  async () => {
    const owner = randomUUID();
    const { project } = await store.createProject(owner, input(), "demo", randomUUID());
    async function publish() {
      const job = await store.claim("worker");
      assert.ok(job);
      await store.saveArtifact(job.id, "worker", {
        baseCommit: "abc",
        patch: Buffer.from("tested"),
      });
      await store.beginPublication(job.id, "worker");
      await store.completePublication(job.id, "worker", {
        url: "https://github.com/example/repo/pull/1",
        number: 1,
        branch: job.branch,
      });
      return job;
    }
    const first = await publish();
    const reviewing = await store.reviewJobs("demo");
    assert.equal(reviewing.length, 1);
    assert.equal(reviewing[0]?.id, first.id);
    await store.control(project.id, owner, "pause");
    const merged = await store.reconcile(first.id, "merged");
    assert.equal(merged.state, "paused");
    assert.equal(merged.pullRequest?.state, "merged");
    await store.reconcile(first.id, "merged");
    assert.equal(await store.claim("worker"), null);
    await store.control(project.id, owner, "resume");
    for (let count = 2; count <= 7; count++) {
      const job = await publish();
      const next = await store.reconcile(job.id, "merged");
      assert.equal(next.state, "queued");
      assert.equal(next.attemptCount, count);
      await store.reconcile(job.id, "merged");
      assert.equal(
        (
          await store.pool.query(
            "SELECT count(*)::int AS count FROM jobs WHERE project_id=$1 AND stage='queued'",
            [project.id],
          )
        ).rows[0].count,
        1,
      );
    }
    const unmerged = await publish();
    await store.control(unmerged.project.id, owner, "pause");
    assert.equal((await store.reconcile(unmerged.id, "closed")).state, "paused");
    assert.equal(await store.claim("worker"), null);
  },
);

integration(
  "concurrent replay creates one project and distinct requests share a repository",
  async () => {
    const owner = randomUUID();
    const request = input();
    const key = randomUUID();
    const repeated = await Promise.all(
      Array.from({ length: 6 }, () => store.createProject(owner, request, "demo", key)),
    );
    assert.equal(repeated.filter((result) => result.created).length, 1);
    assert.equal(new Set(repeated.map((result) => result.project.id)).size, 1);
    const first = repeated[0];
    assert.ok(first);
    assert.equal((await store.events(first.project.id)).length, 1);
    const repository = input().repository;
    const competing = await Promise.all([
      store.createProject("owner-a", { ...input(), repository }, "demo", randomUUID()),
      store.createProject(
        "owner-b",
        { ...input(), repository: repository.toUpperCase() },
        "demo",
        randomUUID(),
      ),
    ]);
    assert.ok(competing.every((result) => result.created));
    assert.equal(new Set(competing.map((result) => result.project.id)).size, 2);
  },
);

integration(
  "same-repository projects execute independently and keep multiple pull requests open",
  async () => {
    const owner = randomUUID();
    const request = input();
    const { project: first } = await store.createProject(owner, request, "demo", randomUUID());
    const { project: second } = await store.createProject(
      owner,
      { ...request, repository: request.repository.toUpperCase() },
      "demo",
      randomUUID(),
    );
    const workers = ["worker-a", "worker-b"];
    const claimed = await Promise.all(workers.map((worker) => store.claim(worker)));
    assert.deepEqual(
      new Set(claimed.map((job) => job?.project.id)),
      new Set([first.id, second.id]),
    );
    for (const [index, job] of claimed.entries()) {
      assert.ok(job);
      const worker = workers[index]!;
      await store.saveArtifact(job.id, worker, { baseCommit: "abc", patch: Buffer.from("tested") });
      await store.beginPublication(job.id, worker);
      await store.completePublication(job.id, worker, {
        url: `https://github.com/example/repo/pull/${index + 1}`,
        number: index + 1,
        branch: job.branch,
      });
    }
    assert.equal((await store.reviewJobs()).length, 2);
    const firstJob = claimed.find((job) => job?.project.id === first.id);
    assert.ok(firstJob);
    await store.reconcile(firstJob.id, "merged");
    assert.equal((await store.getProject(second.id))?.state, "awaiting_review");
  },
);

integration(
  "repeated cancellation fences an in-flight worker and retains its artifact separately",
  async () => {
    const owner = randomUUID();
    const { project } = await store.createProject(owner, input(), "demo", randomUUID());
    const job = await store.claim("worker");
    assert.ok(job);
    await store.control(project.id, owner, "cancel");
    await store.control(project.id, owner, "cancel");
    await assert.rejects(store.control(project.id, owner, "resume"), /cancelled/);
    const changes = { baseCommit: "abc", patch: Buffer.from("retain me") };
    await assert.rejects(store.saveArtifact(job.id, "worker", changes), /lease/);
    assert.equal(await store.finishCancelled(job.id, "worker", "complete", changes), true);
    assert.equal((await store.getProject(project.id))?.cleanupStatus, "complete");
    assert.ok(
      (await store.pool.query("SELECT artifact FROM jobs WHERE id=$1", [job.id])).rows[0].artifact,
    );
    assert.equal(await store.beginPublication(job.id, "worker"), false);
    await store.control(project.id, owner, "cancel");
    assert.equal(await store.claim("worker"), null);
    assert.equal(
      (await store.events(project.id)).filter((event) => event.type === "cancel").length,
      1,
    );
    const replacement = await store.createProject(owner, input(), "demo", randomUUID());
    await store.control(replacement.project.id, owner, "cancel");
    assert.equal(await store.claim("worker"), null);
  },
);

integration(
  "failed work releases its repository and workers cannot claim another adapter mode",
  async () => {
    const owner = randomUUID();
    const request = input();
    const { project } = await store.createProject(owner, request, "live", randomUUID());
    assert.equal(await store.claim("demo-worker", 30_000, "demo"), null);
    const job = await store.claim("live-worker", 30_000, "live");
    assert.ok(job);
    await assert.rejects(store.fail(job.id, "wrong-worker", "bad worker"), /lease/);
    await store.fail(job.id, "live-worker", "Repository tests failed");
    const failed = await store.getProject(project.id);
    assert.equal(failed?.state, "failed");
    assert.equal(failed.error, "Repository tests failed");
    const replacement = await store.createProject(owner, request, "live", randomUUID());
    assert.notEqual(replacement.project.id, project.id);
    assert.equal((await store.listProjects(owner)).length, 2);
    const events = await store.events(project.id);
    const lastEvent = events.at(-1);
    assert.ok(lastEvent);
    assert.equal(lastEvent.type, "failed");
    assert.deepEqual(await store.events(project.id, lastEvent.id), []);
  },
);

integration(
  "event logs remain numerically ordered past ten events and cursor pages preserve that order",
  async () => {
    const { project } = await store.createProject(randomUUID(), input(), "demo", randomUUID());
    for (const message of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"])
      await store.appendEvent(project.id, "attempt", message);
    assert.deepEqual(
      (await store.events(project.id)).map((event) => event.id),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
    assert.deepEqual(
      (await store.events(project.id, 8)).map((event) => event.id),
      [9, 10, 11, 12],
    );
  },
);

integration(
  "names persist independently of prompts and original create requests survive renames",
  async () => {
    const owner = randomUUID(),
      key = randomUUID();
    const request = { ...input(), name: "  Arithmetic cleanup  " };
    const { project } = await store.createProject(owner, request, "demo", key);
    assert.equal(project.name, "Arithmetic cleanup");
    await assert.rejects(
      store.renameProject(project.id, "another-owner", "Private rename"),
      /Project not found/,
    );
    for (const name of ["", "   ", "x".repeat(121)]) {
      await assert.rejects(store.renameProject(project.id, owner, name));
    }
    await assert.rejects(
      store.createProject(owner, { ...request, name: "x".repeat(121) }, "demo", randomUUID()),
    );
    const renamed = await store.renameProject(project.id, owner, "  Better arithmetic  ");
    assert.equal(renamed.name, "Better arithmetic");
    assert.equal(renamed.prompt, project.prompt);
    assert.equal(renamed.state, project.state);
    assert.equal(renamed.attemptCount, 0);
    assert.equal((await new Store(store.pool).listProjects(owner))[0]?.name, "Better arithmetic");
    const replay = await store.createProject(owner, request, "demo", key);
    assert.equal(replay.created, false);
    assert.equal(replay.project.name, "Better arithmetic");
    for (const name of ["Different name", "Better arithmetic", undefined]) {
      await assert.rejects(
        store.createProject(owner, { ...request, name }, "demo", key),
        /different request/,
      );
    }
    await store.control(project.id, owner, "cancel");
    await assert.rejects(
      store.renameProject(project.id, owner, "Finished work"),
      /Cancelled projects cannot be edited/,
    );
  },
);

integration("omitted names use the brief and replay after renaming", async () => {
  const owner = randomUUID(),
    key = randomUUID();
  const request = { ...input(), prompt: "[demo:fail] " + "a".repeat(150) };
  const { project } = await store.createProject(owner, request, "demo", key);
  assert.equal(project.name, "a".repeat(120));
  await store.renameProject(project.id, owner, "Short name");
  assert.equal((await store.createProject(owner, request, "demo", key)).project.name, "Short name");
});

integration(
  "concurrent naming creates one project and replays preserve renames without calling the model",
  async () => {
    const prompts: string[] = [];
    const namedStore = new Store(store.pool, Math.random, async (prompt) => {
      prompts.push(prompt);
      return "Arithmetic cleanup";
    });
    const owner = randomUUID(),
      key = randomUUID(),
      request = { ...input(), name: "   " };
    const results = await Promise.all(
      Array.from({ length: 3 }, () => namedStore.createProject(owner, request, "live", key)),
    );
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(results.find((result) => result.created)?.project.name, "Arithmetic cleanup");
    assert.ok(results.every((result) => result.project.prompt === request.prompt));
    assert.ok(prompts.length >= 1);
    assert.ok(prompts.every((prompt) => prompt === request.prompt));
    const namingCalls = prompts.length;
    const project = results[0]!.project;
    await namedStore.renameProject(project.id, owner, "My new name");
    assert.equal(
      (await namedStore.createProject(owner, { ...request, name: undefined }, "live", key)).project
        .name,
      "My new name",
    );
    await assert.rejects(
      namedStore.createProject(owner, { ...request, prompt: "Different task" }, "live", key),
      /different request/,
    );
    const explicit = await namedStore.createProject(
      owner,
      { ...request, name: " My own name " },
      "live",
      randomUUID(),
    );
    assert.equal(explicit.project.name, "My own name");
    assert.equal(prompts.length, namingCalls);
  },
);

integration(
  "slow naming leaves the only database connection available and creates no partial project",
  async () => {
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<string>();
    const pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 1,
      connectionTimeoutMillis: 500,
    });
    const namedStore = new Store(pool, Math.random, async () => {
      started.resolve();
      return release.promise;
    });
    const owner = randomUUID(),
      key = randomUUID();
    const pending = namedStore.createProject(owner, input(), "live", key);
    try {
      await started.promise;
      assert.deepEqual(await namedStore.listProjects(owner), []);
      assert.equal(
        (await pool.query("SELECT project_id FROM project_requests WHERE owner_id=$1", [owner]))
          .rowCount,
        0,
      );
      release.resolve("Arithmetic cleanup");
      const result = await pending;
      assert.equal(result.project.name, "Arithmetic cleanup");
      assert.equal(
        (await store.pool.query("SELECT id FROM jobs WHERE project_id=$1", [result.project.id]))
          .rowCount,
        1,
      );
    } finally {
      release.resolve("Arithmetic cleanup");
      try {
        await pending;
      } finally {
        await pool.end();
      }
    }
  },
);

integration("naming failures leave no project or request and allow a clean retry", async () => {
  for (const nameProject of [
    async () => {
      throw new Error("Naming unavailable");
    },
    async () => "",
    undefined,
  ]) {
    const owner = randomUUID(),
      key = randomUUID(),
      request = input();
    const namedStore = new Store(store.pool, Math.random, nameProject);
    await assert.rejects(namedStore.createProject(owner, request, "live", key));
    assert.deepEqual(await store.listProjects(owner), []);
    assert.equal(
      (await store.pool.query("SELECT project_id FROM project_requests WHERE owner_id=$1", [owner]))
        .rowCount,
      0,
    );
    const retry = new Store(store.pool, Math.random, async () => "Arithmetic cleanup");
    const result = await retry.createProject(owner, request, "live", key);
    assert.equal(result.created, true);
    assert.equal(result.project.name, "Arithmetic cleanup");
    assert.equal((await retry.createProject(owner, request, "live", key)).created, false);
    assert.equal(
      (await store.pool.query("SELECT id FROM jobs WHERE project_id=$1", [result.project.id]))
        .rowCount,
      1,
    );
  }
});

for (const named of [false, true])
  integration(
    `pre-removal create requests still replay after renaming (named: ${named})`,
    async () => {
      for (const maxAttempts of [1, 2, 3, 4, 5]) {
        const request = { ...input(), ...(named ? { name: "Original name" } : {}) };
        const key = randomUUID();
        const { project } = await store.createProject("owner", request, "demo", key);
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              repository: request.repository,
              prompt: request.prompt,
              maxAttempts,
              mode: "demo",
              ...(named ? { name: "Original name" } : {}),
            }),
          )
          .digest("hex");
        await store.pool.query("UPDATE project_requests SET fingerprint=$1 WHERE project_id=$2", [
          fingerprint,
          project.id,
        ]);
        await store.renameProject(project.id, "owner", "Renamed project");
        await store.migrate();
        const replay = await store.createProject("owner", request, "demo", key);
        assert.equal(replay.created, false);
        assert.equal(replay.project.id, project.id);
        await assert.rejects(
          store.createProject("owner", { ...request, prompt: "Different" }, "demo", key),
          /different request/,
        );
        await assert.rejects(
          store.createProject("owner", { ...request, name: "Renamed project" }, "demo", key),
          /different request/,
        );
      }
    },
  );

async function publishNext(number: number) {
  const job = await store.claim("worker");
  assert.ok(job);
  await store.saveArtifact(job.id, "worker", { baseCommit: "abc", patch: Buffer.from("captured") });
  assert.equal(await store.beginPublication(job.id, "worker"), true);
  await store.completePublication(job.id, "worker", {
    url: `https://github.com/example/repo/pull/${number}`,
    number,
    branch: job.branch,
  });
  return job;
}

integration(
  "targetWip fills capacity, survives restart, and replenishes each merge exactly once",
  async () => {
    const request = { ...input(), targetWip: 2 };
    const key = randomUUID();
    const { project } = await store.createProject("owner", request, "demo", key);
    await assert.rejects(
      store.createProject("owner", { ...request, targetWip: 3 }, "demo", key),
      /different request/,
    );
    const first = await publishNext(1);
    const second = await publishNext(2);
    store = new Store(store.pool);
    const full = await store.getProject(project.id);
    assert.equal(full?.targetWip, 2);
    assert.equal(full?.state, "awaiting_review");
    assert.equal(full?.pullRequests.length, 2);
    assert.equal((await store.listProjects("owner"))[0]?.pullRequests.length, 2);
    assert.equal(await store.claim("overflow"), null);
    // Older and newer PRs can merge together, with repeated delivery.
    await Promise.all([
      store.reconcile(second.id, "merged"),
      store.reconcile(first.id, "merged"),
      store.reconcile(first.id, "merged"),
    ]);
    const claimed = await Promise.all([store.claim("a"), store.claim("b")]);
    assert.equal(claimed.filter(Boolean).length, 1);
    const third = claimed.find((job) => job !== null)!;
    const worker = claimed[0] ? "a" : "b";
    assert.equal(third.project.attemptCount, 3);
    assert.equal(third.project.pullRequests.filter((pr) => pr.state === "merged").length, 2);
    await store.saveArtifact(third.id, worker, {
      baseCommit: "abc",
      patch: Buffer.from("captured"),
    });
    await store.beginPublication(third.id, worker);
    await store.completePublication(third.id, worker, {
      url: "https://github.com/example/repo/pull/3",
      number: 3,
      branch: third.branch,
    });
    const fourth = await publishNext(4);
    assert.equal(await store.claim("overflow"), null);
    await store.reconcile(third.id, "merged");
    const fifth = await publishNext(5);
    assert.equal(await store.claim("full"), null);
    await store.reconcile(fifth.id, "merged");
    const sixth = await publishNext(6);
    assert.equal(sixth.project.attemptCount, 6);
    assert.equal((await store.getProject(project.id))?.state, "awaiting_review");
    await store.control(project.id, "owner", "pause");
    await store.reconcile(fourth.id, "merged");
    await store.reconcile(sixth.id, "merged");
    const paused = await store.getProject(project.id);
    assert.equal(paused?.state, "paused");
    assert.ok(paused?.pullRequests.every((pr) => pr.state === "merged"));
    assert.equal(await store.claim("paused"), null);
    await store.control(project.id, "owner", "resume");
    const seventh = await publishNext(7);
    assert.equal(seventh.project.attemptCount, 7);
    await store.control(project.id, "owner", "cancel");
    assert.equal(await store.claim("cancelled"), null);
  },
);

integration(
  "a merge during an attempt preserves its reservation and a requested pause",
  async () => {
    const { project } = await store.createProject(
      "owner",
      { ...input(), targetWip: 2 },
      "demo",
      randomUUID(),
    );
    const first = await publishNext(1);
    const second = await store.claim("worker");
    assert.ok(second);
    await store.control(project.id, "owner", "pause");
    const merged = await store.reconcile(first.id, "merged");
    assert.equal(merged.state, "running");
    assert.equal(merged.stopRequested, "pause");
    assert.equal(await store.claim("extra"), null);
    await store.saveArtifact(second.id, "worker", {
      baseCommit: "abc",
      patch: Buffer.from("held"),
    });
    assert.equal((await store.getProject(project.id))?.state, "paused");
    assert.equal(await store.beginPublication(second.id, "worker"), false);
    await store.control(project.id, "owner", "resume");
    const resumed = await store.claim("worker");
    assert.equal(resumed?.id, second.id);
    assert.equal(resumed?.project.attemptCount, 2);
    await store.beginPublication(second.id, "worker");
    await store.completePublication(second.id, "worker", {
      url: "https://github.com/example/repo/pull/2",
      number: 2,
      branch: second.branch,
    });
    await publishNext(3);
    assert.equal(await store.claim("overflow"), null);
  },
);

integration(
  "closing an older PR pauses after the active attempt and preserves resumable work",
  async () => {
    const { project } = await store.createProject(
      "owner",
      { ...input(), targetWip: 3 },
      "demo",
      randomUUID(),
    );
    const first = await publishNext(1);
    await publishNext(2);
    const third = await store.claim("worker");
    assert.ok(third);
    const pausing = await store.reconcile(first.id, "closed");
    assert.equal(pausing.state, "running");
    assert.equal(pausing.stopRequested, "pause");
    assert.equal(pausing.cleanupStatus, "not_required");
    assert.deepEqual(
      pausing.pullRequests.map((pr) => pr.state),
      ["closed", "open"],
    );
    assert.equal(await store.heartbeat(third.id, "worker"), true);
    await store.saveArtifact(third.id, "worker", { baseCommit: "abc", patch: Buffer.from("held") });
    assert.equal((await store.getProject(project.id))?.state, "paused");
    assert.equal(await store.beginPublication(third.id, "worker"), false);
    assert.equal(await store.claim("extra"), null);
    await store.control(project.id, "owner", "resume");
    const resumed = await store.claim("worker");
    assert.equal(resumed?.id, third.id);
    assert.equal(resumed?.project.attemptCount, 3);
    assert.equal(resumed?.artifact?.patch.toString(), "held");
  },
);

integration("closing a sibling PR holds a saved artifact and releases it for resume", async () => {
  const { project } = await store.createProject(
    "owner",
    { ...input(), targetWip: 2 },
    "demo",
    randomUUID(),
  );
  const first = await publishNext(1);
  const second = await store.claim("worker");
  assert.ok(second);
  await store.saveArtifact(second.id, "worker", { baseCommit: "abc", patch: Buffer.from("saved") });
  assert.equal((await store.reconcile(first.id, "closed")).state, "paused");
  assert.equal(await store.beginPublication(second.id, "worker"), false);
  await store.control(project.id, "owner", "resume");
  assert.equal((await store.claim("resumed"))?.id, second.id);
});

integration(
  "closing a sibling PR during publication pauses when publication finishes",
  async () => {
    const { project } = await store.createProject(
      "owner",
      { ...input(), targetWip: 2 },
      "demo",
      randomUUID(),
    );
    const first = await publishNext(1);
    const second = await store.claim("worker");
    assert.ok(second);
    await store.saveArtifact(second.id, "worker", {
      baseCommit: "abc",
      patch: Buffer.from("saved"),
    });
    await store.beginPublication(second.id, "worker");
    assert.equal((await store.reconcile(first.id, "closed")).stopRequested, "pause");
    const paused = await store.completePublication(second.id, "worker", {
      url: "https://github.com/example/repo/pull/2",
      number: 2,
      branch: second.branch,
    });
    assert.equal(paused.state, "paused");
    assert.equal(await store.claim("extra"), null);
    await store.control(project.id, "owner", "resume");
    assert.ok(await store.claim("worker"));
  },
);

integration("a sibling merge preserves the closure pause until publication finishes", async () => {
  const { project } = await store.createProject(
    "owner",
    { ...input(), targetWip: 3 },
    "demo",
    randomUUID(),
  );
  const first = await publishNext(1);
  const second = await publishNext(2);
  const third = await store.claim("worker");
  assert.ok(third);
  await store.saveArtifact(third.id, "worker", { baseCommit: "abc", patch: Buffer.from("saved") });
  await store.beginPublication(third.id, "worker");
  await store.reconcile(first.id, "closed");
  const merging = await store.reconcile(second.id, "merged");
  assert.equal(merging.stopRequested, "pause");
  const after = await store.completePublication(third.id, "worker", {
    url: "https://github.com/example/repo/pull/3",
    number: 3,
    branch: third.branch,
  });
  assert.equal(after.state, "paused");
  assert.equal(await store.claim("extra"), null);
  await store.control(project.id, "owner", "resume");
  assert.ok(await store.claim("worker"));
});

for (const recovery of ["uncertain", "expired", "blocked"] as const)
  integration(`closure pause survives ${recovery} publication recovery`, async () => {
    const { project } = await store.createProject(
      "owner",
      { ...input(), name: "Recovery fixture", targetWip: 2 },
      "live",
      randomUUID(),
    );
    const first = await publishNext(1);
    const second = await store.claim("worker");
    assert.ok(second);
    const patch = Buffer.from("saved");
    const baseCommit = "a".repeat(40);
    await store.saveArtifact(second.id, "worker", {
      baseCommit,
      patch,
      verification: {
        version: 3,
        repoUrl: `https://github.com/${project.repository}.git`,
        baseCommit,
        patchSha256: createHash("sha256").update(patch).digest("hex"),
        goalCompleted: true,
        sandboxDeleted: true,
      },
    });
    await store.beginPublication(second.id, "worker");
    await store.reconcile(first.id, "closed");
    if (recovery === "expired") {
      await store.pool.query(
        "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [second.id],
      );
      await store.recoverExpired();
    } else if (recovery === "blocked") {
      await store.blockPublication(second.id, "worker", "fixture safety conflict");
      assert.equal(await store.claim("extra"), null);
      assert.equal((await store.publicationRetryCandidate(project.id, "owner"))?.kind, "retryable");
      const held = await store.queueSavedPublication(second.id, "owner", second.branch, baseCommit);
      assert.equal(held.state, "paused");
      assert.equal(await store.claim("extra"), null);
      await store.control(project.id, "owner", "resume");
    } else {
      await store.publicationUncertain(second.id, "worker", "fixture uncertain");
      await store.pool.query("UPDATE jobs SET eligible_at=clock_timestamp() WHERE id=$1", [
        second.id,
      ]);
    }
    const resumed = await store.claim("recovery");
    assert.equal(resumed?.id, second.id);
    if (recovery === "blocked") await store.beginPublication(second.id, "recovery");
    else assert.equal(resumed?.project.stopRequested, "pause");
    const after = await store.completePublication(second.id, "recovery", {
      url: "https://github.com/example/repo/pull/2",
      number: 2,
      branch: second.branch,
    });
    assert.equal(after.state, recovery === "blocked" ? "queued" : "paused");
    assert.equal(after.attemptCount, 2);
    if (recovery !== "blocked") assert.equal(await store.claim("extra"), null);
  });

integration(
  "closing a PR pauses a project until resumed and repeated reconciliation is harmless",
  async () => {
    const { project } = await store.createProject("owner", input(), "demo", randomUUID());
    const first = await publishNext(1);
    assert.equal((await store.reconcile(first.id, "closed")).state, "paused");
    assert.equal(await store.claim("extra"), null);
    const events = await store.events(project.id);
    assert.equal(
      events.at(-1)?.message,
      "Pull request closed without merging; project pause requested",
    );
    assert.equal(
      events.some((event) => event.type === "cancel"),
      false,
    );
    await store.control(project.id, "owner", "resume");
    assert.equal((await store.reconcile(first.id, "closed")).state, "queued");
    const next = await store.claim("worker");
    assert.ok(next);
    assert.notEqual(next.id, first.id);
  },
);

integration(
  "merges still reconcile during failure or publication recovery without clearing the stop",
  async () => {
    for (const stage of ["failure", "publication"] as const) {
      const { project } = await store.createProject(
        "owner",
        { ...input(), targetWip: 2 },
        "demo",
        randomUUID(),
      );
      const first = await publishNext(1);
      const second = await store.claim("worker");
      assert.ok(second);
      if (stage === "failure") await store.fail(second.id, "worker", "fixture failure");
      else {
        await store.saveArtifact(second.id, "worker", {
          baseCommit: "abc",
          patch: Buffer.from("captured"),
        });
        await store.beginPublication(second.id, "worker");
        await store.publicationUncertain(second.id, "worker", "fixture uncertain");
      }
      const before = await store.getProject(project.id);
      assert.ok((await store.reviewJobs()).some((job) => job.id === first.id));
      const after = await store.reconcile(first.id, "merged");
      assert.equal(after.state, before?.state);
      assert.equal(after.error, before?.error);
      assert.equal(after.pullRequests[0]?.state, "merged");
      assert.equal((await store.events(project.id)).at(-1)?.message, "Pull request merged");
      assert.equal(await store.claim("extra"), null);
    }
  },
);

integration(
  "migration backfills existing PRs and defaults WIP to one without losing history",
  async () => {
    const { project } = await store.createProject("owner", input(), "demo", randomUUID());
    const first = await publishNext(1);
    await store.pool.query("DROP TRIGGER IF EXISTS notify_project_change ON jobs");
    await store.pool.query("ALTER TABLE jobs DROP COLUMN pull_request");
    await store.pool.query("ALTER TABLE projects DROP COLUMN max_wip");
    await store.migrate();
    await store.migrate();
    const migrated = await store.getProject(project.id);
    assert.equal(migrated?.targetWip, 1);
    assert.deepEqual(migrated?.pullRequests, [migrated?.pullRequest]);
    assert.equal(await store.claim("full"), null);
    await store.reconcile(first.id, "merged");
    const second = await publishNext(2);
    await store.migrate();
    const history = await store.getProject(project.id);
    assert.deepEqual(
      history?.pullRequests.map((pr) => pr.state),
      ["merged", "open"],
    );
    await store.reconcile(second.id, "merged");
    assert.equal((await store.getProject(project.id))?.state, "queued");
  },
);

for (const outcome of ["merged", "closed"] as const)
  integration(
    `published sibling PRs still record ${outcome} after cancellation without restarting work`,
    async () => {
      const { project } = await store.createProject(
        "owner",
        { ...input(), targetWip: 2 },
        "demo",
        randomUUID(),
      );
      const first = await publishNext(1);
      const second = await publishNext(2);
      await store.control(project.id, "owner", "cancel");
      await store.reconcile(first.id, "closed");
      assert.equal((await store.getProject(project.id))?.state, "cancelled");
      assert.deepEqual(
        (await store.reviewJobs()).map((job) => job.id),
        [second.id],
      );
      const updated = await store.reconcile(second.id, outcome);
      assert.equal(updated.state, "cancelled");
      assert.deepEqual(
        updated.pullRequests.map((pr) => pr.state),
        ["closed", outcome],
      );
      const events = await store.events(project.id);
      await store.reconcile(second.id, outcome);
      assert.deepEqual(await store.events(project.id), events);
      assert.equal(events.filter((event) => event.type === "cancel").length, 1);
      assert.equal(
        events.at(-1)?.type,
        outcome === "merged" ? "pull_request_merged" : "pull_request_closed",
      );
      assert.equal(await store.claim("extra"), null);
      assert.deepEqual(await store.reviewJobs(), []);
    },
  );

integration(
  "a draining older coordinator can publish and reconcile after the PR backfill",
  async () => {
    const { project } = await store.createProject("owner", input(), "demo", randomUUID());
    const job = await store.claim("old-worker");
    assert.ok(job);
    await store.migrate();
    // The pre-upgrade worker writes only the project's PR column after migrations ran.
    const pr = {
      url: "https://github.com/example/repo/pull/1",
      number: 1,
      branch: job.branch,
      state: "open",
    };
    await store.pool.query(
      "UPDATE jobs SET stage='awaiting_review',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [job.id],
    );
    await store.pool.query(
      "UPDATE projects SET state='awaiting_review',pull_request=$2 WHERE id=$1",
      [project.id, JSON.stringify(pr)],
    );
    assert.deepEqual((await store.getProject(project.id))?.pullRequests, [pr]);
    assert.deepEqual(
      (await store.reviewJobs()).map((job) => job.id),
      [job.id],
    );
    // An old coordinator may also observe the merge while it is draining.
    const merged = { ...pr, state: "merged" };
    await store.pool.query("UPDATE jobs SET stage='completed' WHERE id=$1", [job.id]);
    await store.pool.query("UPDATE projects SET pull_request=$2 WHERE id=$1", [
      project.id,
      JSON.stringify(merged),
    ]);
    assert.deepEqual((await store.getProject(project.id))?.pullRequests, [merged]);
    await store.migrate();
    assert.deepEqual((await store.getProject(project.id))?.pullRequests, [merged]);
  },
);

integration(
  "prompt edits persist, preserve request replays, and apply to subsequent claims",
  async () => {
    const owner = randomUUID(),
      key = randomUUID(),
      request = { ...input(), targetWip: 2 };
    const { project } = await store.createProject(owner, request, "demo", key);
    await assert.rejects(
      store.editProjectPrompt(project.id, "another-owner", "Private edit"),
      /Project not found/,
    );
    for (const prompt of ["", "   ", "x".repeat(8001)])
      await assert.rejects(store.editProjectPrompt(project.id, owner, prompt));
    const edited = await store.editProjectPrompt(project.id, owner, "  Updated instructions  ");
    assert.equal(edited.prompt, "Updated instructions");
    assert.equal(edited.name, project.name);
    assert.equal(edited.state, project.state);
    assert.equal(edited.attemptCount, 0);
    assert.equal((await new Store(store.pool).getProject(project.id))?.prompt, edited.prompt);
    const replay = await store.createProject(owner, request, "demo", key);
    assert.equal(replay.created, false);
    assert.equal(replay.project.prompt, edited.prompt);
    await assert.rejects(
      store.createProject(owner, { ...request, prompt: edited.prompt }, "demo", key),
      /different request/,
    );
    const job = await store.claim("worker");
    assert.ok(job);
    assert.equal(job.project.prompt, edited.prompt);
    const running = await store.editProjectPrompt(
      project.id,
      owner,
      "Instructions for the next attempt",
    );
    assert.equal(running.state, "running");
    assert.equal(job.project.prompt, edited.prompt);
    await store.saveArtifact(job.id, "worker", {
      baseCommit: "abc",
      patch: Buffer.from("saved work"),
    });
    await store.beginPublication(job.id, "worker");
    await store.completePublication(job.id, "worker", {
      url: "https://github.com/example/repo/pull/1",
      number: 1,
      branch: job.branch,
    });
    assert.equal((await store.claim("next-worker"))?.project.prompt, running.prompt);
    await store.control(project.id, owner, "cancel");
    await assert.rejects(
      store.editProjectPrompt(project.id, owner, "Final instructions"),
      /Cancelled projects cannot be edited/,
    );
    assert.equal((await store.getProject(project.id))?.prompt, running.prompt);
  },
);

integration(
  "project settings update atomically and WIP changes respect existing and paused work",
  async () => {
    const request = input(),
      key = randomUUID();
    const { project } = await store.createProject("owner", request, "demo", key);
    await assert.rejects(
      store.updateProject(project.id, "other", { name: "Private edit" }),
      /Project not found/,
    );
    await assert.rejects(
      store.updateProject(project.id, "owner", {
        name: "Changed",
        prompt: "Changed",
        targetWip: 0,
      }),
    );
    assert.deepEqual(await store.getProject(project.id), project);
    const first = await publishNext(1);
    assert.equal(await store.claim("worker"), null);
    const edited = await store.updateProject(project.id, "owner", {
      name: "New name",
      prompt: "New prompt",
      model: "custom-model",
      targetWip: 2,
    });
    assert.equal(edited.name, "New name");
    assert.equal(edited.prompt, "New prompt");
    assert.equal(edited.model, "custom-model");
    assert.equal((await store.getProject(project.id))?.model, "custom-model");
    assert.equal(edited.state, "queued");
    // Reducing capacity must also hold work already queued under the higher limit.
    await store.updateProject(project.id, "owner", { targetWip: 1 });
    assert.equal(await store.claim("worker"), null);
    await store.reconcile(first.id, "merged");
    const running = await store.claim("worker");
    assert.ok(running);
    assert.equal(running.project.prompt, "New prompt");
    await store.control(project.id, "owner", "pause");
    await store.saveArtifact(running.id, "worker", {
      baseCommit: "abc",
      patch: Buffer.from("saved"),
    });
    assert.equal(
      (await store.updateProject(project.id, "owner", { targetWip: 3 })).state,
      "paused",
    );
    assert.equal(await store.claim("worker"), null);
    await store.control(project.id, "owner", "cancel");
    await assert.rejects(
      store.updateProject(project.id, "owner", { targetWip: 4 }),
      /Cancelled projects cannot be edited/,
    );
    assert.equal((await store.createProject("owner", request, "demo", key)).project.targetWip, 3);
  },
);

integration("project models persist and participate in idempotency", async () => {
  const request = { ...input(), model: "custom-model" };
  const key = randomUUID();
  const { project } = await store.createProject("owner", request, "demo", key);
  assert.equal(project.model, "custom-model");
  assert.equal((await store.getProject(project.id))?.model, "custom-model");
  assert.equal((await store.createProject("owner", request, "demo", key)).created, false);
  await assert.rejects(
    store.createProject("owner", { ...request, model: "another-model" }, "demo", key),
    /Idempotency key/,
  );
});

integration(
  "project reasoning effort persists, updates, and participates in idempotency",
  async () => {
    const request = { ...input(), reasoningEffort: "high" };
    const key = randomUUID();
    const { project } = await store.createProject("owner", request, "demo", key);
    assert.equal(project.reasoningEffort, "high");
    assert.equal((await store.getProject(project.id))?.reasoningEffort, "high");
    assert.equal((await store.createProject("owner", request, "demo", key)).created, false);
    await assert.rejects(
      store.createProject("owner", { ...request, reasoningEffort: "low" }, "demo", key),
      /Idempotency key/,
    );
    const updated = await store.updateProject(project.id, "owner", { reasoningEffort: "medium" });
    assert.equal(updated.reasoningEffort, "medium");
  },
);

integration(
  "resource settings persist, reset to defaults, and participate in request identity",
  async () => {
    const resources = { cpu: 4, memory: 8, disk: 10 };
    const request = { ...input(), resources };
    const key = randomUUID();
    const { project } = await store.createProject("owner", request, "demo", key);
    assert.deepEqual(project.resources, resources);
    await assert.rejects(
      store.createProject(
        "owner",
        { ...request, resources: { ...resources, memory: 4 } },
        "demo",
        key,
      ),
      /different request/,
    );
    assert.deepEqual(
      (await store.updateProject(project.id, "owner", { name: "Renamed" })).resources,
      resources,
    );
    assert.equal(
      (await store.updateProject(project.id, "owner", { resources: null })).resources,
      null,
    );
    assert.deepEqual(
      (await store.createProject("owner", request, "demo", key)).project.resources,
      null,
    );
    await assert.rejects(
      store.updateProject(project.id, "someone-else", { resources }),
      /not found/,
    );
  },
);

integration("a merge refills WIP while another run is still running", async () => {
  const { project } = await store.createProject(
    "owner",
    { ...input(), targetWip: 2 },
    "demo",
    randomUUID(),
  );
  const first = await publishNext(1);
  const second = await store.claim("second");
  assert.ok(second);
  await store.reconcile(first.id, "merged");
  await store.reconcile(first.id, "merged");
  const replacement = await store.claim("replacement");
  assert.ok(replacement, "merge must start a replacement without waiting for the running sibling");
  assert.equal(await store.claim("overflow"), null);
  assert.equal(
    (await store.getProject(project.id))?.attempts?.filter((run) => run.state === "running").length,
    2,
  );
});

integration(
  "polling refills legacy running projects and lowering WIP holds queued work",
  async () => {
    const { project } = await store.createProject(
      "owner",
      { ...input(), targetWip: 3 },
      "demo",
      randomUUID(),
    );
    assert.ok(await store.claim("first"));
    // Simulate an older coordinator that left only a running job behind.
    await store.pool.query("DELETE FROM jobs WHERE project_id=$1 AND stage='queued'", [project.id]);
    store = new Store(store.pool);
    assert.ok(await store.claim("second"));
    await store.updateProject(project.id, "owner", { targetWip: 1 });
    assert.equal(await store.claim("overflow"), null);
    assert.equal((await store.getProject(project.id))?.attemptCount, 2);
  },
);

integration("a failed run can retry using its queued WIP reservation", async () => {
  const { project } = await store.createProject(
    "owner",
    { ...input(), targetWip: 2 },
    "demo",
    randomUUID(),
  );
  const first = await store.claim("first");
  assert.ok(first);
  await store.fail(first.id, "first", "Failed before publication");
  assert.equal(await store.claim("stopped"), null);
  await store.retryAttempt(project.id, "owner");
  assert.ok(await store.claim("retry"));
});

integration("retry publishes a sibling's saved work after another run fails", async () => {
  const { project } = await store.createProject(
    "owner",
    { ...input(), targetWip: 2 },
    "demo",
    randomUUID(),
  );
  const first = await store.claim("first");
  const second = await store.claim("second");
  assert.ok(first && second);
  await store.fail(first.id, "first", "Implementation failed");
  await store.saveArtifact(second.id, "second", { baseCommit: "abc", patch: Buffer.from("saved") });
  await store.pool.query("UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [
    second.id,
  ]);
  assert.equal((await store.claim("saved"))?.id, second.id);
  assert.equal((await store.getProject(project.id))?.error, "Implementation failed");
  await store.retryAttempt(project.id, "owner");
  const resumed = await store.claim("resumed");
  assert.equal(resumed?.id, second.id);
  assert.equal(resumed?.artifact?.patch.toString(), "saved");
  assert.equal(await store.beginPublication(second.id, "resumed"), true);
});

integration("cancelling a failed project revokes its running sibling", async () => {
  const { project } = await store.createProject(
    "owner",
    { ...input(), targetWip: 2 },
    "demo",
    randomUUID(),
  );
  const first = await store.claim("first");
  const second = await store.claim("second");
  assert.ok(first && second);
  await store.fail(first.id, "first", "Implementation failed");
  assert.equal((await store.control(project.id, "owner", "cancel")).state, "cancelled");
  assert.equal(await store.heartbeat(second.id, "second"), false);
  assert.equal(await store.claim("extra"), null);
});

for (const blocked of [true, false])
  integration(
    `sibling publication preserves ${blocked ? "blocked" : "uncertain"} publication`,
    async () => {
      const { project } = await store.createProject(
        "owner",
        { ...input(), targetWip: 2 },
        "demo",
        randomUUID(),
      );
      const first = await store.claim("first");
      const second = await store.claim("second");
      assert.ok(first && second);
      for (const [job, worker] of [
        [first, "first"],
        [second, "second"],
      ] as const) {
        await store.saveArtifact(job.id, worker, {
          baseCommit: "abc",
          patch: Buffer.from("saved"),
        });
        await store.beginPublication(job.id, worker);
      }
      if (blocked) await store.blockPublication(first.id, "first", "Conflict");
      else await store.publicationUncertain(first.id, "first", "Unavailable");
      const before = await store.getProject(project.id);
      const after = await store.completePublication(second.id, "second", {
        url: "https://github.com/example/repo/pull/2",
        number: 2,
        branch: second.branch,
      });
      assert.equal(after.state, "needs_attention");
      assert.equal(after.error, before?.error);
      assert.equal(await store.claim("extra"), null);
    },
  );

integration("a failed sibling cannot strand uncertain publication recovery", async () => {
  const { project } = await store.createProject(
    "owner",
    { ...input(), targetWip: 2 },
    "demo",
    randomUUID(),
  );
  const first = await store.claim("first");
  const second = await store.claim("second");
  assert.ok(first && second);
  await store.saveArtifact(first.id, "first", { baseCommit: "abc", patch: Buffer.from("saved") });
  await store.beginPublication(first.id, "first");
  await store.publicationUncertain(first.id, "first", "Unavailable");
  await store.fail(second.id, "second", "Failed");
  assert.equal((await store.getProject(project.id))?.state, "needs_attention");
  await store.pool.query("UPDATE jobs SET eligible_at=clock_timestamp() WHERE id=$1", [first.id]);
  assert.equal((await store.claim("recovery"))?.id, first.id);
  await store.completePublication(first.id, "recovery", {
    url: "https://github.com/example/repo/pull/1",
    number: 1,
    branch: first.branch,
  });
  assert.equal((await store.getProject(project.id))?.state, "failed");
  assert.equal(await store.claim("extra"), null);
  await store.retryAttempt(project.id, "owner");
  assert.ok(await store.claim("retry"));
});

integration(
  "acknowledged interrupted history does not block a later publication recovery",
  async () => {
    const { project } = await store.createProject("owner", input(), "demo", randomUUID());
    const first = await store.claim("first");
    assert.ok(first);
    await store.fail(first.id, "first", "Interrupted", true);
    await store.retryAttempt(project.id, "owner");
    const retry = await store.claim("retry");
    assert.ok(retry);
    await store.saveArtifact(retry.id, "retry", { baseCommit: "abc", patch: Buffer.from("saved") });
    await store.beginPublication(retry.id, "retry");
    await store.publicationUncertain(retry.id, "retry", "Unavailable");
    await store.pool.query("UPDATE jobs SET eligible_at=clock_timestamp() WHERE id=$1", [retry.id]);
    assert.equal((await store.claim("recovery"))?.id, retry.id);
    const result = await store.completePublication(retry.id, "recovery", {
      url: "https://github.com/example/repo/pull/1",
      number: 1,
      branch: retry.branch,
    });
    assert.equal(result.state, "awaiting_review");
    assert.equal(result.attempts?.find((run) => run.id === first.id)?.state, "needs_attention");
  },
);

integration("retrying one publication preserves another blocked publication", async () => {
  const { project } = await store.createProject(
    "owner",
    { repository: "example/repo", prompt: "Work", targetWip: 2 },
    "live",
    randomUUID(),
  );
  const first = await store.claim("first");
  const second = await store.claim("second");
  assert.ok(first && second);
  const baseCommit = "a".repeat(40),
    patch = Buffer.from("saved");
  for (const [job, worker] of [
    [first, "first"],
    [second, "second"],
  ] as const) {
    await store.saveArtifact(job.id, worker, {
      baseCommit,
      patch,
      verification: {
        version: 2,
        repoUrl: "https://github.com/example/repo.git",
        baseCommit,
        patchSha256: createHash("sha256").update(patch).digest("hex"),
        goalCompleted: true,
        sandboxDeleted: true,
      },
    });
    await store.beginPublication(job.id, worker);
  }
  await store.blockPublication(first.id, "first", "First conflict");
  await store.blockPublication(second.id, "second", "Second conflict");
  assert.equal(
    (await store.queueSavedPublication(first.id, "owner", first.branch, baseCommit)).state,
    "needs_attention",
  );
  assert.equal((await store.claim("recovery"))?.id, first.id);
  await store.beginPublication(first.id, "recovery");
  await store.completePublication(first.id, "recovery", {
    url: "https://github.com/example/repo/pull/1",
    number: 1,
    branch: first.branch,
  });
  await store.reconcile(first.id, "merged");
  assert.equal((await store.getProject(project.id))?.state, "needs_attention");
  assert.equal(await store.claim("extra"), null);
});

for (const expired of [false, true])
  integration(
    `publication recovery keeps replenishment stopped until reconciled (expired: ${expired})`,
    async () => {
      const { project } = await store.createProject(
        "owner",
        { ...input(), targetWip: 2 },
        "demo",
        randomUUID(),
      );
      const first = await publishNext(1);
      const second = await store.claim("second");
      assert.ok(second);
      await store.saveArtifact(second.id, "second", {
        baseCommit: "abc",
        patch: Buffer.from("saved"),
      });
      await store.beginPublication(second.id, "second");
      if (expired) {
        await store.pool.query(
          "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [second.id],
        );
        await store.recoverExpired();
      } else await store.publicationUncertain(second.id, "second", "Unavailable");
      await store.reconcile(first.id, "merged");
      await store.pool.query("UPDATE jobs SET eligible_at=clock_timestamp() WHERE id=$1", [
        second.id,
      ]);
      assert.equal((await store.claim("recovery"))?.id, second.id);
      assert.equal((await store.getProject(project.id))?.state, "needs_attention");
      assert.equal(await store.claim("extra"), null);
      await store.completePublication(second.id, "recovery", {
        url: "https://github.com/example/repo/pull/2",
        number: 2,
        branch: second.branch,
      });
      assert.ok(await store.claim("replacement"));
    },
  );

for (const expired of [false, true])
  integration(
    `a paused sibling's saved work stays held after failure (expired: ${expired})`,
    async () => {
      const { project } = await store.createProject(
        "owner",
        { ...input(), targetWip: 2 },
        "demo",
        randomUUID(),
      );
      const first = await store.claim("first");
      const second = await store.claim("second");
      assert.ok(first && second);
      await store.control(project.id, "owner", "pause");
      await store.saveArtifact(first.id, "first", {
        baseCommit: "abc",
        patch: Buffer.from("saved"),
      });
      if (expired) {
        await store.pool.query(
          "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [second.id],
        );
        await store.recoverExpired();
      } else await store.fail(second.id, "second", "Failed");
      assert.equal((await store.getProject(project.id))?.stopRequested, "pause");
      assert.equal(await store.claim("automatic"), null);
      await store.retryAttempt(project.id, "owner");
      assert.equal((await store.claim("explicit-retry"))?.id, first.id);
    },
  );
