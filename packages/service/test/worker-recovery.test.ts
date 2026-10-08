import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { Store } from '../src/store.js';
import { createDemoAdapters } from '../src/demo.js';
import { runWorkerOnce } from '../src/worker.js';
import type { Adapters } from '../src/adapters.js';

async function database(t: TestContext): Promise<Store | null> {
  const connectionString = process.env.HERBIE_TEST_DATABASE_URL;
  if (!connectionString) { t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration'); return null; }
  const schema = `recovery_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const store = new Store(new Pool({ connectionString, options: `-c search_path=${schema}` }));
  t.after(async () => { await store.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await store.migrate();
  return store;
}
const request = { repository: 'demo/example', prompt: 'Fix arithmetic', testCommand: ['node', '--test'], maxAttempts: 1 };
const artifact = { baseCommit: '0'.repeat(40), patch: Buffer.from('DEMO recovered artifact') };

test('worker survives losing its attempt lease without publishing or repeating paid work', async t => {
  const store = await database(t);
  if (!store) return;
  const { goal } = await store.createGoal('demo-user', request, 'demo', randomUUID());
  const adapters: Adapters = {
    ...createDemoAdapters(),
    async attempt(execution) {
      // Simulate an unresponsive worker being recovered while its external attempt completes.
      assert.equal(await store.heartbeat(execution.attemptId, 'old-worker', 1), true);
      await delay(15);
      assert.equal(await store.recoverExpired(), 1);
      return artifact;
    },
    async publish() { throw new Error('A worker without a lease must not publish'); },
  };
  assert.equal(await runWorkerOnce(store, adapters, 'old-worker'), true);
  const interrupted = await store.getGoal(goal.id);
  assert.equal(interrupted?.state, 'needs_attention');
  assert.equal(interrupted.attemptCount, 1);
  assert.equal(interrupted.pullRequest, null);
  assert.equal(await runWorkerOnce(store, adapters, 'new-worker'), false);
});

test('a replacement worker reconciles an interrupted publication without calling publish again', async t => {
  const store = await database(t);
  if (!store) return;
  const { goal } = await store.createGoal('demo-user', request, 'demo', randomUUID());
  const claimed = await store.claim('lost-publisher');
  assert.ok(claimed);
  await store.saveArtifact(claimed.id, 'lost-publisher', artifact);
  await store.beginPublication(claimed.id, 'lost-publisher');
  // Remote PR creation succeeded just before the service process disappeared.
  const remotePr = { url: 'https://demo.invalid/herbie/pull/42', number: 42, branch: claimed.branch };
  await store.heartbeat(claimed.id, 'lost-publisher', 1);
  await delay(15);
  const adapters: Adapters = {
    ...createDemoAdapters(),
    async attempt() { throw new Error('Recovered publication must not rerun its attempt'); },
    async publish() { throw new Error('Recovered publication must not repeat its write'); },
    async reconcile(execution) {
      assert.equal(execution.branch, remotePr.branch);
      return { ...remotePr, state: 'open' };
    },
  };
  assert.equal(await runWorkerOnce(store, adapters, 'replacement'), true);
  assert.equal((await store.getGoal(goal.id))?.state, 'awaiting_review');
  assert.deepEqual((await store.getGoal(goal.id))?.pullRequest, { ...remotePr, state: 'open' });
  assert.equal(await runWorkerOnce(store, adapters, 'another-worker'), false);
});

test('worker resumes a held artifact after restart and cooperative cancellation never publishes', async t => {
  const store = await database(t);
  if (!store) return;
  const { goal } = await store.createGoal('demo-user', request, 'demo', randomUUID());
  const claimed = await store.claim('old-worker');
  assert.ok(claimed);
  await store.control(goal.id, 'demo-user', 'pause');
  await store.saveArtifact(claimed.id, 'old-worker', artifact);
  const resumeAdapters: Adapters = {
    ...createDemoAdapters(),
    async attempt() { throw new Error('A saved artifact must not rerun its paid attempt'); },
  };
  assert.equal(await runWorkerOnce(store, resumeAdapters, 'new-worker'), false);
  await store.control(goal.id, 'demo-user', 'resume');
  assert.equal(await runWorkerOnce(store, resumeAdapters, 'new-worker'), true);
  assert.equal((await store.getGoal(goal.id))?.state, 'awaiting_review');
  assert.equal((await store.getGoal(goal.id))?.attemptCount, 1);
  await store.control(goal.id, 'demo-user', 'cancel');
  const { goal: cancelled } = await store.createGoal('demo-user', request, 'demo', randomUUID());
  const cancelAdapters: Adapters = {
    ...createDemoAdapters(),
    async attempt(execution) {
      await store.control(execution.goal.id, 'demo-user', 'cancel');
      return artifact;
    },
    async publish() { throw new Error('Cancellation must discard the artifact before publication'); },
  };
  assert.equal(await runWorkerOnce(store, cancelAdapters, 'new-worker'), true);
  assert.equal((await store.getGoal(cancelled.id))?.state, 'cancelled');
  assert.equal((await store.getGoal(cancelled.id))?.pullRequest, null);
  assert.equal(await runWorkerOnce(store, cancelAdapters, 'another-worker'), false);
});

test('a stale publisher cannot overwrite a replacement worker that already recovered its PR', async t => {
  const store = await database(t);
  if (!store) return;
  const { goal } = await store.createGoal('demo-user', request, 'demo', randomUUID());
  let remotePr: { url: string; number: number; branch: string } | null = null;
  const adapters: Adapters = {
    ...createDemoAdapters(),
    async publish(execution) {
      if (remotePr) throw new Error('Duplicate remote publication');
      const published = { url: 'https://demo.invalid/herbie/pull/43', number: 43, branch: execution.branch };
      remotePr = published;
      await store.heartbeat(execution.attemptId, 'stale-publisher', 1);
      await delay(15);
      assert.equal(await runWorkerOnce(store, adapters, 'replacement'), true);
      return published;
    },
    async reconcile() { return remotePr ? { ...remotePr, state: 'open' } : null; },
  };
  assert.equal(await runWorkerOnce(store, adapters, 'stale-publisher'), true);
  const recovered = await store.getGoal(goal.id);
  assert.equal(recovered?.state, 'awaiting_review');
  assert.equal(recovered.error, null);
  assert.equal(recovered.pullRequest?.number, 43);
  assert.equal(recovered.attemptCount, 1);
  assert.equal((await store.events(goal.id)).filter(event => event.type === 'pull_request_opened').length, 1);
});
