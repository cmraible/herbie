import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { Store } from '../src/store.js';
import { hasValidPublicationEvidence } from '@herbie/loop/publish-patch';

const databaseUrl = process.env.HERBIE_TEST_DATABASE_URL;
const admin = new Pool({ connectionString: databaseUrl });
let store: Store;
let schema: string;
beforeEach(async () => {
  if (!databaseUrl) return;
  schema = `store_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  store = new Store(new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` }));
  await store.migrate();
});
afterEach(async () => {
  if (!databaseUrl) return;
  await store.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin.end(); });
const integration = (name: string, fn: () => Promise<void>) => test(name, { skip: !databaseUrl }, fn);
const input = () => ({ repository: `example/repo-${randomUUID()}`, prompt: 'Fix arithmetic', maxAttempts: 2 });

integration('migration preserves old goals and artifacts while new goals need no test command', async () => {
  await store.pool.query('ALTER TABLE goals DROP COLUMN name');
  await store.pool.query('ALTER TABLE goals ALTER COLUMN test_command SET NOT NULL');
  const id = randomUUID();
  await store.pool.query(`INSERT INTO goals(id,owner_id,repository,prompt,test_command,max_attempts,mode,state)
    VALUES($1,'owner','example/repo','Legacy goal','["npm","test"]',1,'live','queued')`, [id]);
  const unicodeId = randomUUID();
  await store.pool.query(`INSERT INTO goals(id,owner_id,repository,prompt,test_command,max_attempts,mode,state)
    VALUES($1,'owner','example/repo',$2,'["npm","test"]',1,'live','queued')`, [unicodeId,'[demo:fail] \n'+ '🥁'.repeat(130)]);
  const key = randomUUID();
  const legacyRequest = {repository:'example/repo',prompt:'Legacy goal',testCommand:['npm','test'],maxAttempts:1};
  const fingerprint = createHash('sha256').update(JSON.stringify({...legacyRequest,mode:'live'})).digest('hex');
  await store.pool.query('INSERT INTO goal_requests(owner_id,request_key,fingerprint,goal_id) VALUES($1,$2,$3,$4)', ['owner',key,fingerprint,id]);
  await store.migrate();
  await store.migrate();
  assert.equal((await store.getGoal(unicodeId))?.name,'🥁'.repeat(120));
  const oldGoal = await store.getGoal(id);
  assert.equal(oldGoal?.prompt, 'Legacy goal');
  assert.equal(oldGoal?.name, 'Legacy goal');
  await store.renameGoal(id,'owner','Renamed legacy goal');
  assert.ok(!('testCommand' in oldGoal!));
  const request = {repository:'EXAMPLE/REPO',prompt:'Legacy goal',maxAttempts:1};
  const replay = await store.createGoal('owner',request,'live',key);
  assert.equal(replay.created,false);
  assert.equal(replay.goal.id,id);
  for (const change of [{prompt:'Different goal'},{repository:'example/other'},{maxAttempts:2}]) {
    await assert.rejects(store.createGoal('owner',{...request,...change},'live',key), /different request/);
  }
  await assert.rejects(store.createGoal('owner',request,'demo',key), /different request/);
  assert.ok((await store.createGoal('owner',input(),'live',randomUUID())).created);
  assert.deepEqual((await store.pool.query('SELECT test_command FROM goals WHERE id=$1',[id])).rows[0].test_command,['npm','test']);

  const baseCommit = 'a'.repeat(40), patch = Buffer.from('legacy patch');
  const evidence = {version:2,repoUrl:'https://github.com/example/repo.git',baseCommit,
    patchSha256:createHash('sha256').update(patch).digest('hex'),goalCompleted:true,sandboxDeleted:true};
  await store.pool.query("UPDATE goals SET state='needs_attention' WHERE id=$1",[id]);
  await store.pool.query(`INSERT INTO jobs(id,goal_id,cycle,branch,stage,artifact) VALUES($1,$2,1,$3,'publishing',$4)`,
    [randomUUID(),id,`herbie/${id}`,JSON.stringify({baseCommit,patchBase64:patch.toString('base64'),
      testResult:{exitCode:0,stdout:'passed',stderr:''},verification:{...evidence,testCommand:['npm','test']}})]);
  const candidate = await store.publicationRetryCandidate(id,'owner');
  assert.ok(candidate && 'job' in candidate && candidate.job.artifact);
  assert.deepEqual(candidate.job.artifact,{baseCommit,patch,verification:evidence});
  assert.ok(hasValidPublicationEvidence('example/repo',candidate.job.artifact));
});

