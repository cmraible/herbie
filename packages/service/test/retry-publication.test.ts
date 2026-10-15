import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import test,{type TestContext} from 'node:test';
import pg from 'pg';
import {Store} from '../src/store.js';
import {PgAuthStore,migrateAuth} from '../src/auth-store.js';
import {createAuth} from '../src/auth.js';
import {createGithub} from '../src/github.js';
import {createDemoAdapters} from '../src/demo.js';
import {createApiServer} from '../src/http.js';
import type {Adapters} from '../src/adapters.js';

const origin='https://herbie.example';
const repository='fixture-owner/fixture-project';

async function fixture(t:TestContext,options:{cancelCheck?:()=>Promise<'absent'|'pull_request_exists'|'branch_exists'>;executionEnabled?:boolean;check?:()=>Promise<'ready'|'pull_request_exists'|'branch_exists'|'base_changed'>}={}){
  const connectionString=process.env.HERBIE_TEST_DATABASE_URL;
  if(!connectionString){t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration');return null;}
  const schema='retry_publication_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString});
  await admin.query('CREATE SCHEMA '+schema);
  const pool=new pg.Pool({connectionString,options:'-c search_path='+schema});
  const store=new Store(pool);await store.migrate();await migrateAuth(pool);
  const authStore=new PgAuthStore(pool);
  const github=createGithub({appId:'fixture-app',clientId:'fixture-client',clientSecret:'fixture-secret',privateKey:'unused-fixture-key',callbackUrl:origin+'/api/auth/callback',webhookSecret:'fixture-webhook'});
  const auth=createAuth({mode:'live',allowedGithubUserId:'7',publicUrl:origin,credentialKey:Buffer.alloc(32,7).toString('base64')},authStore,github);
  let checks=0,attempts=0,publishes=0;
  const demo=createDemoAdapters();
  const adapters:Adapters={
    ...demo,
    mode:'live',
    async authorize(_userId,repo){return {repository:repo,defaultBranch:'main',installationId:11};},
    async reconciliationRepository(repo){return {repository:repo,defaultBranch:'main',installationId:11};},
    async attempt(){attempts++;throw new Error('Retry must not start another attempt');},
    async publish(execution){publishes++;return {url:'https://github.com/fixture-owner/fixture-project/pull/1',number:1,branch:execution.branch};},
    ...(options.cancelCheck?{checkUnpublished:options.cancelCheck}:{}),
    async checkPublicationRetry(){checks++;return options.check?options.check():'ready';},
  };
  const server=createApiServer({store,auth,adapters,publicUrl:origin,executionEnabled:options.executionEnabled??true});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(async()=>{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await store.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
  });
  async function session(userId='7'){
    const expiresAt=new Date(Date.now()+60_000);
    await authStore.putCredential({id:userId,login:'fixture-user'},'synthetic-encrypted-token',expiresAt);
    const token=randomBytes(32).toString('base64url');
    await authStore.createSession({tokenHash:createHash('sha256').update(token).digest('hex'),userId,expiresAt,mode:'live'});
    return {cookie:'herbie_session='+token,origin,'content-type':'application/json'};
  }
  async function retryableGoal(ownerId='7',goalRepository=repository,prewrite=false){
    const {goal}=await store.createGoal(ownerId,{repository:goalRepository,name:'Synthetic retry fixture',prompt:'Synthetic retry fixture'},'live',randomUUID());
    const worker='fixture-worker';
    const job=await store.claim(worker,30_000,'live');assert.ok(job);assert.equal(job.goal.id,goal.id);
    const patch=Buffer.from('synthetic tested patch\n');
    const baseCommit='a'.repeat(40);
    const artifact={baseCommit,patch,verification:{version:3 as const,repoUrl:'https://github.com/'+goalRepository+'.git',baseCommit,patchSha256:createHash('sha256').update(patch).digest('hex'),goalCompleted:true as const,sandboxDeleted:true as const}};
    await store.saveArtifact(job.id,worker,artifact);
    assert.equal(await store.beginPublication(job.id,worker),true);
    await store.publicationUncertain(job.id,worker,prewrite?'Publication remains unconfirmed during preflight_reconciliation (unexpected); reconciliation will check GitHub.':'Publication remains unconfirmed during branch_push (git_push_uncertain); reconciliation will check GitHub.');
    return {goal,jobId:job.id,artifact};
  }
  async function reconciledGoal(prewrite=true){
    const result=await retryableGoal('7',repository,prewrite);
    await store.pool.query('UPDATE jobs SET eligible_at=clock_timestamp() WHERE id=$1',[result.jobId]);
    const claimed=await store.claim('fixture-reconciler',30_000,'live');assert.equal(claimed?.id,result.jobId);
    await store.publicationUncertain(result.jobId,'fixture-reconciler','Publication remains unconfirmed during preflight_reconciliation (pull_request_not_found); reconciliation will check GitHub.');
    return result;
  }
  const base='http://127.0.0.1:' +address.port;
  const headersFor=(headers:Record<string,string>)=>({...headers,'content-type':'application/json'});
  return {reconciledGoal,store,authStore,base,session,retryableGoal,headersFor,get checks(){return checks;},get attempts(){return attempts;},get publishes(){return publishes;}};
}

test('retry-publication scopes ownership, requires same-origin cookie requests, and queues the saved artifact once',async t=>{
  const setup=await fixture(t);if(!setup)return;
  const {store,base,session,retryableGoal,headersFor}=setup;
  const own=await retryableGoal('7');
  const another=await retryableGoal('another-owner','other-owner/other-project');
  const headers=await session();
  const path='/api/goals/'+own.goal.id+'/retry-publication';
  const noOrigin=await fetch(base+path,{method:'POST',headers:{cookie:headers.cookie,'content-type':'application/json'},body:'{}'});
  assert.equal(noOrigin.status,403);
  const wrongOrigin=await fetch(base+path,{method:'POST',headers:headersFor({cookie:headers.cookie,origin:'https://attacker.example'}),body:'{}'});
  assert.equal(wrongOrigin.status,403);
  const hidden=await fetch(base+'/api/goals/'+another.goal.id+'/retry-publication',{method:'POST',headers,body:'{}'});
  assert.equal(hidden.status,404);
  assert.equal(setup.checks,0);

  const retry=()=>fetch(base+path,{method:'POST',headers,body:'{}'});
  const first=await retry();assert.equal(first.status,200);assert.equal((await first.json()).state,'queued');
  const second=await retry();assert.equal(second.status,200);assert.equal((await second.json()).state,'queued');
  assert.equal(setup.checks,1,'repeat request must not repeat GitHub checks or enqueue twice');
  const row=await store.pool.query<{stage:string;artifact:Record<string,unknown>|null}>('SELECT stage,artifact FROM jobs WHERE id=$1',[own.jobId]);
  assert.equal(row.rows[0]?.stage,'ready');assert.ok(row.rows[0]?.artifact);
  assert.equal(setup.attempts,0);
});

test('retry-publication respects the reconciliation lease and cannot race a claimed reconciler',async t=>{
  const setup=await fixture(t);if(!setup)return;
  const {store,base,session,retryableGoal}=setup;
  const {goal}=await retryableGoal();
  await store.pool.query('UPDATE jobs SET eligible_at=clock_timestamp() WHERE goal_id=$1',[goal.id]);
  const claimed=await store.claim('reconciler',30_000,'live');assert.ok(claimed);assert.equal(claimed.stage,'publishing');
  const headers=await session();
  const response=await fetch(base+'/api/goals/'+goal.id+'/retry-publication',{method:'POST',headers,body:'{}'});
  assert.equal(response.status,200);assert.equal((await response.json()).state,'needs_attention');
  assert.equal(setup.checks,0,'active reconciliation lease must short-circuit before GitHub checks');
  const row=await store.pool.query<{stage:string;lease_owner:string|null}>('SELECT stage,lease_owner FROM jobs WHERE id=$1',[claimed.id]);
  assert.equal(row.rows[0]?.stage,'publishing');assert.equal(row.rows[0]?.lease_owner,'reconciler');
});

test('execution-disabled service rejects saved-publication retry before repository checks',async t=>{
  const setup=await fixture(t,{executionEnabled:false});if(!setup)return;
  const {base,session,retryableGoal}=setup;
  const {goal}=await retryableGoal();const headers=await session();
  const response=await fetch(base+'/api/goals/'+goal.id+'/retry-publication',{method:'POST',headers,body:'{}'});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'Live execution is disabled by the operator'});
  assert.equal(setup.checks,0);
});

