import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import pg from "pg";
import { PatchPublicationError } from "@herbie/loop/publish-patch";
import { runWorkerOnce } from "../src/worker.js";
import {
  activityMessage,
  projectErrorMessage,
  errorReference,
} from "../../web/src/activity-message.js";
import { Store } from "../src/store.js";
import { PgAuthStore, migrateAuth } from "../src/auth-store.js";
import { createAuth } from "../src/auth.js";
import { GithubError, createGithub } from "../src/github.js";
import { createDemoAdapters } from "../src/demo.js";
import { createApiServer } from "../src/http.js";
import type { Adapters } from "../src/adapters.js";

const origin = "https://herbie.example";
const repository = "fixture-owner/fixture-project";

async function fixture(
  t: TestContext,
  options: {
    cancelCheck?: () => Promise<"absent" | "pull_request_exists" | "branch_exists">;
    executionEnabled?: boolean;
    check?: () => Promise<"ready" | "pull_request_exists" | "branch_exists" | "base_changed">;
  } = {},
) {
  const connectionString = process.env.HERBIE_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip("Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration");
    return null;
  }
  const schema = "retry_publication_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString });
  await admin.query("CREATE SCHEMA " + schema);
  const pool = new pg.Pool({ connectionString, options: "-c search_path=" + schema });
  const store = new Store(pool);
  await store.migrate();
  await migrateAuth(pool);
  const authStore = new PgAuthStore(pool);
  const github = createGithub({
    appId: "fixture-app",
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    privateKey: "unused-fixture-key",
    callbackUrl: origin + "/api/auth/callback",
    webhookSecret: "fixture-webhook",
  });
  const auth = createAuth(
    {
      mode: "live",
      allowedGithubUserId: "7",
      publicUrl: origin,
      credentialKey: Buffer.alloc(32, 7).toString("base64"),
    },
    authStore,
    github,
  );
  let checks = 0,
    runs = 0,
    publishes = 0;
  const demo = createDemoAdapters();
  const adapters: Adapters = {
    ...demo,
    mode: "live",
    async authorize(_userId, repo) {
      return { repository: repo, defaultBranch: "main", installationId: 11 };
    },
    async reconciliationRepository(repo) {
      return { repository: repo, defaultBranch: "main", installationId: 11 };
    },
    async run() {
      runs++;
      throw new Error("Retry must not start another run");
    },
    async publish(execution) {
      publishes++;
      return {
        url: "https://github.com/fixture-owner/fixture-project/pull/1",
        number: 1,
        branch: execution.branch,
      };
    },
    ...(options.cancelCheck ? { checkUnpublished: options.cancelCheck } : {}),
    async checkPublicationRetry() {
      checks++;
      return options.check ? options.check() : "ready";
    },
  };
  const server = createApiServer({
    store,
    auth,
    adapters,
    publicUrl: origin,
    executionEnabled: options.executionEnabled ?? true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await store.close();
    await admin.query("DROP SCHEMA " + schema + " CASCADE");
    await admin.end();
  });
  async function session(userId = "7") {
    const expiresAt = new Date(Date.now() + 60_000);
    await authStore.putCredential(
      { id: userId, login: "fixture-user" },
      "synthetic-encrypted-token",
      expiresAt,
    );
    const token = randomBytes(32).toString("base64url");
    await authStore.createSession({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      expiresAt,
      mode: "live",
    });
    return { cookie: "herbie_session=" + token, origin, "content-type": "application/json" };
  }
  async function retryableProject(ownerId = "7", projectRepository = repository, prewrite = false) {
    const { project } = await store.createProject(
      ownerId,
      {
        repository: projectRepository,
        name: "Synthetic retry fixture",
        prompt: "Synthetic retry fixture",
      },
      "live",
      randomUUID(),
    );
    const worker = "fixture-worker";
    const run = await store.claim(worker, 30_000, "live");
    assert.ok(run);
    assert.equal(run.project.id, project.id);
    const patch = Buffer.from("synthetic tested patch\n");
    const baseCommit = "a".repeat(40);
    const artifact = {
      baseCommit,
      patch,
      verification: {
        version: 3 as const,
        repoUrl: "https://github.com/" + projectRepository + ".git",
        baseCommit,
        patchSha256: createHash("sha256").update(patch).digest("hex"),
        goalCompleted: true as const,
        sandboxDeleted: true as const,
      },
    };
    await store.saveArtifact(run.id, worker, artifact);
    assert.equal(await store.beginPublication(run.id, worker), true);
    await store.publicationUncertain(
      run.id,
      worker,
      prewrite
        ? "Publication remains unconfirmed during preflight_reconciliation (unexpected); reconciliation will check GitHub."
        : "Publication remains unconfirmed during branch_push (git_push_uncertain); reconciliation will check GitHub.",
    );
    return { project, runId: run.id, artifact };
  }
  async function reconciledProject(prewrite = true) {
    const result = await retryableProject("7", repository, prewrite);
    await store.pool.query("UPDATE project_runs SET eligible_at=clock_timestamp() WHERE id=$1", [
      result.runId,
    ]);
    const claimed = await store.claim("fixture-reconciler", 30_000, "live");
    assert.equal(claimed?.id, result.runId);
    await store.publicationUncertain(
      result.runId,
      "fixture-reconciler",
      "Publication remains unconfirmed during preflight_reconciliation (pull_request_not_found); reconciliation will check GitHub.",
    );
    return result;
  }
  const base = "http://127.0.0.1:" + address.port;
  const headersFor = (headers: Record<string, string>) => ({
    ...headers,
    "content-type": "application/json",
  });
  return {
    reconciledProject,
    adapters,
    store,
    authStore,
    base,
    session,
    retryableProject,
    headersFor,
    get checks() {
      return checks;
    },
    get runs() {
      return runs;
    },
    get publishes() {
      return publishes;
    },
  };
}

