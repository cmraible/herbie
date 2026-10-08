import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createGithub } from '../src/github.js';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createAuth } from '../src/auth.js';
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
  await assert.rejects(github.authorize('ghu_fixture','alice/project'), /permission|access/i);
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
  const pr = await live.publish(execution,{baseCommit:'0'.repeat(40),patch:Buffer.alloc(0)});
  assert.deepEqual(pr,{url:'https://github.com/alice/project/pull/8',number:8,branch:'herbie/attempt-1'});
  assert.equal(requests.filter(request=>request.path==='/repos/alice/project/pulls').length,0);
  assert.equal((await live.reconcile(execution))?.state,'open');
});

test('durable OAuth binds web callbacks to the browser and CLI tokens are delivered once across restarts', {skip:!process.env.HERBIE_TEST_DATABASE_URL}, async t => {
  const {github} = await githubFixture(t);
  const schema = `auth_test_${randomUUID().replaceAll('-','')}`;
  const admin = new Pool({connectionString:process.env.HERBIE_TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({connectionString:process.env.HERBIE_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await migrateAuth(pool);
  const config = {mode:'live',publicUrl:'https://herbie.example',credentialKey:Buffer.alloc(32,1).toString('base64')};
  const auth = createAuth({...config,mode:'live'},new PgAuthStore(pool),github);
  const web = await auth.start('web');
  const state = new URL(web.url).searchParams.get('state');
  assert.ok(state);
  await assert.rejects(auth.callback('code',state,'wrong-browser'), /browser/i);
  await assert.rejects(auth.callback('code',state,web.browserState), /expired|invalid/i);
  const cli = await auth.start('cli');
  assert.ok(cli.pollToken);
  const cliState = new URL(cli.url).searchParams.get('state');
  assert.ok(cliState);
  assert.deepEqual(await auth.poll(cli.pollToken),{status:'pending'});
  const restarted = createAuth({...config,mode:'live'},new PgAuthStore(pool),github);
  const callback = await restarted.callback('code',cliState);
  assert.equal(callback.client,'cli');
  assert.equal(callback.token,undefined);
  const poll = await restarted.poll(cli.pollToken);
  assert.equal(poll.status,'complete');
  assert.ok(poll.token);
  assert.deepEqual(await restarted.session(poll.token),{mode:'live',user:{id:'7',login:'alice'}});
  assert.deepEqual(await auth.poll(cli.pollToken),{status:'expired'});
  await restarted.logout(poll.token);
  assert.equal(await auth.session(poll.token),null);
  assert.equal(await auth.userToken('7'),'ghu_fixture');
});