test('retry and cancel serialize safely while repository checks are in flight',async t=>{
  const entered=Promise.withResolvers<void>();const release=Promise.withResolvers<void>();
  const setup=await fixture(t,{check:async()=>{entered.resolve();await release.promise;return 'ready';}});if(!setup)return;
  const {base,session,retryableGoal}=setup;
  const {goal}=await retryableGoal();const headers=await session();
  const retry=fetch(base+'/api/goals/'+goal.id+'/retry-publication',{method:'POST',headers,body:'{}'});
  await entered.promise;
  let cancelBeforeQueue:Response;
  try{cancelBeforeQueue=await fetch(base+'/api/goals/'+goal.id+'/cancel',{method:'POST',headers,body:'{}'});}
  finally{release.resolve();}
  assert.equal(cancelBeforeQueue.status,200,'cancellation does not wait for remote preflight');
  const queued=await retry;assert.equal(queued.status,409);
  const cancelAfterQueue=await fetch(base+'/api/goals/'+goal.id+'/cancel',{method:'POST',headers,body:'{}'});
  assert.equal(cancelAfterQueue.status,200);assert.equal((await cancelAfterQueue.json()).state,'cancelled');
  assert.equal(await setup.store.claim('worker-after-cancel',30_000,'live'),null,'cancellation wins before the saved artifact is claimed');
  const row=await setup.store.pool.query<{stage:string;artifact:Record<string,unknown>|null}>('SELECT stage,artifact FROM jobs WHERE goal_id=$1',[goal.id]);
  assert.equal(row.rows[0]?.stage,'cancelled');assert.ok(row.rows[0]?.artifact);
  assert.equal(setup.attempts,0);assert.equal(setup.publishes,0);
});