for (const paused of [false,true]) integration(`saved artifact activity describes capture without claiming tests passed (paused: ${paused})`, async () => {
  const {goal} = await store.createGoal('owner',input(),'live',randomUUID());
  const job = await store.claim('worker');
  assert.ok(job);
  if (paused) await store.control(goal.id,'owner','pause');
  await store.saveArtifact(job.id,'worker',{baseCommit:'a'.repeat(40),patch:Buffer.from('captured patch')});
  const events = await store.events(goal.id);
  assert.equal(events.at(-1)?.message,paused ? 'Captured artifact held while paused' : 'Captured artifact saved durably');
});

integration('goals survive a new store and creation replay is scoped to owner and exact payload', async () => {
  const owner = randomUUID();
  const request = input();
  const key = randomUUID();
  const first = await store.createGoal(owner, request, 'demo', key);
  assert.equal(first.created, true);
  assert.equal(first.goal.state, 'queued');
  const fresh = new Store(store.pool);
  assert.deepEqual(await fresh.getGoal(first.goal.id, owner), first.goal);
  assert.equal(await fresh.getGoal(first.goal.id, 'another-owner'), null);
  const replay = await fresh.createGoal(owner, request, 'demo', key);
  assert.equal(replay.created, false);
  assert.equal(replay.goal.id, first.goal.id);
  await assert.rejects(store.createGoal(owner, { ...request, prompt: 'different' }, 'demo', key), /different request/);
  const concurrent = await store.createGoal('another-owner', request, 'demo', key);
  assert.equal(concurrent.created, true);
  assert.notEqual(concurrent.goal.id, first.goal.id);
  assert.equal((await store.events(first.goal.id)).length, 1);
});

integration('one worker claims work and a paused artifact resumes without repeating the attempt', async () => {
  const owner = randomUUID();
  const { goal } = await store.createGoal(owner, input(), 'demo', randomUUID());
  const claimed = await Promise.all([store.claim('worker-a'), store.claim('worker-b')]);
  const job = claimed.find(candidate => candidate !== null);
  assert.ok(job);
  assert.equal(claimed.filter(candidate => candidate !== null).length, 1);
  assert.equal(job.goal.attemptCount, 1);
  const worker = claimed[0] ? 'worker-a' : 'worker-b';
  const pausing = await store.control(goal.id, owner, 'pause');
  assert.equal(pausing.stopRequested, 'pause');
  const changes = { baseCommit: 'abc', patch: Buffer.from('tested patch'), verification: { version: 3 as const, repoUrl: 'https://github.com/example/repo', baseCommit: 'abc', patchSha256: 'sha256', goalCompleted: true, sandboxDeleted: true } };
  const held = await store.saveArtifact(job.id, worker, { ...changes, verification: { ...changes.verification, goalCompleted: true, sandboxDeleted: true } });
  assert.equal(held.goal.state, 'paused');
  assert.equal(await store.beginPublication(job.id, worker), false);
  assert.equal(await store.claim('another-worker'), null);
  await store.control(goal.id, owner, 'resume');
  const resumed = await store.claim('another-worker');
  assert.ok(resumed);
  assert.equal(resumed.stage, 'ready');
  assert.equal(resumed.goal.attemptCount, 1);
  assert.deepEqual(resumed.artifact, changes);
  assert.equal(await store.beginPublication(resumed.id, 'another-worker'), true);
  const published = await store.completePublication(resumed.id, 'another-worker', { url: 'https://github.com/example/repo/pull/1', number: 1, branch: resumed.branch });
  assert.equal(published.state, 'awaiting_review');
});

integration('expired attempts require attention and expired publications only reconcile', async () => {
  const owner = randomUUID();
  const { goal } = await store.createGoal(owner, input(), 'demo', randomUUID());
  const running = await store.claim('lost-worker', 150);
  assert.ok(running);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(await store.heartbeat(running.id, 'lost-worker'), false);
  assert.equal(await store.recoverExpired(), 1);
  assert.equal((await store.getGoal(goal.id))?.state, 'needs_attention');
  assert.equal(await store.claim('restarted-worker'), null);
  await assert.rejects(store.saveArtifact(running.id, 'lost-worker', { baseCommit: 'abc', patch: Buffer.from('late') }), /lease/);
  await store.control(goal.id, owner, 'cancel');
  const next = await store.createGoal(owner, input(), 'demo', randomUUID());
  const publishing = await store.claim('publisher', 150);
  assert.ok(publishing);
  await store.saveArtifact(publishing.id, 'publisher', { baseCommit: 'abc', patch: Buffer.from('verified') });
  await store.beginPublication(publishing.id, 'publisher');
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(await store.recoverExpired(), 1);
  const resumed = await store.claim('restarted-worker');
  assert.ok(resumed);
  assert.equal(resumed.stage, 'publishing');
  assert.equal(resumed.goal.id, next.goal.id);
  await assert.rejects(store.beginPublication(resumed.id, 'restarted-worker'), /first publication/);
  await store.publicationUncertain(resumed.id, 'restarted-worker', 'Remote publication outcome is not confirmed');
  assert.equal((await store.getGoal(next.goal.id))?.state, 'needs_attention');
  assert.equal(await store.claim('restarted-worker'), null);
});

