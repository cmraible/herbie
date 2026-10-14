import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { Store } from '../src/store.js';
import { createDemoAdapters } from '../src/demo.js';
import { runWorkerOnce } from '../src/worker.js';

// A real database and an explicitly simulated external executor: no sandbox/model spend.
test('worker completes queued work after the initiating client disconnects and does not duplicate publication', async t => {
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration');
  const schema = `worker_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({connectionString:database});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const store = new Store(new pg.Pool({connectionString:database,options:`-c search_path=${schema}`}));
  t.after(async () => { await store.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await store.migrate();
  const {goal} = await store.createGoal('demo-user',{repository:'demo/example',prompt:'Fix arithmetic',maxAttempts:1},'demo',randomUUID());
  const adapters = createDemoAdapters();
  await runWorkerOnce(store, adapters, 'worker-one');
  const after = await store.getGoal(goal.id);
  assert.equal(after?.state,'awaiting_review');
  assert.ok(after?.pullRequest);
  await runWorkerOnce(store, adapters, 'worker-two');
  assert.deepEqual((await store.getGoal(goal.id))?.pullRequest,after.pullRequest);
});

test('merged demo work starts a distinct bounded attempt and a simulated failure stops', async t => {
  const database=process.env.HERBIE_TEST_DATABASE_URL;
  if(!database)return t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration');
  const schema=`worker_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:database});await admin.query(`CREATE SCHEMA ${schema}`);
  const store=new Store(new pg.Pool({connectionString:database,options:`-c search_path=${schema}`}));
  t.after(async()=>{await store.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await store.migrate();
  const {goal}=await store.createGoal('demo-user',{repository:'demo/example',prompt:'Fix arithmetic',maxAttempts:2},'demo',randomUUID());
  const adapters=createDemoAdapters();await runWorkerOnce(store,adapters,'worker-one');
  const [job]=await store.reviewJobs();assert.ok(job);
  const first=(await store.getGoal(goal.id))?.pullRequest;assert.ok(first);
  await store.reconcile(job.id,'merged');
  await runWorkerOnce(store,adapters,'restarted-worker');
  const next=await store.getGoal(goal.id);assert.equal(next?.state,'awaiting_review');assert.equal(next.attemptCount,2);
  assert.notEqual(next.pullRequest?.branch,first.branch);
  const [second]=await store.reviewJobs();assert.ok(second);await store.reconcile(second.id,'merged');
  assert.equal((await store.getGoal(goal.id))?.state,'completed');
  assert.equal(await runWorkerOnce(store,adapters,'worker-one'),false);
  const {goal:failed}=await store.createGoal('demo-user',{repository:'demo/example',prompt:'[demo:fail]',maxAttempts:1},'demo',randomUUID());
  await runWorkerOnce(store,adapters,'worker-one');
  assert.equal((await store.getGoal(failed.id))?.state,'failed');
  assert.equal((await store.getGoal(failed.id))?.pullRequest,null);
});

test('worker retains raw redacted causes privately and persists safe attempt reference without retry',async t=>{
  const database=process.env.HERBIE_TEST_DATABASE_URL;if(!database)return t.skip('Set HERBIE_TEST_DATABASE_URL');
  const {DaytonaAttemptError}=await import('@herbie/loop/daytona-attempt');
  const schema='diagnostic_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:database});await admin.query('CREATE SCHEMA '+schema);
  const store=new Store(new pg.Pool({connectionString:database,options:'-c search_path='+schema}));
  t.after(async()=>{await store.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await store.migrate();
  const {goal}=await store.createGoal('fixture-user',{repository:'demo/example',prompt:'Fixture',maxAttempts:1},'demo',randomUUID());
  const output:string[]=[];t.mock.method(console,'error',(line:string)=>output.push(line));
  const error=new DaytonaAttemptError([Object.assign(new Error('setup failed'),{stderr:'useful synthetic failure',authorization:'hidden-fixture-token'})],'wrapped failure');
  error.diagnostics=[{stage:'repository_clone',cause:'http_error',httpStatus:503}];error.cleanup='confirmed';
  let attempts=0;const adapters={...createDemoAdapters(),async attempt(){attempts++;throw error;}};
  await runWorkerOnce(store,adapters,'fixture-worker');
  const saved=await store.getGoal(goal.id);assert.equal(saved?.state,'needs_attention');assert.match(saved?.error??'',/repository_clone: http_error; HTTP 503/);assert.match(saved?.error??'',/Sandbox deletion confirmed/);
  const record=JSON.parse(output.find(line=>line.includes('herbie_failure'))!);assert.ok(saved?.error?.includes(record.errorId));assert.equal(record.context.goalId,goal.id);
  assert.match(JSON.stringify(record),/useful synthetic failure/);assert.ok(!JSON.stringify(record).includes('hidden-fixture-token'));assert.ok(!saved?.error?.includes('useful synthetic failure'));
  assert.equal(await runWorkerOnce(store,adapters,'fixture-worker'),false);assert.equal(attempts,1);
});