test('cancel confirmed unpublished work checks ownership and CSRF, preserves evidence, and frees the repository',async t=>{
  let checks=0;
  const setup=await fixture(t,{executionEnabled:false,cancelCheck:async()=>{checks++;return 'absent';}});if(!setup)return;
  const {store,base,session,reconciledGoal}=setup;
  const {goal,jobId}=await reconciledGoal();const headers=await session();
  const path=base+'/api/goals/'+goal.id+'/cancel';
  assert.equal((await fetch(path,{method:'POST',headers:{cookie:headers.cookie}})).status,403);
  const other=await setup.retryableGoal('other-owner','other-owner/other-project');
  assert.equal((await fetch(base+'/api/goals/'+other.goal.id+'/cancel',{method:'POST',headers})).status,404);
  assert.equal(checks,0);
  const before=await store.pool.query('SELECT artifact FROM jobs WHERE id=$1',[jobId]);
  const response=await fetch(path,{method:'POST',headers});assert.equal(response.status,200);
  assert.equal((await response.json()).state,'cancelled');assert.equal(checks,0);
  assert.equal((await fetch(path,{method:'POST',headers})).status,200);assert.equal(checks,0);
  const after=await store.pool.query('SELECT stage,artifact FROM jobs WHERE id=$1',[jobId]);
  assert.equal(after.rows[0].stage,'cancelled');assert.deepEqual(after.rows[0].artifact,before.rows[0].artifact);
  assert.ok((await store.events(goal.id)).some(e=>e.type==='cancel'&&e.message.includes('retained')));
  assert.ok((await store.createGoal('7',{repository,name:'Next fixture',prompt:'Next fixture'},'live',randomUUID())).created);
  assert.equal(setup.attempts,0);assert.equal(setup.publishes,0);
});

for(const remote of ['pull_request_exists','branch_exists','error'] as const)test('cancel does not depend on remote state: '+remote,async t=>{
  const setup=await fixture(t,{cancelCheck:async()=>{if(remote==='error')throw new Error('Synthetic GitHub outage');return remote;}});if(!setup)return;
  const {goal,jobId}=await setup.reconciledGoal();
  const response=await fetch(setup.base+'/api/goals/'+goal.id+'/cancel',{method:'POST',headers:await setup.session()});
  assert.equal(response.status,200);
  assert.equal((await setup.store.getGoal(goal.id))?.state,'cancelled');
  assert.equal((await setup.store.getGoal(goal.id))?.cleanupStatus,'needs_attention');
  assert.equal((await setup.store.pool.query('SELECT stage FROM jobs WHERE id=$1',[jobId])).rows[0].stage,'cancelled');
});
