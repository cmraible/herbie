import assert from 'node:assert/strict';
import {createHash,createSign,randomUUID} from 'node:crypto';
import {test,type TestContext} from 'node:test';
import {Pool} from 'pg';
import {Store} from '../src/store.js';
import {runWorkerOnce} from '../src/worker.js';
import {publicationBackoffMs} from '../src/publication-backoff.js';
import {createDemoAdapters} from '../src/demo.js';
import {PublicationBlockedError,type Adapters,type PullRequest,type PublicationRetryCheck} from '../src/adapters.js';

async function fixture(t:TestContext){
  const connectionString=process.env.HERBIE_TEST_DATABASE_URL;
  if(!connectionString){t.skip('Set HERBIE_TEST_DATABASE_URL');return null;}
  const schema='auto_publish_'+randomUUID().replaceAll('-','');
  const admin=new Pool({connectionString});await admin.query('CREATE SCHEMA '+schema);
  const pool=new Pool({connectionString,options:'-c search_path='+schema});
  const store=new Store(pool,()=>0);await store.migrate();
  t.after(async()=>{await store.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
  t.mock.method(console,'error',()=>{});
  const {goal}=await store.createGoal('owner',{repository:'alice/project',name:'Fixture only',prompt:'Fixture only'},'live',randomUUID());
  const baseCommit='a'.repeat(40),patch=Buffer.from('verified fixture patch');
  const artifact={baseCommit,patch,verification:{version:3 as const,repoUrl:'https://github.com/alice/project.git',baseCommit,patchSha256:createHash('sha256').update(patch).digest('hex'),goalCompleted:true as const,sandboxDeleted:true as const}};
  let attempts=0,publishes=0;let remote:PullRequest|null=null;let check:PublicationRetryCheck='ready';
  const access={repository:goal.repository,defaultBranch:'main',installationId:1};
  const adapters:Adapters={...createDemoAdapters(),mode:'live',
    async authorize(){return access;},async reconciliationRepository(){return access;},
    async attempt(){attempts++;return artifact;},
    async reconcile(){return remote;},async checkPublicationRetry(){return check;},
    async publish(execution,_artifact,requireLease){await requireLease();publishes++;remote={url:'https://github.com/alice/project/pull/1',number:1,branch:execution.branch,state:'open'};return remote;},
  };
  const row=async()=>{const r=await pool.query('SELECT * FROM jobs WHERE goal_id=$1',[goal.id]);return r.rows[0]!;};
  const due=async()=>{await pool.query('UPDATE jobs SET eligible_at=clock_timestamp() WHERE goal_id=$1',[goal.id]);};
  async function legacy(){const job=await store.claim('old',30_000,'live');assert.ok(job);await store.saveArtifact(job.id,'old',artifact);await store.beginPublication(job.id,'old');await store.publicationUncertain(job.id,'old','preflight_reconciliation (pull_request_not_found)');await due();}
  return {store,pool,goal,artifact,adapters,row,due,legacy,get attempts(){return attempts;},get publishes(){return publishes;},set check(v:PublicationRetryCheck){check=v;}};
}

test('persisted backoff uses bounded equal jitter and caps without overflow',()=>{
  assert.equal(publicationBackoffMs(1,()=>0),30_000);assert.equal(publicationBackoffMs(1,()=>1),60_000);
  assert.equal(publicationBackoffMs(2,()=>0),60_000);assert.equal(publicationBackoffMs(100,()=>1),900_000);
});

test('initial JWT signing failure recovers the saved artifact after credentials are fixed without another attempt',async t=>{
  const f=await fixture(t);if(!f)return;
  const reconcile=f.adapters.reconcile;
  f.adapters.reconcile=async()=>{createSign('RSA-SHA256').update('synthetic').sign('invalid fixture key');return null;};
  await runWorkerOnce(f.store,f.adapters,'first');
  assert.equal((await f.store.getGoal(f.goal.id))?.state,'needs_attention');assert.equal(f.attempts,1);
  assert.match((await f.store.getGoal(f.goal.id))?.error??'',/Automatic publication recovery #1 scheduled for/);
  assert.equal(await runWorkerOnce(f.store,f.adapters,'too-early'),false);
  f.adapters.reconcile=reconcile;await f.due();
  await runWorkerOnce(new Store(f.pool,()=>0),f.adapters,'restarted');
  assert.equal((await f.store.getGoal(f.goal.id))?.state,'awaiting_review');assert.equal((await f.store.getGoal(f.goal.id))?.attemptCount,1);
  assert.equal(f.attempts,1);assert.equal(f.publishes,1);assert.equal((await f.row()).publication_retry_count,0);
});

test('legacy missing-PR jobs recover automatically and network failures preserve increasing deadlines across workers',async t=>{
  const f=await fixture(t);if(!f)return;await f.legacy();
  f.adapters.checkPublicationRetry=async()=>{throw new TypeError('fixture network failure');};
  let before=Date.now();await runWorkerOnce(f.store,f.adapters,'second');let row=await f.row();
  assert.equal(row.publication_retry_count,2);assert.ok(row.eligible_at.getTime()>=before+60_000);
  const deadline=row.eligible_at.getTime();const restarted=new Store(f.pool,()=>0);
  await restarted.migrate();assert.equal((await f.row()).eligible_at.getTime(),deadline);
  assert.equal(await runWorkerOnce(restarted,f.adapters,'early'),false);
  await f.due();before=Date.now();await runWorkerOnce(restarted,f.adapters,'third');row=await f.row();
  assert.equal(row.publication_retry_count,3);assert.ok(row.eligible_at.getTime()>=before+120_000);
  f.adapters.checkPublicationRetry=async()=>'ready';await f.due();await runWorkerOnce(restarted,f.adapters,'fixed');
  assert.equal(f.attempts,0);assert.equal(f.publishes,1);assert.equal((await f.store.getGoal(f.goal.id))?.attemptCount,1);
});

for(const conflict of ['branch_exists','base_changed'] as const)test(`safety conflict ${conflict} stops automatic writes while retaining saved work`,async t=>{
  const f=await fixture(t);if(!f)return;await f.legacy();f.check=conflict;
  await runWorkerOnce(f.store,f.adapters,'recovery');const row=await f.row();
  assert.equal(row.publication_blocked,true);assert.ok(row.artifact);assert.equal(f.publishes,0);
  assert.match((await f.store.getGoal(f.goal.id))?.error??'',/Automatic publication recovery stopped/);
  await f.due();assert.equal(await runWorkerOnce(f.store,f.adapters,'later'),false);
});

test('ambiguous successful PR creation is reconciled without duplicate writes',async t=>{
  const f=await fixture(t);if(!f)return;const publish=f.adapters.publish;
  f.adapters.publish=async(...args)=>{await publish(...args);throw new TypeError('response lost after remote commit');};
  await runWorkerOnce(f.store,f.adapters,'first');await f.due();await runWorkerOnce(f.store,f.adapters,'recovery');
  assert.equal(f.attempts,1);assert.equal(f.publishes,1);assert.equal((await f.store.getGoal(f.goal.id))?.state,'awaiting_review');
});

test('a PR appearing during the retry preflight is reconciled on the next tick, never republished',async t=>{
  const f=await fixture(t);if(!f)return;await f.legacy();f.check='pull_request_exists';
  await runWorkerOnce(f.store,f.adapters,'racing');assert.equal(f.publishes,0);assert.equal((await f.row()).publication_blocked,false);
  const row=await f.row();f.adapters.reconcile=async()=>({url:'https://github.com/alice/project/pull/2',number:2,branch:row.branch,state:'open'});
  await f.due();await runWorkerOnce(f.store,f.adapters,'confirm');assert.equal(f.publishes,0);assert.equal((await f.store.getGoal(f.goal.id))?.state,'awaiting_review');
});

for(const mode of ['cancel','lease-loss'] as const)test(`${mode} during awaited retry checks fences publication`,async t=>{
  const f=await fixture(t);if(!f)return;await f.legacy();
  f.adapters.checkPublicationRetry=async()=>{
    if(mode==='cancel')await f.store.control(f.goal.id,'owner','cancel');
    else await f.pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE goal_id=$1",[f.goal.id]);
    return 'ready';
  };
  await runWorkerOnce(f.store,f.adapters,'recovery');assert.equal(f.publishes,0);assert.equal(f.attempts,0);
  if(mode==='cancel'){assert.equal((await f.store.getGoal(f.goal.id))?.state,'cancelled');await f.due();assert.equal(await runWorkerOnce(f.store,f.adapters,'later'),false);}
});

test('saved ready artifact authorization failure remains eligible for publication recovery',async t=>{
  const f=await fixture(t);if(!f)return;const job=await f.store.claim('old',30_000,'live');assert.ok(job);await f.store.saveArtifact(job.id,'old',f.artifact);
  await f.pool.query('UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1',[job.id]);
  f.adapters.reconciliationRepository=async()=>{throw new TypeError('auth unavailable');};
  await runWorkerOnce(f.store,f.adapters,'recovery');assert.equal((await f.row()).stage,'publishing');assert.equal((await f.row()).publication_retry_count,1);assert.equal(f.attempts,0);
});

test('ambiguous branch push without a confirmed PR cannot be replayed or overwrite that branch',async t=>{
  const f=await fixture(t);if(!f)return;
  let writes=0;
  f.adapters.publish=async()=>{writes++;f.check='branch_exists';throw new TypeError('connection lost after branch creation');};
  await runWorkerOnce(f.store,f.adapters,'first');await f.due();await runWorkerOnce(f.store,f.adapters,'recover');
  assert.equal(writes,1);assert.equal(f.attempts,1);assert.equal((await f.row()).publication_blocked,true);
  await f.due();assert.equal(await runWorkerOnce(f.store,f.adapters,'later'),false);
});

test('corrupt saved evidence blocks recovery before any remote write',async t=>{
  const f=await fixture(t);if(!f)return;await f.legacy();
  await f.pool.query("UPDATE jobs SET artifact=jsonb_set(artifact,'{verification,patchSha256}','\"wrong\"') WHERE goal_id=$1",[f.goal.id]);
  await runWorkerOnce(f.store,f.adapters,'recover');assert.equal((await f.row()).publication_blocked,true);assert.equal(f.publishes,0);assert.equal(f.attempts,0);
});


test('identical capped retries update status without flooding the event feed; changed failures remain visible',async t=>{
  const f=await fixture(t);if(!f)return;
  f.adapters.reconcile=async()=>{throw new TypeError('fixture network failure');};
  for(let i=0;i<10;i++){
    await runWorkerOnce(new Store(f.pool,()=>0),f.adapters,'retry-'+i);await f.due();
  }
  const events=async()=> (await f.pool.query('SELECT type,message FROM goal_events WHERE goal_id=$1 ORDER BY id',[f.goal.id])).rows;
  const before=await events();
  assert.equal(before.filter(e=>e.type==='publication_uncertain').length,5);
  assert.equal(before.filter(e=>e.type==='work_resumed'||e.type==='diagnostic_reference').length,0);
  assert.equal(before.filter(e=>e.type==='publication_phase').length,1);
  assert.match((await f.store.getGoal(f.goal.id))?.error??'',/recovery #10 scheduled for .*Failure reference:/);
  assert.equal(f.attempts,1);assert.equal(f.publishes,0);
  f.adapters.reconcile=async()=>null;
  f.adapters.checkPublicationRetry=async()=>'pull_request_exists';
  await runWorkerOnce(f.store,f.adapters,'changed-cause');
  assert.equal((await events()).filter(e=>e.type==='publication_uncertain').length,6);
  assert.match((await f.store.getGoal(f.goal.id))?.error??'',/pull request appeared.*recovery #11 scheduled for/);
  const row=await f.row();
  f.adapters.reconcile=async()=>({url:'https://github.com/alice/project/pull/2',number:2,branch:row.branch,state:'open'});
  await f.due();await runWorkerOnce(f.store,f.adapters,'recovered');
  assert.equal((await events()).filter(e=>e.type==='pull_request_opened').length,1);
  assert.equal((await f.store.getGoal(f.goal.id))?.state,'awaiting_review');
});

for (const recovering of [false, true]) test(`permanent publication failures stop automatic recovery (recovering: ${recovering})`, async t => {
  const f = await fixture(t); if (!f) return;
  if (recovering) await f.legacy();
  f.adapters.publish = async () => { throw new PublicationBlockedError('Saved artifact has no agent-authored pull request description'); };
  await runWorkerOnce(f.store, f.adapters, 'publisher');
  const row = await f.row();
  assert.equal(row.publication_blocked, true);
  assert.ok(row.artifact);
  assert.match((await f.store.getGoal(f.goal.id))?.error ?? '', /no agent-authored pull request description/);
  await f.due();
  assert.equal(await runWorkerOnce(f.store, f.adapters, 'later'), false);
});