integration('merge advances once within the attempt budget and close unmerged stops a paused goal', async () => {
  const owner = randomUUID();
  const { goal } = await store.createGoal(owner, input(), 'demo', randomUUID());
  async function publish() {
    const job = await store.claim('worker');
    assert.ok(job);
    await store.saveArtifact(job.id, 'worker', { baseCommit: 'abc', patch: Buffer.from('tested') });
    await store.beginPublication(job.id, 'worker');
    await store.completePublication(job.id, 'worker', { url: 'https://github.com/example/repo/pull/1', number: 1, branch: job.branch });
    return job;
  }
  const first = await publish();
  const reviewing = await store.reviewJobs('demo');
  assert.equal(reviewing.length, 1);
  assert.equal(reviewing[0]?.id, first.id);
  await store.control(goal.id, owner, 'pause');
  const merged = await store.reconcile(first.id, 'merged');
  assert.equal(merged.state, 'paused');
  assert.equal(merged.pullRequest?.state, 'merged');
  await store.reconcile(first.id, 'merged');
  assert.equal(await store.claim('worker'), null);
  await store.control(goal.id, owner, 'resume');
  const second = await publish();
  const completed = await store.reconcile(second.id, 'merged');
  assert.equal(completed.state, 'completed');
  assert.equal(completed.attemptCount, 2);
  assert.equal(await store.claim('worker'), null);
  await store.createGoal(owner, input(), 'demo', randomUUID());
  const unmerged = await publish();
  await store.control(unmerged.goal.id, owner, 'pause');
  assert.equal((await store.reconcile(unmerged.id, 'closed')).state, 'cancelled');
  assert.equal(await store.claim('worker'), null);
});

integration('concurrent replay creates one goal and distinct requests share a repository', async () => {
  const owner = randomUUID();
  const request = input();
  const key = randomUUID();
  const repeated = await Promise.all(Array.from({ length: 6 }, () => store.createGoal(owner, request, 'demo', key)));
  assert.equal(repeated.filter(result => result.created).length, 1);
  assert.equal(new Set(repeated.map(result => result.goal.id)).size, 1);
  const first = repeated[0];
  assert.ok(first);
  assert.equal((await store.events(first.goal.id)).length, 1);
  const repository = input().repository;
  const competing = await Promise.all([
    store.createGoal('owner-a', { ...input(), repository }, 'demo', randomUUID()),
    store.createGoal('owner-b', { ...input(), repository: repository.toUpperCase() }, 'demo', randomUUID()),
  ]);
  assert.ok(competing.every(result => result.created));
  assert.equal(new Set(competing.map(result => result.goal.id)).size, 2);
});

integration('same-repository goals execute independently and keep multiple pull requests open', async () => {
  const owner = randomUUID();
  const request = { ...input(), maxAttempts: 1 };
  const { goal: first } = await store.createGoal(owner, request, 'demo', randomUUID());
  const { goal: second } = await store.createGoal(owner, { ...request, repository: request.repository.toUpperCase() }, 'demo', randomUUID());
  const workers = ['worker-a', 'worker-b'];
  const claimed = await Promise.all(workers.map(worker => store.claim(worker)));
  assert.deepEqual(new Set(claimed.map(job => job?.goal.id)), new Set([first.id, second.id]));
  for (const [index, job] of claimed.entries()) {
    assert.ok(job);
    const worker = workers[index]!;
    await store.saveArtifact(job.id, worker, { baseCommit: 'abc', patch: Buffer.from('tested') });
    await store.beginPublication(job.id, worker);
    await store.completePublication(job.id, worker, { url: `https://github.com/example/repo/pull/${index+1}`, number: index+1, branch: job.branch });
  }
  assert.equal((await store.reviewJobs()).length, 2);
  const firstJob = claimed.find(job => job?.goal.id === first.id);
  assert.ok(firstJob);
  await store.reconcile(firstJob.id, 'merged');
  assert.equal((await store.getGoal(second.id))?.state, 'awaiting_review');
});

