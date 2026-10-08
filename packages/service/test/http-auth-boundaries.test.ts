import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { Store } from '../src/store.js';
import { migrateAuth, PgAuthStore } from '../src/auth-store.js';
import { createAuth } from '../src/auth.js';
import { createGithub } from '../src/github.js';
import { createApiServer } from '../src/http.js';
import { createDemoAdapters } from '../src/demo.js';
import type { Adapters } from '../src/adapters.js';

async function fixture(t: TestContext) {
  const connectionString = process.env.HERBIE_TEST_DATABASE_URL;
  if (!connectionString) { t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration'); return null; }
  const schema = `http_auth_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const store = new Store(pool);
  await store.migrate();
  await migrateAuth(pool);
  // A real HTTP boundary returns GitHub's user repository permission shape.
  const upstream = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/repos/demo/example') response.end(JSON.stringify({ id: 42, full_name: 'demo/example', private: false, default_branch: 'main', permissions: { push: false } }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const github = createGithub({ appId: 'test-app', clientId: 'test-client', clientSecret: 'fixture-secret', privateKey: 'unused-for-these-read-only-user-requests', callbackUrl: 'https://herbie.example/api/auth/callback', webhookSecret: 'fixture-webhook' }, { api: upstreamUrl, oauth: upstreamUrl });
  const authStore = new PgAuthStore(pool);
  const auth = createAuth({ mode: 'live', publicUrl: 'https://herbie.example', credentialKey: Buffer.alloc(32, 1).toString('base64') }, authStore, github);
  const adapters: Adapters = {
    ...createDemoAdapters(), mode: 'live',
    async repositories(userId) { await auth.userToken(userId); return []; },
    async authorize(_userId, repository) { return github.authorize('ghu_fixture', repository); },
  };
  const server = createApiServer({ store, auth, adapters, publicUrl: 'https://herbie.example' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => {
    await Promise.all([server, upstream].map(active => new Promise<void>((resolve, reject) => active.close(error => error ? reject(error) : resolve()))));
    await store.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  });
  async function session(userId: string, options: { expired?: boolean; mode?: 'demo' | 'live'; expiredCredential?: boolean } = {}) {
    const token = randomBytes(32).toString('base64url');
    const expiry = new Date(Date.now() + 60_000);
    await authStore.putCredential({ id: userId, login: userId }, 'unused-fixture-token', options.expiredCredential ? new Date(0) : expiry);
    await authStore.createSession({ userId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: options.expired ? new Date(0) : expiry, mode: options.mode ?? 'live' });
    return { authorization: `Bearer ${token}` };
  }
  return { store, session, base: `http://127.0.0.1:${address.port}` };
}

test('HTTP rejects expired and wrong-mode sessions and hides another owner’s goals and events', async t => {
  const setup = await fixture(t);
  if (!setup) return;
  const { store, session, base } = setup;
  const { goal } = await store.createGoal('owner', { repository: 'demo/example', prompt: 'Private goal text', testCommand: ['node', '--test'], maxAttempts: 1 }, 'live', randomUUID());
  const other = await session('other-owner');
  for (const path of [`/api/goals/${goal.id}`, `/api/goals/${goal.id}/events`]) {
    const response = await fetch(`${base}${path}`, { headers: other });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Goal not found' });
  }
  const deniedControl = await fetch(`${base}/api/goals/${goal.id}/cancel`, { method: 'POST', headers: other });
  assert.equal(deniedControl.status, 404);
  assert.equal((await store.getGoal(goal.id))?.state, 'queued');
  assert.deepEqual(await (await fetch(`${base}/api/goals`, { headers: other })).json(), []);
  for (const headers of [await session('expired-owner', { expired: true }), await session('demo-owner', { mode: 'demo' })]) {
    const response = await fetch(`${base}/api/session`, { headers });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Login required' });
  }
});

test('HTTP reports expired GitHub login, denied repository permission, and invalid callback with actionable client errors', async t => {
  const setup = await fixture(t);
  if (!setup) return;
  const { session, base } = setup;
  const expired = await session('expired-credential', { expiredCredential: true });
  const repositories = await fetch(`${base}/api/repositories`, { headers: expired });
  assert.equal(repositories.status, 401);
  assert.deepEqual(await repositories.json(), { error: 'GitHub login expired; log in again before continuing' });
  const denied = await fetch(`${base}/api/goals`, {
    method: 'POST', headers: { ...await session('owner'), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ repository: 'demo/example', prompt: 'Fix bug', testCommand: ['node', '--test'], maxAttempts: 1 }),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: 'User write permission is required' });
  const callback = await fetch(`${base}/api/auth/callback?code=expired&state=unknown`);
  assert.equal(callback.status, 400);
  assert.deepEqual(await callback.json(), { error: 'Authorization is expired or invalid; start login again' });
});
