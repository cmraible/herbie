import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { createGithub } from '../src/github.js';
import { createLiveAdapters } from '../src/live.js';
import { Store, StoreError } from '../src/store.js';

async function githubFixture(t: TestContext) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const remotePullRequests: string[] = [];
  const repository = { id: 42, full_name: 'alice/project', private: false, default_branch: 'main', permissions: { push: true } };
  const server = createServer(async (request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    const path = request.url ?? '';
    if (path === '/repos/alice/project') response.end(JSON.stringify(repository));
    else if (path.startsWith('/user/installations/11/repositories')) response.end(JSON.stringify({ repositories: [repository] }));
    else if (path.startsWith('/user/installations')) response.end(JSON.stringify({ installations: [{ id: 11, permissions: { contents: 'write', pull_requests: 'write' } }] }));
    else if (path === '/app/installations/11/access_tokens') response.end(JSON.stringify({ token: 'ghs_fixture', expires_at: new Date(Date.now() + 60_000).toISOString() }));
    else if (path.startsWith('/repos/alice/project/pulls') && request.method === 'GET') {
      entered.resolve();
      await release.promise;
      response.end('[]');
    } else if (path === '/repos/alice/project/pulls' && request.method === 'POST') {
      remotePullRequests.push('herbie/attempt-1');
      response.end(JSON.stringify({ number: 1, html_url: 'https://github.com/alice/project/pull/1', state: 'open', merged_at: null, head: { ref: 'herbie/attempt-1' }, base: { ref: 'main' } }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const github = createGithub({ appId: '1', clientId: 'fixture-client', clientSecret: 'fixture-secret', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), callbackUrl: 'https://herbie.example/api/auth/callback', webhookSecret: 'fixture-webhook' }, { api: origin, oauth: origin });
  return { github, entered, release, remotePullRequests };
}

test('GitHub rechecks ownership after its final PR lookup before posting a new PR', async t => {
  const { github, entered, release, remotePullRequests } = await githubFixture(t);
  let ownership = true;
  const pending = github.openPullRequest('ghs_fixture', { repository: 'alice/project', base: 'main', head: 'herbie/attempt-1', title: 'Fix arithmetic', body: 'Fixture only', draft: true }, async () => {
    if (!ownership) throw new StoreError(409, 'Worker lease lost');
  });
  await entered.promise;
  ownership = false;
  release.resolve();
  await assert.rejects(pending, error => error instanceof StoreError && error.status === 409);
  assert.deepEqual(remotePullRequests, []);
});

test('live publication stops after awaited GitHub preflight when its durable lease expires', async t => {
  const connectionString = process.env.HERBIE_TEST_DATABASE_URL;
  if (!connectionString) return t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration');
  const { github, entered, release, remotePullRequests } = await githubFixture(t);
  const schema = `publication_lease_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const store = new Store(new Pool({ connectionString, options: `-c search_path=${schema}` }));
  t.after(async () => { await store.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await store.migrate();
  await store.createGoal('owner', { repository: 'alice/project', prompt: 'Fix arithmetic', testCommand: ['node', '--test'], maxAttempts: 1 }, 'live', randomUUID());
  const job = await store.claim('publisher');
  assert.ok(job);
  const changes = { baseCommit: '0'.repeat(40), patch: Buffer.from('unused: ownership fails before local preparation') };
  await store.saveArtifact(job.id, 'publisher', changes);
  await store.beginPublication(job.id, 'publisher');
  const live = createLiveAdapters({ apiKey: 'fixture-never-used', openaiSecretName: 'fixture-never-used' }, github, { userToken: async () => 'ghu_fixture' });
  const pending = live.publish({ goal: job.goal, repository: { repository: 'alice/project', defaultBranch: 'main', installationId: 11 }, attemptId: job.id, branch: job.branch }, changes, async () => {
    if (!await store.heartbeat(job.id, 'publisher')) throw new StoreError(409, 'Worker lease lost');
  });
  await entered.promise;
  assert.equal(await store.heartbeat(job.id, 'publisher', 1), true);
  await delay(15);
  const recovered = await store.recoverExpired();
  release.resolve();
  await assert.rejects(pending, error => error instanceof StoreError && error.status === 409);
  assert.equal(recovered, 1);
  assert.equal((await store.getGoal(job.goal.id))?.state, 'needs_attention');
  assert.deepEqual(remotePullRequests, []);
});