integration('repeated cancellation fences an in-flight worker and retains its artifact separately', async () => {
  const owner = randomUUID();
  const { goal } = await store.createGoal(owner, input(), 'demo', randomUUID());
  const job = await store.claim('worker');
  assert.ok(job);
  await store.control(goal.id, owner, 'cancel');
  await store.control(goal.id, owner, 'cancel');
  await assert.rejects(store.control(goal.id, owner, 'resume'), /cancelled/);
  const changes={baseCommit:'abc',patch:Buffer.from('retain me')};
  await assert.rejects(store.saveArtifact(job.id,'worker',changes),/lease/);
  assert.equal(await store.finishCancelled(job.id,'worker','complete',changes),true);
  assert.equal((await store.getGoal(goal.id))?.cleanupStatus,'complete');
  assert.ok((await store.pool.query('SELECT artifact FROM jobs WHERE id=$1',[job.id])).rows[0].artifact);
  assert.equal(await store.beginPublication(job.id, 'worker'), false);
  await store.control(goal.id, owner, 'cancel');
  assert.equal(await store.claim('worker'), null);
  assert.equal((await store.events(goal.id)).filter(event => event.type === 'cancel').length, 1);
  const replacement = await store.createGoal(owner, input(), 'demo', randomUUID());
  await store.control(replacement.goal.id, owner, 'cancel');
  assert.equal(await store.claim('worker'), null);
});

integration('failed work releases its repository and workers cannot claim another adapter mode', async () => {
  const owner = randomUUID();
  const request = input();
  const { goal } = await store.createGoal(owner, request, 'live', randomUUID());
  assert.equal(await store.claim('demo-worker', 30_000, 'demo'), null);
  const job = await store.claim('live-worker', 30_000, 'live');
  assert.ok(job);
  await assert.rejects(store.fail(job.id, 'wrong-worker', 'bad worker'), /lease/);
  await store.fail(job.id, 'live-worker', 'Repository tests failed');
  const failed = await store.getGoal(goal.id);
  assert.equal(failed?.state, 'failed');
  assert.equal(failed.error, 'Repository tests failed');
  const replacement = await store.createGoal(owner, request, 'live', randomUUID());
  assert.notEqual(replacement.goal.id, goal.id);
  assert.equal((await store.listGoals(owner)).length, 2);
  const events = await store.events(goal.id);
  const lastEvent = events.at(-1);
  assert.ok(lastEvent);
  assert.equal(lastEvent.type, 'failed');
  assert.deepEqual(await store.events(goal.id, lastEvent.id), []);
});

integration('event logs remain numerically ordered past ten events and cursor pages preserve that order', async () => {
  const { goal } = await store.createGoal(randomUUID(), input(), 'demo', randomUUID());
  for (const message of ['a','b','c','d','e','f','g','h','i','j','k']) await store.appendEvent(goal.id, 'attempt', message);
  assert.deepEqual((await store.events(goal.id)).map(event => event.id), [1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.deepEqual((await store.events(goal.id, 8)).map(event => event.id), [9,10,11,12]);
});

integration('names persist independently of prompts and original create requests survive renames', async () => {
  const owner = randomUUID(), key = randomUUID();
  const request = {...input(),name:'  Arithmetic cleanup  '};
  const {goal} = await store.createGoal(owner,request,'demo',key);
  assert.equal(goal.name,'Arithmetic cleanup');
  await assert.rejects(store.renameGoal(goal.id,'another-owner','Private rename'), /Goal not found/);
  for (const name of ['', '   ', 'x'.repeat(121)]) {
    await assert.rejects(store.renameGoal(goal.id,owner,name));
    await assert.rejects(store.createGoal(owner,{...request,name},'demo',randomUUID()));
  }
  const renamed = await store.renameGoal(goal.id,owner,'  Better arithmetic  ');
  assert.equal(renamed.name,'Better arithmetic');
  assert.equal(renamed.prompt,goal.prompt);
  assert.equal(renamed.state,goal.state);
  assert.equal(renamed.attemptCount,0);
  assert.equal((await new Store(store.pool).listGoals(owner))[0]?.name,'Better arithmetic');
  const replay = await store.createGoal(owner,request,'demo',key);
  assert.equal(replay.created,false);
  assert.equal(replay.goal.name,'Better arithmetic');
  for (const name of ['Different name','Better arithmetic',undefined]) {
    await assert.rejects(store.createGoal(owner,{...request,name},'demo',key), /different request/);
  }
  await store.control(goal.id,owner,'cancel');
  assert.equal((await store.renameGoal(goal.id,owner,'Finished work')).state,'cancelled');
});

integration('omitted names use the brief and replay after renaming', async () => {
  const owner = randomUUID(), key = randomUUID();
  const request = {...input(),prompt:'[demo:fail] '+ 'a'.repeat(150)};
  const {goal} = await store.createGoal(owner,request,'demo',key);
  assert.equal(goal.name,'a'.repeat(120));
  await store.renameGoal(goal.id,owner,'Short name');
  assert.equal((await store.createGoal(owner,request,'demo',key)).goal.name,'Short name');
});
