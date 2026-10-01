import { login } from '../src/adapters/login.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Access } from '../src/adapters/auth.js';
import { D1Goals } from '../src/adapters/d1.js';
import { processDelivery } from '../src/cloudflare/webhooks.js';
import { createGoal, reserve } from '../src/core/model.js';

test('real Worker + D1 + Durable Objects: isolation, membership, shared goal edits, admin settings and disabled execution', async () => {
  const outboundService=async(req:Request)=>{
    const url=new URL(req.url);
    if(url.hostname==='github.com' && url.pathname==='/login/oauth/access_token') return Response.json({access_token:'test-oauth-token'});
    if(url.hostname==='api.github.com') {
      if(url.pathname==='/user') return Response.json({id:7});
      if(url.pathname==='/user/installations') return Response.json({installations:[{id:1,app_id:42,account:{id:7,login:'a',type:'User'},suspended_at:null}]});
      if(url.pathname==='/user/installations/1/repositories') return Response.json({repositories:[{full_name:'a/repo',owner:{id:7}}]});
    }
    throw new Error('Unexpected provider request');
  };
  const mf = new Miniflare(convertV4MiniflareOptions({ outboundService, modules: true, scriptPath: 'dist/worker.js', compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'test-db' }, durableObjects: { GOALS: { className: 'GoalCoordinator', useSQLite: true } },
    bindings: { APP_ORIGIN: 'https://herbie.test', BETTER_AUTH_SECRET: 'local-test-secret-with-over-32-characters', ALLOWED_EMAIL_DOMAINS:'a.example,b.example', EMAIL_FROM:'test@a.example', FACTORY_ENABLED: 'false',
      GITHUB_APP_ID:'42', GITHUB_CLIENT_ID:'test-client', GITHUB_CLIENT_SECRET:'test-client-secret', GITHUB_APP_SLUG:'test-app', GITHUB_WEBHOOK_SECRET: 'test-secret', RUN_TOKEN_SECRET: 'test-only-secret-at-least-32-characters' } }));
  try {
    const db = await mf.getD1Database('DB');
    const sql = await readFile('migrations/0001_factory.sql', 'utf8') + '\n' + await readFile('migrations/0002_onboarding.sql', 'utf8') + '\n' + await readFile('migrations/0003_better_auth.sql','utf8') + '\n' + await readFile('migrations/0004_private_workspaces.sql','utf8');
    // D1 exec accepts one statement per line; migration comments are removed for this helper.
    await db.exec(sql.replace(/^--.*$/gm, '').split(';').map(s => s.trim().replaceAll('\n', ' ')).filter(Boolean).join(';\n') + ';');
    await db.exec("INSERT INTO workspaces(id,name) VALUES('a','Company A'),('b','Company B');\nINSERT INTO company_domains VALUES('a.example','a',1,1),('disabled.example','b',1,0);\nINSERT INTO members(workspace,sub,role) VALUES('a','admin','admin'),('a','alice','member'),('a','colleague','member'),('b','bob','admin');\nINSERT INTO repositories VALUES('a','a/repo',1,1),('b','b/repo',2,1);");
    const cookies:Record<string,string>={};
    for (const sub of ['admin','alice','colleague','bob','newcomer']) {
      let link='';
      const auth=login({DB:db,APP_ORIGIN:'https://herbie.test',BETTER_AUTH_SECRET:'local-test-secret-with-over-32-characters',ALLOWED_EMAIL_DOMAINS:'a.example,b.example'},{async send(_email,url){link=url;}});
      await auth.handler(new Request('https://herbie.test/api/auth/sign-in/magic-link',{method:'POST',headers:{origin:'https://herbie.test','Content-Type':'application/json','cf-connecting-ip':'192.0.2.'+(Object.keys(cookies).length+1)},body:JSON.stringify({email:sub+'@'+(sub==='bob'?'b':'a')+'.example',callbackURL:'/'})}));
      const response=await mf.dispatchFetch(link,{redirect:'manual'});assert.equal(response.status,302);cookies[sub]=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
      const user=await db.prepare('SELECT id FROM user WHERE email=?').bind(sub+'@'+(sub==='bob'?'b':'a')+'.example').first<{id:string}>();
      await db.prepare('UPDATE members SET sub=? WHERE sub=?').bind('ba:'+user!.id,sub).run();
    }
    const access = new Access(db);
    await access.signIn({sub:'new-employee',domain:'a.example',name:'New',email:'new@a.example'});
    await assert.rejects(access.member('new-employee','a'));
    const request = (path: string, sub = 'alice', method = 'GET', body?: object) => mf.dispatchFetch('https://herbie.test' + path, { method, redirect:'manual',
      headers: { cookie: cookies[sub], origin: 'https://herbie.test', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.deepEqual(await (await request('/api/workspaces','newcomer')).json(),[]);
    const account=await (await request('/api/account','newcomer')).json() as {identity:{sub:string}};
    await db.prepare('INSERT INTO domain_challenges(id,sub,domain,workspace,name,token,expires) VALUES(?,?,?,?,?,?,?)').bind('old-dns',account.identity.sub,'a.example','old-pending','Pending','test-only',Date.now()+60000).run();
    assert.equal((await mf.dispatchFetch('https://herbie.test/api/onboarding/workspace',{method:'POST',headers:{origin:'https://herbie.test','Content-Type':'application/json'},body:'{"name":"Anonymous"}'})).status,401);
    assert.equal((await mf.dispatchFetch('https://herbie.test/api/onboarding/workspace',{method:'POST',headers:{cookie:cookies.newcomer,origin:'https://evil.test','Content-Type':'application/json'},body:'{"name":"Cross origin"}'})).status,403);
    const privateResponses=await Promise.all([request('/api/onboarding/workspace','newcomer','POST',{name:'Private'}),request('/api/onboarding/workspace','newcomer','POST',{name:'Private'})]);
    assert.ok(privateResponses.every(r=>r.status===200));
    const privateResults=await Promise.all(privateResponses.map(r=>r.json() as Promise<{workspace:string}>));
    assert.equal(privateResults[0].workspace,privateResults[1].workspace);
    assert.equal((await (await request('/api/workspaces','newcomer')).json() as unknown[]).length,1);
    assert.equal((await request('/api/workspaces/a/goals','newcomer')).status,403);
    assert.equal((await request('/api/workspaces/'+privateResults[0].workspace+'/goals','alice')).status,403);
    for (const route of ['company','verify','join']) assert.equal((await request('/api/onboarding/'+route,'newcomer','POST',{name:'Claim'})).status,410);
    assert.equal((await request('/api/workspaces/a/domains','admin','PATCH',{domain:'a.example',enabled:true})).status,410);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM members WHERE workspace='a'").first<{n:number}>())!.n,3);
    const page=await (await request('/')).text();
    assert.match(page,/Create your private workspace/);assert.doesNotMatch(page,/Get DNS|Verify DNS|Join company|Enable autojoin/);
    assert.equal((await request('/health')).status, 200);
    await request('/api/workspaces');
    const beforeLogout=(await db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{n:number}>())!.n;
    assert.equal((await request('/api/auth/sign-out')).status,405);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{n:number}>())!.n,beforeLogout);
    assert.equal((await request('/api/workspaces/a/goals', 'bob')).status, 403);
    assert.equal((await request('/api/workspaces/a/settings')).status, 403);
    assert.equal((await request('/api/workspaces/a/settings', 'admin')).status, 200);
    const start=await request('/api/workspaces/a/github/start','admin','POST',{});
    assert.equal(start.status,200);
    const state=new URL((await start.json() as {url:string}).url).searchParams.get('state')!;
    const callback=await request('/auth/github/callback?state='+encodeURIComponent(state)+'&code=test','admin');
    assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'https://herbie.test/?github=connected');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM github_proposals').first<{n:number}>())!.n,1);
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
