import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createGithub, GithubError } from '../src/github.js';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createAuth, AuthError } from '../src/auth.js';
import { migrateAuth, PgAuthStore } from '../src/auth-store.js';
import { createLiveAdapters } from '../src/live.js';
import { goalSchema } from '@herbie/contracts';

export async function githubFixture(t: TestContext) {
  const requests: {path: string; authorization: string; body: unknown}[] = [];
  const fixture = { private: false, push: true, contents: 'write', pullRequests: 'write', pr: false, losePrResponse:false };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body: unknown = text ? JSON.parse(text) : null;
    const path = req.url ?? '';
    requests.push({path, authorization: req.headers.authorization ?? '', body});
    res.setHeader('content-type', 'application/json');
    const repository = {id: 42, full_name: 'alice/project', private: fixture.private, default_branch: 'main', permissions: {push: fixture.push}};
    if (path === '/login/oauth/access_token') res.end(JSON.stringify({access_token:'ghu_fixture',expires_in:28800}));
    else if (path === '/user') res.end(JSON.stringify({id:7,login:'alice'}));
    else if (path.startsWith('/user/installations/11/repositories')) res.end(JSON.stringify({repositories:[repository]}));
    else if (path.startsWith('/user/installations')) res.end(JSON.stringify({installations:[{id:11,permissions:{contents:fixture.contents,pull_requests:fixture.pullRequests}}]}));
    else if (path === '/repos/alice/project/installation') res.end(JSON.stringify({id:11,permissions:{contents:fixture.contents,pull_requests:fixture.pullRequests}}));
    else if (path === '/repos/alice/project') res.end(JSON.stringify(repository));
    else if (path === '/app/installations/11/access_tokens') res.end(JSON.stringify({token:'ghs_fixture',expires_at:new Date(Date.now()+3600000).toISOString()}));
    else if (path.startsWith('/repos/alice/project/pulls')) {
      const pr = {number:8,html_url:'https://github.com/alice/project/pull/8',state:'open',merged_at:null,head:{ref:'herbie/attempt-1'},base:{ref:'main'}};
      if(req.method==='POST') {
        fixture.pr=true;
        if(fixture.losePrResponse) {res.statusCode=500;res.end('{}');}
        else res.end(JSON.stringify(pr));
      } else res.end(JSON.stringify(fixture.pr ? [pr] : []));
    }
    else { res.statusCode = 404; res.end('{}'); }
  });
  server.listen(0,'127.0.0.1');
  await new Promise<void>(resolve => server.once('listening',resolve));
  t.after(() => new Promise<void>((resolve,reject) => server.close(error=>error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const keys = generateKeyPairSync('rsa',{modulusLength:2048});
  const github = createGithub({appId:'123',clientId:'Iv1.fixture',clientSecret:'test-secret',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),callbackUrl:'https://herbie.example/api/auth/callback',webhookSecret:'webhook-secret'}, {api:origin,oauth:origin});
  return {github,fixture,requests,publicKey:keys.publicKey};
}

async function authFixture(t:TestContext) {
  const {github} = await githubFixture(t);
  const schema = `auth_test_${randomUUID().replaceAll('-','')}`;
  const admin = new Pool({connectionString:process.env.HERBIE_TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({connectionString:process.env.HERBIE_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await migrateAuth(pool);
  const config = {publicUrl:'https://herbie.example',credentialKey:Buffer.alloc(32,1).toString('base64')};
  const restart = (allowedGithubUserId='7')=>createAuth({...config,allowedGithubUserId,mode:'live'},new PgAuthStore(pool),github);
  const auth = restart();
  async function pendingLogin() {
    const start=await auth.start('cli');
    assert.ok(start.pollToken && start.userCode);
    const state=new URL(start.url).searchParams.get('state');
    assert.ok(state);
    const callback=await auth.callback('code',state);
    assert.ok(callback.client==='cli');
    const pending=await auth.pendingCli(callback.approvalToken);
    return {pollToken:start.pollToken,userCode:start.userCode,approvalToken:callback.approvalToken,csrfToken:pending.csrfToken};
  }
  return {auth,restart,pendingLogin,pool,config};
}

test('authorizes only the intersection of public user-writable and installed app-writable repositories', async t => {
  const {github,fixture,requests,publicKey} = await githubFixture(t);
  assert.deepEqual(await github.authorize('ghu_fixture','alice/project'), {repository:'alice/project',defaultBranch:'main',installationId:11});
  const credential = await github.installationToken(11,'alice/project');
  assert.equal(credential,'ghs_fixture');
  assert.deepEqual(requests.find(request=>request.path==='/app/installations/11/access_tokens')?.body, {repositories:['project'],permissions:{contents:'write',pull_requests:'write'}});
  const jwt = requests.find(request=>request.path==='/app/installations/11/access_tokens')?.authorization.slice(7);
  assert.ok(jwt);
  const [header,payload,signature] = jwt.split('.');
  assert.ok(header && payload && signature);
  assert.equal(verify('RSA-SHA256',Buffer.from(`${header}.${payload}`),publicKey,Buffer.from(signature,'base64url')),true);
  fixture.push=false;
  await assert.rejects(github.authorize('ghu_fixture','alice/project'),error=>error instanceof GithubError && error.status===403);
  fixture.push=true; fixture.private=true;
  await assert.rejects(github.authorize('ghu_fixture','alice/project'), /public/i);
  fixture.private=false; fixture.contents='read';
  await assert.rejects(github.authorize('ghu_fixture','alice/project'), /permission|access/i);
});

test('recovers a successful PR creation with a lost response and never duplicates it',async t=>{
  const {github,fixture,requests} = await githubFixture(t);
  fixture.losePrResponse=true;
  const input = {repository:'alice/project',base:'main',head:'herbie/attempt-1',title:'Fix bug',body:'Verified evidence',draft:true};
  const first = await github.openPullRequest('ghs_fixture',{...input,draft:true});
  const repeated = await github.openPullRequest('ghs_fixture',{...input,draft:true});
  assert.equal(first.number,8);
  assert.deepEqual(repeated,first);
  assert.equal(requests.filter(request=>request.path==='/repos/alice/project/pulls').length,1);
});

test('review reconciliation uses only repository-scoped read permission after user login expires',async t=>{
  const {github,fixture,requests} = await githubFixture(t);
  fixture.pr=true;
  const live = createLiveAdapters({apiKey:'fixture-never-used',openaiSecretName:'existing-secret'},github,{userToken:async()=>{throw new Error('Expired login');}});
  const access = await live.reconciliationRepository('alice/project');
  assert.deepEqual(access,{repository:'alice/project',defaultBranch:'main',installationId:11});
  assert.deepEqual(requests.find(request=>request.path==='/app/installations/11/access_tokens')?.body,{repositories:['project'],permissions:{contents:'read',pull_requests:'read'}});
  fixture.private=true;
  await assert.rejects(live.reconciliationRepository('alice/project'),/public/);
});

test('checks webhook raw bytes and rejects malformed signatures', async t => {
  const {github} = await githubFixture(t);
  const body = Buffer.from('{"action":"closed"}');
  const signature = `sha256=${createHmac('sha256','webhook-secret').update(body).digest('hex')}`;
  assert.equal(github.verifyWebhook(body,signature),true);
  assert.equal(github.verifyWebhook(Buffer.from('{}'),signature),false);
  assert.equal(github.verifyWebhook(body,'sha256=x'),false);
  assert.equal(github.verifyWebhook(body,undefined),false);
});

test('live publication recovers an existing attempt PR without running Git or creating another PR', async t => {
  const {github,fixture,requests} = await githubFixture(t);
  fixture.pr=true;
  const live = createLiveAdapters({apiKey:'daytona-fixture-never-used',openaiSecretName:'existing-secret-name'},github,{userToken:async()=> 'ghu_fixture'});
  const goal = goalSchema.parse({id:randomUUID(),ownerId:'7',repository:'alice/project',prompt:'Fix bug',testCommand:['node','--test'],maxAttempts:1,attemptCount:1,state:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),mode:'live',stopRequested:null,pullRequest:null,error:null});
  const execution = {goal,repository:{repository:'alice/project',defaultBranch:'main',installationId:11},attemptId:randomUUID(),branch:'herbie/attempt-1'};
  const pr = await live.publish(execution,{baseCommit:'0'.repeat(40),patch:Buffer.alloc(0)},async()=>{});
  assert.deepEqual(pr,{url:'https://github.com/alice/project/pull/8',number:8,branch:'herbie/attempt-1'});
  assert.equal(requests.filter(request=>request.path==='/repos/alice/project/pulls').length,0);
  assert.equal((await live.reconcile(execution))?.state,'open');
});

test('durable OAuth binds web callbacks to the browser and CLI tokens are delivered once across restarts', {skip:!process.env.HERBIE_TEST_DATABASE_URL}, async t => {
  const {auth,restart,pool,config}=await authFixture(t);
  const web = await auth.start('web');
  const state = new URL(web.url).searchParams.get('state');
  assert.ok(state);
  await assert.rejects(auth.callback('code',state,'wrong-browser'),error=>error instanceof AuthError && error.status===400 && /browser/i.test(error.message));
  await assert.rejects(auth.callback('code',state,web.browserState), /expired|invalid/i);
  const cli = await auth.start('cli');
  assert.ok(cli.pollToken);
  assert.match(cli.userCode??'',/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.ok(!cli.url.includes(cli.userCode??'missing-code'));
  const cliState = new URL(cli.url).searchParams.get('state');
  assert.ok(cliState);
  assert.deepEqual(await auth.poll(cli.pollToken),{status:'pending'});
  const restarted = restart();
  const callback = await restarted.callback('code',cliState);
  assert.equal(callback.client,'cli');
  assert.equal('token' in callback,false);
  assert.equal('session' in callback,false);
  assert.deepEqual(await auth.poll(cli.pollToken),{status:'pending'},'A GitHub callback alone must not authorize a CLI');
  await migrateAuth(pool);
  await assert.rejects(auth.userToken('7'),error=>error instanceof AuthError && error.status===401);
  assert.ok(callback.client==='cli');
  const pending = await auth.pendingCli(callback.approvalToken);
  assert.equal(pending.login,'alice');
  assert.deepEqual(await restarted.decideCli(callback.approvalToken,pending.csrfToken,'approve',cli.userCode),{status:'approved'});
  const poll = await restarted.poll(cli.pollToken);
  assert.equal(poll.status,'complete');
  assert.ok(poll.token);
  assert.deepEqual(await restarted.session(poll.token),{mode:'live',user:{id:'7',login:'alice'}});
  assert.deepEqual(await auth.poll(cli.pollToken),{status:'expired'});
  await restarted.logout(poll.token);
  assert.equal(await auth.session(poll.token),null);
  assert.equal(await auth.userToken('7'),'ghu_fixture');
  const demo = createAuth({...config,mode:'demo',publicUrl:'http://127.0.0.1:3000'},new PgAuthStore(pool));
  const demoSession = await demo.demoLogin();
  assert.equal(await auth.session(demoSession.token),null,'A demo session must never become a live session when using the same database');
});

for (const decision of ['reject','wrong-code']) {
  test(`CLI ${decision} consumes approval without saving GitHub credentials or issuing a session`,{skip:!process.env.HERBIE_TEST_DATABASE_URL},async t=>{
    const {auth,restart,pendingLogin}=await authFixture(t);
    const login=await pendingLogin();
    assert.deepEqual(await auth.poll(login.pollToken),{status:'pending'});
    const code=decision==='wrong-code' ? 'AAAA-1111' : undefined;
    assert.deepEqual(await auth.decideCli(login.approvalToken,login.csrfToken,decision==='reject'?'reject':'approve',code),{status:'rejected'});
    assert.deepEqual(await restart().poll(login.pollToken),{status:'rejected'});
    await assert.rejects(auth.userToken('7'),error=>error instanceof AuthError&&error.status===401);
    await assert.rejects(auth.pendingCli(login.approvalToken),error=>error instanceof AuthError&&error.status===400);
    await assert.rejects(auth.decideCli(login.approvalToken,login.csrfToken,'approve',login.userCode),error=>error instanceof AuthError&&error.status===400);
  });
}

test('CLI approval requires its browser token and CSRF proof; cross-flow codes invalidate the request',{skip:!process.env.HERBIE_TEST_DATABASE_URL},async t=>{
  const {auth,pendingLogin}=await authFixture(t);
  const login=await pendingLogin();
  await assert.rejects(auth.pendingCli('not-the-browser-token'),error=>error instanceof AuthError&&error.status===400);
  await assert.rejects(auth.decideCli('not-the-browser-token',login.csrfToken,'approve',login.userCode),error=>error instanceof AuthError&&error.status===400);
  await assert.rejects(auth.decideCli(login.approvalToken,'wrong-csrf','approve',login.userCode),error=>error instanceof AuthError&&error.status===400);
  assert.deepEqual(await auth.poll(login.pollToken),{status:'pending'});
  const other=await pendingLogin();
  assert.deepEqual(await auth.decideCli(login.approvalToken,login.csrfToken,'approve',other.userCode),{status:'rejected'});
  await assert.rejects(auth.userToken('7'),error=>error instanceof AuthError&&error.status===401);
});

test('concurrent CLI approvals commit one grant and deliver one bearer across service instances',{skip:!process.env.HERBIE_TEST_DATABASE_URL},async t=>{
  const {auth,restart,pendingLogin}=await authFixture(t);
  const login=await pendingLogin();
  const outcomes=await Promise.allSettled([
    auth.decideCli(login.approvalToken,login.csrfToken,'approve',login.userCode),
    restart().decideCli(login.approvalToken,login.csrfToken,'approve',login.userCode),
  ]);
  assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled'&&outcome.value.status==='approved').length,1);
  assert.equal(outcomes.filter(outcome=>outcome.status==='rejected').length,1);
  const poll=await auth.poll(login.pollToken);
  assert.equal(poll.status,'complete');assert.ok(poll.token);
  assert.deepEqual(await restart().session(poll.token),{mode:'live',user:{id:'7',login:'alice'}});
  assert.deepEqual(await restart().poll(login.pollToken),{status:'expired'});
});

test('expired CLI browser approval cannot issue credentials even with the matching code',{skip:!process.env.HERBIE_TEST_DATABASE_URL},async t=>{
  const {auth,pendingLogin}=await authFixture(t);
  const login=await pendingLogin();
  t.mock.timers.enable({apis:['Date'],now:Date.now()+600_001});
  await assert.rejects(auth.pendingCli(login.approvalToken),error=>error instanceof AuthError&&error.status===400);
  await assert.rejects(auth.decideCli(login.approvalToken,login.csrfToken,'approve',login.userCode),error=>error instanceof AuthError&&error.status===400);
  assert.deepEqual(await auth.poll(login.pollToken),{status:'expired'});
  await assert.rejects(auth.userToken('7'),error=>error instanceof AuthError&&error.status===401);
});


test('owner policy rejects OAuth and pending CLI grants and invalidates existing sessions and completed polls',async t=>{
  if(!process.env.HERBIE_TEST_DATABASE_URL){t.skip('Set HERBIE_TEST_DATABASE_URL');return;}
  const {auth,restart,pendingLogin,pool}=await authFixture(t);
  const restricted=restart('8');
  for(const client of ['web','cli'] as const){
    const start=await restricted.start(client);
    const state=new URL(start.url).searchParams.get('state');assert.ok(state);
    await assert.rejects(restricted.callback('code',state,start.browserState),{status:403,message:'Access is restricted to the configured owner'});
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM auth_users')).rows[0].count,0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM auth_pending_cli')).rows[0].count,0);
  const pending=await pendingLogin();
  await assert.rejects(restricted.pendingCli(pending.approvalToken),{status:403});
  await assert.rejects(restricted.decideCli(pending.approvalToken,pending.csrfToken,'approve',pending.userCode),{status:403});
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM auth_sessions')).rows[0].count,0);
  await auth.decideCli(pending.approvalToken,pending.csrfToken,'approve',pending.userCode);
  assert.deepEqual(await restricted.poll(pending.pollToken),{status:'rejected'});
  const start=await auth.start('web');const state=new URL(start.url).searchParams.get('state');assert.ok(state);
  const callback=await auth.callback('code',state,start.browserState);assert.equal(callback.client,'web');
  if(callback.client!=='web')throw new Error('Expected web session');
  assert.ok(await auth.session(callback.token));
  assert.equal(await restricted.session(callback.token),null);
  await assert.rejects(restricted.userToken('7'),{status:403});
  await pool.query("UPDATE auth_users SET login='renamed-owner' WHERE id='7'");
  assert.equal((await auth.session(callback.token))?.user.login,'renamed-owner');
});
