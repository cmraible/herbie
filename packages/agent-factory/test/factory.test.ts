import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoal, reserve, outstanding } from '../src/core/model.js';

test('pending reservations count toward the default outstanding PR target', () => {
  const goal = createGoal('g', 'w', 'owner/repo', 'Improve reliability');
  reserve(goal, 100);
  reserve(goal, 101);
  assert.equal(outstanding(goal), 1);
  assert.equal(goal.runs.length, 1);
  assert.equal(goal.runs[0].prompt, 'Improve reliability');
});
import { editGoal, feedback } from '../src/core/model.js';
import { change } from '../src/core/ports.js';
import { Factory } from '../src/core/engine.js';
import { MemoryStore, FakeRepository, FakeExecution } from './fakes.js';
function setup(target = 1) {
  const store = new MemoryStore(createGoal('g', 'w', 'owner/repo', 'Improve reliability', target));
  const repo = new FakeRepository(), executor = new FakeExecution();
  let time = 1000;
  return { store, repo, executor, factory: new Factory(store, repo, executor, () => time), elapse: () => time += 31 * 60000 };
}
test('full loop: create, review repair, CI repair, verified merge, next increment', async () => {
  const { store, repo, factory } = setup();
  await factory.tick('g'); await factory.tick('g');
  assert.equal(repo.prs.length, 1);
  await change(store, 'g', g => { feedback(g, 'review-1', 1, 'Add a regression test'); feedback(g, 'review-1', 1, 'duplicate'); });
  await factory.tick('g'); await factory.tick('g');
  assert.equal((await store.goal()).runs[1].feedback.length, 1);
  await change(store, 'g', g => feedback(g, 'ci-1', 1, 'Fix CI: test suite failed'));
  await factory.tick('g'); await factory.tick('g');
  assert.equal((await store.goal()).runs[2].kind, 'repair');
  repo.prs[0].state = 'merged';
  await factory.tick('g'); await factory.tick('g');
  assert.equal(repo.prs.length, 2);
  assert.equal(outstanding(await store.goal()), 1);
});
test('concurrent ticks reserve capacity once; prompt edits do not mutate running snapshots', async () => {
  const { store, factory, executor } = setup(2);
  executor.result = { status: 'running' };
  await Promise.all(Array.from({ length: 10 }, () => factory.tick('g')));
  await change(store, 'g', g => editGoal(g, 'New goal', 1, 'active'));
  const g = await store.goal();
  assert.equal(g.runs.length, 2);
  assert.equal(g.runs[0].prompt, 'Improve reliability');
  assert.equal(g.version, 2);
  assert.equal(executor.jobs.size, 1);
});
test('publication response loss recovers the same PR without releasing its slot', async () => {
  const { store, repo, factory } = setup();
  await factory.tick('g'); repo.losePublishResponse = true;
  await assert.rejects(factory.tick('g'));
  assert.equal(outstanding(await store.goal()), 1);
  await factory.tick('g');
  assert.equal(repo.prs.length, 1);
  assert.equal((await store.goal()).runs[0].status, 'done');
});
test('closed without merge pauses, including delayed duplicate feedback', async () => {
  const { store, repo, factory } = setup();
  await factory.tick('g'); await factory.tick('g');
  repo.prs[0].state = 'closed'; await factory.tick('g');
  await change(store, 'g', g => feedback(g, 'late', 1, 'late review'));
  await factory.tick('g');
  assert.equal((await store.goal()).status, 'paused');
  assert.equal((await store.goal()).runs.length, 1);
});
test('VM loss and stopped processes retry at most three times then escalate', async () => {
  const { store, executor, factory } = setup(); executor.result = { status: 'lost' };
  await factory.tick('g'); await factory.tick('g'); await factory.tick('g'); await factory.tick('g');
  assert.equal((await store.goal()).runs[0].attempt, 3);
  assert.match((await store.goal()).reason!, /human intervention/);
  assert.equal(executor.jobs.size, 0);
});
test('crash lease expires and timed-out attempt is terminated before recovery', async () => {
  const { store, factory, executor, elapse } = setup(); executor.result = { status: 'running' };
  await factory.tick('g');
  await change(store, 'g', g => { g.lease = { owner: 'dead-worker', until: 121000 }; });
  await factory.tick('g'); elapse(); await factory.tick('g');
  assert.equal((await store.goal()).runs[0].attempt, 2);
  assert.equal(executor.jobs.size, 0);
});
test('repeated successful repairs with failing CI eventually require human intervention', async () => {
  const { store, factory } = setup();
  await factory.tick('g'); await factory.tick('g');
  for (let cycle = 0; cycle < 6; cycle++) {
    await change(store, 'g', g => feedback(g, `failure-${cycle}`, 1, 'Still failing'));
    await factory.tick('g'); await factory.tick('g');
  }
  assert.equal((await store.goal()).runs.filter(r => r.kind === 'repair').length, 5);
  assert.match((await store.goal()).reason!, /5 repair runs/);
  await change(store, 'g', g => editGoal(g, g.prompt, g.target, 'active'));
  await factory.tick('g');
  assert.equal((await store.goal()).runs.filter(r => r.kind === 'repair').length, 6);
});
test('pausing terminates execution even when GitHub is unavailable', async () => {
  const { store, repo, executor, factory } = setup();
  await factory.tick('g'); await factory.tick('g');
  await change(store, 'g', g => feedback(g, 'review', 1, 'fix'));
  executor.result = { status: 'running' }; await factory.tick('g');
  await change(store, 'g', g => { g.status = 'paused'; });
  repo.inspect = async () => { throw new Error('GitHub unavailable'); };
  await factory.tick('g');
  assert.equal(executor.jobs.size, 0);
  assert.equal((await store.goal()).runs.at(-1)!.status, 'suspended');
});
import { executionPrompt } from '../src/core/policy.js';
test('a reopened PR counts toward capacity after a human resumes the goal', async () => {
  const { store, repo, factory } = setup();
  await factory.tick('g'); await factory.tick('g');
  repo.prs[0].state = 'closed'; await factory.tick('g');
  repo.prs[0].state = 'open';
  await change(store, 'g', g => editGoal(g, g.prompt, g.target, 'active'));
  await factory.tick('g');
  assert.equal(outstanding(await store.goal()), 1);
  assert.equal((await store.goal()).runs.length, 1);
});
test('broad goals instruct one small problem with proportionate verification and problem-first summaries', () => {
  const g = createGoal('g', 'w', 'owner/repo', 'Fix reliability, improve performance, and clean up the UI');
  reserve(g, 1);
  const prompt = executionPrompt(g.runs[0]);
  assert.match(prompt, /Solve only one problem/);
  assert.match(prompt, /couple of lines/);
  assert.match(prompt, /not a numeric line cap/);
  assert.match(prompt, /proportionate verification/);
  assert.match(prompt, /Lead with the concrete problem/);
  assert.match(prompt, /choose one small next step/);
});
test('pause after a lost publication response preserves the PR reservation across resume', async () => {
  const { store, repo, factory } = setup();
  await factory.tick('g'); repo.losePublishResponse = true;
  await assert.rejects(factory.tick('g'));
  await change(store, 'g', g => editGoal(g, g.prompt, g.target, 'paused'));
  await factory.tick('g');
  assert.equal(outstanding(await store.goal()), 1);
  await change(store, 'g', g => editGoal(g, g.prompt, g.target, 'active'));
  await factory.tick('g');
  assert.equal(repo.prs.length, 1);
  assert.equal((await store.goal()).runs.length, 1);
});
test('pause and resume preserves repair feedback and creates a fresh VM attempt', async () => {
  const { store, executor, factory } = setup();
  await factory.tick('g'); await factory.tick('g');
  await change(store, 'g', g => feedback(g, 'review', 1, 'Fix the parser'));
  executor.result = { status: 'running' }; await factory.tick('g');
  await change(store, 'g', g => editGoal(g, g.prompt, g.target, 'paused')); await factory.tick('g');
  await change(store, 'g', g => editGoal(g, g.prompt, g.target, 'active')); await factory.tick('g');
  const repaired = (await store.goal()).runs.at(-1)!;
  assert.deepEqual(repaired.feedback, ['Fix the parser']); assert.equal(repaired.attempt, 2);
  assert.equal(executor.jobs.size, 1);
});
