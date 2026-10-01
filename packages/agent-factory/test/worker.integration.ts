import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Access, hash } from '../src/adapters/auth.js';
import { D1Goals } from '../src/adapters/d1.js';
import { processDelivery } from '../src/cloudflare/webhooks.js';
import { createGoal, reserve } from '../src/core/model.js';

test('real Worker + D1 + Durable Objects: isolation, membership, shared goal edits, admin settings and disabled execution', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: 'dist/worker.js', compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'test-db' }, durableObjects: { GOALS: { className: 'GoalCoordinator', useSQLite: true } },
    bindings: { APP_ORIGIN: 'https://herbie.test', GOOGLE_CLIENT_ID: 'test', FACTORY_ENABLED: 'false',
      GITHUB_WEBHOOK_SECRET: 'test-secret', RUN_TOKEN_SECRET: 'test-only-secret-at-least-32-characters' } }));
  try {
    const db = await mf.getD1Database('DB');
    const sql = await readFile('migrations/0001_factory.sql', 'utf8');
    // D1 exec accepts one statement per line; migration comments are removed for this helper.
    await db.exec(sql.replace(/^--.*$/gm, '').split(';').map(s => s.trim().replaceAll('\n', ' ')).filter(Boolean).join(';\n') + ';');
    await db.exec("INSERT INTO workspaces(id,name) VALUES('a','Company A'),('b','Company B');\nINSERT INTO company_domains VALUES('a.example','a',1,1),('disabled.example','b',1,0);\nINSERT INTO members VALUES('a','admin','admin'),('a','alice','member'),('a','colleague','member'),('b','bob','admin');\nINSERT INTO repositories VALUES('a','a/repo',1,1),('b','b/repo',2,1);");
    for (const sub of ['admin', 'alice', 'colleague', 'bob']) await db.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await hash(sub), sub, Date.now() + 3600000).run();
    const access = new Access(db);
    await access.join({ sub: 'new-employee', domain: 'a.example' });
    assert.equal(await access.member('new-employee', 'a'), 'member');
    await assert.rejects(access.member('new-employee', 'a', true));
    await assert.rejects(access.join({ sub: 'intruder', domain: 'unknown.example' }));
    await assert.rejects(access.join({ sub: 'intruder', domain: 'disabled.example' }));
    const request = (path: string, sub = 'alice', method = 'GET', body?: object) => mf.dispatchFetch('https://herbie.test' + path, { method,
      headers: { cookie: '__Host-herbie=' + sub, origin: 'https://herbie.test', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await request('/health')).status, 200);
    assert.equal((await request('/api/workspaces/a/goals', 'bob')).status, 403);
    assert.equal((await request('/api/workspaces/a/settings')).status, 403);
    assert.equal((await request('/api/workspaces/a/settings', 'admin')).status, 200);
    const created = await request('/api/workspaces/a/goals', 'alice', 'POST', { repo: 'a/repo', prompt: 'Improve tests' });
    assert.equal(created.status, 201);
    const goal = await created.json() as { id: string; target: number };
    assert.equal(goal.target, 1);
    assert.equal((await request('/api/workspaces/a/goals/' + goal.id, 'colleague', 'PATCH', { prompt: 'Fix performance', target: 2, status: 'active' })).status, 200);
    assert.equal((await request('/api/workspaces/b/goals/' + goal.id, 'bob')).status, 404);
    assert.equal((await request('/api/workspaces/a/goals', 'alice', 'POST', { repo: 'b/repo', prompt: 'steal' })).status, 403);
    assert.equal((await request('/api/workspaces/a/repositories', 'alice', 'PATCH', { repo: 'a/repo', enabled: false })).status, 403);
    assert.equal((await request('/api/workspaces/a/repositories', 'admin', 'PATCH', { repo: 'a/repo', enabled: false })).status, 200);
    assert.equal((await request('/api/workspaces/a/goals', 'alice', 'POST', { repo: 'a/repo', prompt: 'no connection' })).status, 403);
    assert.equal((await mf.dispatchFetch('https://herbie.test/webhooks/github', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await mf.dispatchFetch('https://herbie.test/api/workspaces/a/goals', { method: 'POST', headers: { cookie: '__Host-herbie=alice', origin: 'https://evil.test' } })).status, 403);
    // Signed delivery replay is persisted once and acknowledged without executing a job.
    const webhookBody = JSON.stringify({ zen: 'local test' });
    const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = 'sha256=' + Buffer.from(await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(webhookBody))).toString('hex');
    for (let i = 0; i < 2; i++) assert.equal((await mf.dispatchFetch('https://herbie.test/webhooks/github', { method: 'POST', body: webhookBody,
      headers: { 'x-hub-signature-256': signature, 'x-github-delivery': 'same-delivery', 'x-github-event': 'ping' } })).status, 202);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE id='same-delivery'").first<{ n: number }>())!.n, 1);
    // CI can complete after push but before the run/PR publication checkpoint.
    const early = createGoal('early', 'b', 'b/repo', 'Fix one thing'); reserve(early, Date.now()); early.runs[0].status = 'running';
    await new D1Goals(db).create(early);
    const ci = { action: 'completed', installation: { id: 2 }, repository: { full_name: 'b/repo' },
      check_run: { name: 'test', conclusion: 'failure', head_sha: 'abc' } };
    await db.prepare('INSERT INTO deliveries(id,received,body,event) VALUES(?,?,?,?)').bind('early-ci', Date.now(), JSON.stringify(ci), 'check_run').run();
    let woke = false;
    await assert.rejects(processDelivery({ DB: db, GITHUB_APP_ID: 'test', GITHUB_APP_PRIVATE_KEY: 'unused',
      GOALS: { getByName() { return { async wake() { woke = true; } }; } } }, 'early-ci'), /reconciling/);
    assert.equal(woke, true);
    assert.equal((await db.prepare("SELECT completed FROM deliveries WHERE id='early-ci'").first<{ completed: number }>())!.completed, 0);
    const saved = await new D1Goals(db).load(goal.id);
    assert.equal(saved!.goal.prompt, 'Fix performance');
    assert.equal(saved!.goal.runs.length, 0); // Safe default never starts a real factory.
    // CAS persistence is enforced by real SQL, not just a fake.
    assert.equal(await new D1Goals(db).save(saved!.goal, saved!.revision), true);
    assert.equal(await new D1Goals(db).save(saved!.goal, saved!.revision), false);
    const other = createGoal('second', 'a', 'a/repo', 'test');
    await db.prepare("UPDATE workspaces SET max_goals=1 WHERE id='a'").run();
    await assert.rejects(new D1Goals(db).create(other));
  } finally { await mf.dispose(); }
});