test("retry-publication scopes ownership, requires same-origin cookie requests, and queues the saved artifact once", async (t) => {
  const setup = await fixture(t);
  if (!setup) return;
  const { store, base, session, retryableProject, headersFor } = setup;
  const own = await retryableProject("7");
  const another = await retryableProject("another-owner", "other-owner/other-project");
  const headers = await session();
  const path = "/api/projects/" + own.project.id + "/retry-publication";
  const noOrigin = await fetch(base + path, {
    method: "POST",
    headers: { cookie: headers.cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(noOrigin.status, 403);
  const wrongOrigin = await fetch(base + path, {
    method: "POST",
    headers: headersFor({ cookie: headers.cookie, origin: "https://attacker.example" }),
    body: "{}",
  });
  assert.equal(wrongOrigin.status, 403);
  const hidden = await fetch(base + "/api/projects/" + another.project.id + "/retry-publication", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(hidden.status, 404);
  assert.equal(setup.checks, 0);

  const retry = () => fetch(base + path, { method: "POST", headers, body: "{}" });
  const first = await retry();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).state, "queued");
  const second = await retry();
  assert.equal(second.status, 200);
  assert.equal((await second.json()).state, "queued");
  assert.equal(setup.checks, 1, "repeat request must not repeat GitHub checks or enqueue twice");
  const row = await store.pool.query<{ stage: string; artifact: Record<string, unknown> | null }>(
    "SELECT stage,artifact FROM project_runs WHERE id=$1",
    [own.runId],
  );
  assert.equal(row.rows[0]?.stage, "ready");
  assert.ok(row.rows[0]?.artifact);
  assert.equal(setup.runs, 0);
});

test("retry-publication respects the reconciliation lease and cannot race a claimed reconciler", async (t) => {
  const setup = await fixture(t);
  if (!setup) return;
  const { store, base, session, retryableProject } = setup;
  const { project } = await retryableProject();
  await store.pool.query(
    "UPDATE project_runs SET eligible_at=clock_timestamp() WHERE project_id=$1",
    [project.id],
  );
  const claimed = await store.claim("reconciler", 30_000, "live");
  assert.ok(claimed);
  assert.equal(claimed.stage, "publishing");
  const headers = await session();
  const response = await fetch(base + "/api/projects/" + project.id + "/retry-publication", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "needs_attention");
  assert.equal(
    setup.checks,
    0,
    "active reconciliation lease must short-circuit before GitHub checks",
  );
  const row = await store.pool.query<{ stage: string; lease_owner: string | null }>(
    "SELECT stage,lease_owner FROM project_runs WHERE id=$1",
    [claimed.id],
  );
  assert.equal(row.rows[0]?.stage, "publishing");
  assert.equal(row.rows[0]?.lease_owner, "reconciler");
});

test("execution-disabled service rejects saved-publication retry before repository checks", async (t) => {
  const setup = await fixture(t, { executionEnabled: false });
  if (!setup) return;
  const { base, session, retryableProject } = setup;
  const { project } = await retryableProject();
  const headers = await session();
  const response = await fetch(base + "/api/projects/" + project.id + "/retry-publication", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Live runs aren't configured yet" });
  assert.equal(setup.checks, 0);
});

test("retry and cancel serialize safely while repository checks are in flight", async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const setup = await fixture(t, {
    check: async () => {
      entered.resolve();
      await release.promise;
      return "ready";
    },
  });
  if (!setup) return;
  const { base, session, retryableProject } = setup;
  const { project } = await retryableProject();
  const headers = await session();
  const retry = fetch(base + "/api/projects/" + project.id + "/retry-publication", {
    method: "POST",
    headers,
    body: "{}",
  });
  await entered.promise;
  let cancelBeforeQueue: Response;
  try {
    cancelBeforeQueue = await fetch(base + "/api/projects/" + project.id + "/cancel", {
      method: "POST",
      headers,
      body: "{}",
    });
  } finally {
    release.resolve();
  }
  assert.equal(cancelBeforeQueue.status, 200, "cancellation does not wait for remote preflight");
  const queued = await retry;
  assert.equal(queued.status, 409);
  const cancelAfterQueue = await fetch(base + "/api/projects/" + project.id + "/cancel", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(cancelAfterQueue.status, 200);
  assert.equal((await cancelAfterQueue.json()).state, "cancelled");
  assert.equal(
    await setup.store.claim("worker-after-cancel", 30_000, "live"),
    null,
    "cancellation wins before the saved artifact is claimed",
  );
  const row = await setup.store.pool.query<{
    stage: string;
    artifact: Record<string, unknown> | null;
  }>("SELECT stage,artifact FROM project_runs WHERE project_id=$1", [project.id]);
  assert.equal(row.rows[0]?.stage, "cancelled");
  assert.ok(row.rows[0]?.artifact);
  assert.equal(setup.runs, 0);
  assert.equal(setup.publishes, 0);
});

test("cancel confirmed unpublished work checks ownership and CSRF, preserves evidence, and frees the repository", async (t) => {
  let checks = 0;
  const setup = await fixture(t, {
    executionEnabled: false,
    cancelCheck: async () => {
      checks++;
      return "absent";
    },
  });
  if (!setup) return;
  const { store, base, session, reconciledProject } = setup;
  const { project, runId } = await reconciledProject();
  const headers = await session();
  const path = base + "/api/projects/" + project.id + "/cancel";
  assert.equal(
    (await fetch(path, { method: "POST", headers: { cookie: headers.cookie } })).status,
    403,
  );
  const other = await setup.retryableProject("other-owner", "other-owner/other-project");
  assert.equal(
    (
      await fetch(base + "/api/projects/" + other.project.id + "/cancel", {
        method: "POST",
        headers,
      })
    ).status,
    404,
  );
  assert.equal(checks, 0);
  const before = await store.pool.query("SELECT artifact FROM project_runs WHERE id=$1", [runId]);
  const response = await fetch(path, { method: "POST", headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "cancelled");
  assert.equal(checks, 0);
  assert.equal((await fetch(path, { method: "POST", headers })).status, 200);
  assert.equal(checks, 0);
  const after = await store.pool.query("SELECT stage,artifact FROM project_runs WHERE id=$1", [
    runId,
  ]);
  assert.equal(after.rows[0].stage, "cancelled");
  assert.deepEqual(after.rows[0].artifact, before.rows[0].artifact);
  assert.ok(
    (await store.events(project.id)).some(
      (e) => e.type === "cancel" && e.message.includes("retained"),
    ),
  );
  assert.ok(
    (
      await store.createProject(
        "7",
        { repository, name: "Next fixture", prompt: "Next fixture" },
        "live",
        randomUUID(),
      )
    ).created,
  );
  assert.equal(setup.runs, 0);
  assert.equal(setup.publishes, 0);
});

for (const remote of ["pull_request_exists", "branch_exists", "error"] as const)
  test("cancel does not depend on remote state: " + remote, async (t) => {
    const setup = await fixture(t, {
      cancelCheck: async () => {
        if (remote === "error") throw new Error("Synthetic GitHub outage");
        return remote;
      },
    });
    if (!setup) return;
    const { project, runId } = await setup.reconciledProject();
    const response = await fetch(setup.base + "/api/projects/" + project.id + "/cancel", {
      method: "POST",
      headers: await setup.session(),
    });
    assert.equal(response.status, 200);
    assert.equal((await setup.store.getProject(project.id))?.state, "cancelled");
    assert.equal((await setup.store.getProject(project.id))?.cleanupStatus, "needs_attention");
    assert.equal(
      (await setup.store.pool.query("SELECT stage FROM project_runs WHERE id=$1", [runId])).rows[0]
        .stage,
      "cancelled",
    );
  });

for (const needsAttention of [false, true])
  test(`retry recovers ${needsAttention ? "interrupted" : "failed"} runs without duplicating work`, async (t) => {
    const setup = await fixture(t);
    if (!setup) return;
    const { store, base, session } = setup;
    const { project } = await store.createProject(
      "7",
      { repository, name: "Retry run", prompt: "Finish the task" },
      "live",
      randomUUID(),
    );
    const old = await store.claim("old-worker", 30_000, "live");
    assert.ok(old);
    await store.fail(old.id, "old-worker", "Synthetic failure", needsAttention);
    const headers = await session();
    const path = base + "/api/projects/" + project.id + "/retry";
    const responses = await Promise.all([
      fetch(path, { method: "POST", headers }),
      fetch(path, { method: "POST", headers }),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.state, "queued");
      assert.equal(result.error, null);
    }
    const next = await store.claim("new-worker", 30_000, "live");
    assert.ok(next);
    assert.notEqual(next.id, old.id);
    assert.notEqual(next.branch, old.branch);
    assert.equal(next.project.id, project.id);
    assert.equal(next.project.runCount, 2);
    assert.equal(await store.claim("duplicate", 30_000, "live"), null);
    await assert.rejects(
      store.saveArtifact(old.id, "old-worker", {
        baseCommit: "a".repeat(40),
        patch: Buffer.from("stale"),
      }),
    );
    assert.equal((await store.events(project.id)).filter((e) => e.type === "retry").length, 1);
  });

test("retry preserves saved publication instead of starting another run", async (t) => {
  const setup = await fixture(t);
  if (!setup) return;
  const { project, runId } = await setup.retryableProject();
  const response = await fetch(setup.base + "/api/projects/" + project.id + "/retry", {
    method: "POST",
    headers: await setup.session(),
  });
  assert.equal(response.status, 200);
  const next = await setup.store.claim("retry-worker", 30_000, "live");
  assert.ok(next);
  assert.equal(next.id, runId);
  assert.equal(next.stage, "ready");
  assert.equal(next.project.runCount, 1);
});

test("retry is owner scoped, CSRF protected, and cannot revive cancellation", async (t) => {
  const setup = await fixture(t);
  if (!setup) return;
  const { project } = await setup.store.createProject(
    "7",
    { repository, name: "Retry fixture", prompt: "Retry fixture" },
    "live",
    randomUUID(),
  );
  const path = setup.base + "/api/projects/" + project.id + "/retry";
  const headers = await setup.session();
  assert.equal(
    (await fetch(path, { method: "POST", headers: { cookie: headers.cookie } })).status,
    403,
  );
  const other = await setup.store.createProject(
    "other",
    { repository, name: "Other project", prompt: "Other project" },
    "live",
    randomUUID(),
  );
  assert.equal(
    (
      await fetch(setup.base + "/api/projects/" + other.project.id + "/retry", {
        method: "POST",
        headers,
      })
    ).status,
    404,
  );
  await setup.store.control(project.id, "7", "cancel");
  assert.equal((await fetch(path, { method: "POST", headers })).status, 409);
  assert.equal((await setup.store.getProject(project.id))?.state, "cancelled");
});

test("execution-disabled service rejects run retry", async (t) => {
  const setup = await fixture(t, { executionEnabled: false });
  if (!setup) return;
  const { project } = await setup.store.createProject(
    "7",
    { repository, name: "Retry fixture", prompt: "Retry fixture" },
    "live",
    randomUUID(),
  );
  const response = await fetch(setup.base + "/api/projects/" + project.id + "/retry", {
    method: "POST",
    headers: await setup.session(),
  });
  assert.equal(response.status, 503);
});

test("retry recovers an expired worker lease while fencing its late result", async (t) => {
  const setup = await fixture(t);
  if (!setup) return;
  const { store } = setup;
  const { project } = await store.createProject(
    "7",
    { repository, name: "Retry fixture", prompt: "Retry fixture" },
    "live",
    randomUUID(),
  );
  const old = await store.claim("expired-worker", 30_000, "live");
  assert.ok(old);
  await store.pool.query(
    "UPDATE project_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [old.id],
  );
  await store.recoverExpired();
  assert.equal((await store.getProject(project.id))?.state, "needs_attention");
  const response = await fetch(setup.base + "/api/projects/" + project.id + "/retry", {
    method: "POST",
    headers: await setup.session(),
  });
  assert.equal(response.status, 200);
  const next = await store.claim("replacement-worker", 30_000, "live");
  assert.ok(next);
  assert.notEqual(next.id, old.id);
  await assert.rejects(store.fail(old.id, "expired-worker", "Late failure"));
  assert.equal((await store.getProject(project.id))?.state, "running");
});

for (const conflict of ["branch_exists", "pull_request_exists", "base_changed"] as const)
  test(`retry cannot discard saved publication on ${conflict}`, async (t) => {
    const setup = await fixture(t, { check: async () => conflict });
    if (!setup) return;
    const { project, runId } = await setup.retryableProject();
    const response = await fetch(setup.base + "/api/projects/" + project.id + "/retry", {
      method: "POST",
      headers: await setup.session(),
    });
    assert.equal(response.status, 409);
    const { rows } = await setup.store.pool.query(
      "SELECT id,stage,artifact FROM project_runs WHERE project_id=$1",
      [project.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, runId);
    assert.equal(rows[0].stage, "publishing");
    assert.ok(rows[0].artifact);
  });

for (const missing of ["workflow", "installation"] as const)
  test(`${missing} permission rejection blocks retries, reaches the UI, and resumes the saved patches`, async (t) => {
    const setup = await fixture(t);
    if (!setup) return;
    const { project, runId } = await setup.retryableProject();
    const publish = setup.adapters.publish;
    setup.adapters.publish = async () => {
      if (missing === "installation")
        throw new GithubError(
          403,
          "Update installation permissions",
          "github_permissions_required",
        );
      throw new PatchPublicationError(
        [
          Object.assign(new Error("private command"), {
            stdout:
              "!\tcommit:branch\t[remote rejected] (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci-deploy.yml` without `workflows` permission)\nprivate output",
          }),
        ],
        { repository, branch: "fixture-branch", stage: "pushing" },
      );
    };
    t.mock.method(console, "error", () => {});
    await setup.store.pool.query(
      "UPDATE project_runs SET eligible_at=clock_timestamp() WHERE id=$1",
      [runId],
    );
    await runWorkerOnce(setup.store, setup.adapters, "permission-worker");
    const saved = await setup.store.getProject(project.id);
    assert.ok(saved);
    assert.equal(saved.state, "needs_attention");
    assert.match(saved.error!, /workflow_permission_missing|installation_permissions_missing/);
    assert.doesNotMatch(saved.error!, /private|Retrying automatically/);
    assert.ok(errorReference(saved.error!));
    const event = (await setup.store.events(project.id)).find(
      (e) => e.type === "publication_blocked",
    );
    assert.ok(event);
    assert.equal(activityMessage(saved, event), projectErrorMessage(saved));
    assert.match(projectErrorMessage(saved), /Workflows/);
    if (missing === "workflow")
      assert.match(projectErrorMessage(saved), /\.github\/workflows\/ci-deploy.yml/);
    assert.equal(errorReference(event.message), errorReference(saved.error!));
    const row = (
      await setup.store.pool.query(
        "SELECT publication_blocked,artifact FROM project_runs WHERE id=$1",
        [runId],
      )
    ).rows[0];
    assert.equal(row.publication_blocked, true);
    assert.ok(row.artifact);
    assert.equal(await runWorkerOnce(setup.store, setup.adapters, "automatic-retry"), false);

    setup.adapters.publish = publish;
    const response = await fetch(
      setup.base + "/api/projects/" + project.id + "/retry-publication",
      {
        method: "POST",
        headers: await setup.session(),
        body: "{}",
      },
    );
    assert.equal(response.status, 200);
    await runWorkerOnce(setup.store, setup.adapters, "permission-fixed-worker");
    const resumed = await setup.store.getProject(project.id);
    assert.equal(resumed?.state, "awaiting_review");
    assert.equal(resumed?.runCount, 1);
    assert.equal(setup.runs, 0);
    assert.equal(setup.publishes, 1);
  });

test("repository discovery exposes the required-permissions code to signed-in clients", async (t) => {
  const setup = await fixture(t);
  if (!setup) return;
  setup.adapters.repositories = async () => {
    throw new GithubError(403, "Update installation permissions", "github_permissions_required");
  };
  const response = await fetch(setup.base + "/api/repositories", {
    headers: await setup.session(),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Update installation permissions",
    code: "github_permissions_required",
  });
});

test("repository discovery reports permission updates while preserving legacy repository lists", async (t) => {
  const setup = await fixture(t);
  if (!setup) return;
  const repositories = [{ fullName: "alice/project", defaultBranch: "main", installationId: 11 }];
  setup.adapters.repositories = async () => repositories;
  setup.adapters.discoverRepositories = async () => ({ repositories, permissionsRequired: true });
  const headers = await setup.session();
  const current = await fetch(setup.base + "/api/repositories", {
    headers: { ...headers, "x-herbie-repository-version": "2" },
  });
  assert.deepEqual(await current.json(), { repositories, permissionsRequired: true });
  const legacy = await fetch(setup.base + "/api/repositories", { headers });
  assert.deepEqual(await legacy.json(), repositories);
});
