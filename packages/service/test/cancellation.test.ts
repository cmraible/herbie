import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{type TestContext} from 'node:test';
import pg from 'pg';
import {Store} from '../src/store.js';
import {runWorkerOnce} from '../src/worker.js';
import {createDemoAdapters} from '../src/demo.js';
import {DaytonaAttemptError} from '@herbie/loop/daytona-attempt';

async function fixture(t:TestContext){
  const connectionString=process.env.HERBIE_TEST_DATABASE_URL;
  if(!connectionString){t.skip('Set HERBIE_TEST_DATABASE_URL');return;}
  const schema='cancel_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString});await admin.query('CREATE SCHEMA '+schema);
  const store=new Store(new pg.Pool({connectionString,options:'-c search_path='+schema}));await store.migrate();
  t.after(async()=>{await store.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
  const {goal}=await store.createGoal('owner',{repository:'demo/example',prompt:'Synthetic fixture',maxAttempts:2},'demo',randomUUID());
  return {store,goal};
}
const changes={baseCommit:'a'.repeat(40),patch:Buffer.from('retained fixture')};

test('stuck publication with undecodable App key cancels without invoking reconciliation and stays fenced',async t=>{
  const f=await fixture(t);if(!f)return;const {store,goal}=f;
  const job=await store.claim('publisher');assert.ok(job);
  await store.saveArtifact(job.id,'publisher',changes);await store.beginPublication(job.id,'publisher');
  await store.publicationUncertain(job.id,'publisher','ERR_OSSL_UNSUPPORTED');
  const result=await store.control(goal.id,'owner','cancel');
  assert.equal(result.state,'cancelled');assert.equal(result.cleanupStatus,'needs_attention');
  assert.deepEqual(await store.control(goal.id,'owner','cancel'),result);
  const adapters={...createDemoAdapters(),async reconciliationRepository(){throw new Error('Must not decode App key');},async attempt(){throw new Error('Must not spend');}};
  assert.equal(await runWorkerOnce(store,adapters,'next'),false);
  await assert.rejects(store.queueSavedPublication(job.id,'owner',job.branch,changes.baseCommit),/no longer eligible/);
  assert.equal((await store.events(goal.id)).filter(e=>e.type==='cancel').length,1);
  assert.ok((await store.pool.query('SELECT artifact FROM jobs WHERE id=$1',[job.id])).rows[0].artifact);
});

for(const cleanup of ['confirmed','unconfirmed'] as const)test('running attempt receives cancellation; cleanup '+cleanup+' never revives work',async t=>{
  const f=await fixture(t);if(!f)return;const {store,goal}=f;
  const entered=Promise.withResolvers<void>();let stopped=false,publishes=0;
  const adapters={...createDemoAdapters(),async attempt(execution:Parameters<ReturnType<typeof createDemoAdapters>['attempt']>[0]){
    entered.resolve();
    await new Promise<void>(resolve=>{if(execution.signal?.aborted)resolve();else execution.signal?.addEventListener('abort',()=>resolve(),{once:true});});
    stopped=true;const error=new DaytonaAttemptError([],'synthetic cancelled attempt');error.cleanup=cleanup;error.changes=changes;throw error;
  },async publish(){publishes++;throw new Error('Must not publish');}};
  const work=runWorkerOnce(store,adapters,'active',{leaseMs:1000,heartbeatMs:10});
  await entered.promise;
  assert.equal((await store.control(goal.id,'owner','cancel')).cleanupStatus,'pending');
  await work;assert.equal(stopped,true);assert.equal(publishes,0);
  const saved=await store.getGoal(goal.id);assert.equal(saved?.state,'cancelled');assert.equal(saved.cleanupStatus,cleanup==='confirmed'?'complete':'needs_attention');
  assert.equal(await runWorkerOnce(store,adapters,'next'),false);
  assert.ok((await store.pool.query('SELECT artifact FROM jobs WHERE goal_id=$1',[goal.id])).rows[0].artifact);
});

test('cancel fences a publisher already in flight and preserves its eventual PR as unresolved cleanup',async t=>{
  const f=await fixture(t);if(!f)return;const {store,goal}=f;
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  let fence:(()=>Promise<void>)|undefined;
  const adapters={...createDemoAdapters(),async attempt(){return changes;},async publish(execution:Parameters<ReturnType<typeof createDemoAdapters>['publish']>[0],_changes:unknown,requireLease:()=>Promise<void>){
    await requireLease();fence=requireLease;entered.resolve();await release.promise;
    return {url:'https://github.com/example/repo/pull/1',number:1,branch:execution.branch};
  }};
  const work=runWorkerOnce(store,adapters,'publisher');await entered.promise;
  await store.control(goal.id,'owner','cancel');await assert.rejects(fence!(),/lease/);
  release.resolve();await work;
  const saved=await store.getGoal(goal.id);assert.equal(saved?.state,'cancelled');assert.equal(saved.cleanupStatus,'needs_attention');assert.equal(saved.pullRequest?.number,1);
  assert.equal(await store.claim('next'),null);assert.deepEqual(await store.reviewJobs(),[]);
  const job=(await store.pool.query('SELECT id FROM jobs WHERE goal_id=$1',[goal.id])).rows[0];
  await store.reconcile(job.id,'merged');assert.equal((await store.getGoal(goal.id))?.state,'cancelled');
  assert.equal((await store.pool.query('SELECT count(*)::int n FROM jobs WHERE goal_id=$1',[goal.id])).rows[0].n,1);
});

test('late worker writes cannot overwrite cancellation and abandoned cleanup becomes visible',async t=>{
  const f=await fixture(t);if(!f)return;const {store,goal}=f;
  const job=await store.claim('lost');assert.ok(job);await store.control(goal.id,'owner','cancel');
  assert.equal(await store.heartbeat(job.id,'lost'),false);
  await assert.rejects(store.saveArtifact(job.id,'lost',changes),/lease/);
  await assert.rejects(store.fail(job.id,'lost','failure'),/lease/);
  await assert.rejects(store.publicationUncertain(job.id,'lost','failure'),/lease/);
  await store.pool.query("UPDATE jobs SET cancel_cleanup_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
  await store.recoverExpired();assert.equal((await store.getGoal(goal.id))?.cleanupStatus,'needs_attention');
  assert.equal(await store.finishCancelled(job.id,'unrelated','complete'),false);
  assert.equal((await store.getGoal(goal.id))?.state,'cancelled');
});
