import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runCodexAttempt } from '../src/codex-process.js';

const fixture = fileURLToPath(new URL('./fixtures/goal-attempt.ts', import.meta.url));
const posix = { skip: process.platform === 'win32', timeout: 10_000 };
const goal = 'Fix addition without changing the tests';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function exists(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}
function messages(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes: unknown[] = error.errors;
    return error.message + '\n' + causes.map(messages).join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}
async function setup(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'herbie-attempt-')));
  const record = join(cwd, 'events');
  const events = async (): Promise<unknown[]> => {
    const text = await readFile(record, 'utf8').catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
      throw error;
    });
    return text.trim().split('\n').filter(Boolean).map(line => { const event: unknown = JSON.parse(line); return event; });
  };
  t.after(async () => {
    const [first] = await events();
    if (object(first) && typeof first.pid === 'number' && exists(-first.pid)) process.kill(-first.pid, 'SIGKILL');
    await rm(cwd, { recursive: true, force: true });
  });
  const gone = async () => {
    const logged = await events();
    const first = logged[0];
    assert.ok(object(first) && typeof first.pid === 'number');
    assert.equal(exists(-first.pid), false);
    for (const event of logged) {
      if (object(event) && typeof event.workerPid === 'number') assert.equal(exists(event.workerPid), false);
    }
  };
  return { cwd, record, events, gone };
}

test('runs initialize → thread → goal → completion and cleans up its process group', posix, async t => {
  const { cwd, record, events, gone } = await setup(t);
  await runCodexAttempt(process.execPath, [fixture, 'success', record], {
    cwd: relative(process.cwd(), cwd), goal, shutdownMs: 100,
  });
  const logged = await events();
  const first = logged[0];
  assert.ok(object(first));
  assert.equal(first.cwd, cwd);
  assert.deepEqual(logged.filter(event => object(event) && 'method' in event), [
    { id: 0, method: 'initialize', params: { clientInfo: { name: 'herbie', version: '0.1.0' } } },
    { method: 'initialized' },
    { id: 1, method: 'thread/start', params: { cwd, ephemeral: true } },
    { id: 2, method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: goal }] } },
  ]);
  assert.deepEqual(logged.slice(-2), [{ completed: 'completed' }, { eof: true }]);
  await gone();
});

for (const [mode, expected] of [
  ['init-fail', 'Codex initialization failed'],
  ['thread-fail', 'Codex thread start failed'],
  ['turn-fail', 'Codex turn failed'],
  ['turn-exit', 'Codex process exited unsuccessfully'],
  ['cleanup-fail', 'Codex process exited unsuccessfully'],
  ['timeout', 'Codex turn timed out'],
  ['interrupt-unconfirmed', 'Codex turn termination unconfirmed'],
]) {
  test(`attempt rejects ${mode} after group cleanup`, posix, async t => {
    const { cwd, record, events, gone } = await setup(t);
    await assert.rejects(runCodexAttempt(process.execPath, [fixture, mode, record], {
      cwd, goal, turnTimeoutMs: 200, interruptTimeoutMs: 200, shutdownMs: 100,
    }), error => {
      assert.ok(error instanceof AggregateError);
      assert.ok(messages(error).includes(expected));
      return true;
    });
    const logged = await events();
    if (mode === 'init-fail' || mode === 'thread-fail') {
      assert.equal(logged.some(event => object(event) && event.method === 'turn/start'), false);
    }
    if (mode === 'timeout' || mode === 'interrupt-unconfirmed') {
      assert.equal(logged.filter(event => object(event) && event.method === 'turn/interrupt').length, 1);
    }
    await gone();
  });
}

test('abort interrupts the active turn before closing its transport', posix, async t => {
  const { cwd, record, events, gone } = await setup(t);
  const controller = new AbortController();
  const rejected = assert.rejects(runCodexAttempt(process.execPath, [fixture, 'cancel', record], {
    cwd, goal, signal: controller.signal, shutdownMs: 100,
  }), error => {
    assert.match(messages(error), /cancelled/);
    return true;
  });
  try {
    const deadline = performance.now() + 3_000;
    while (!(await events()).some(event => object(event) && event.active === true)) {
      if (performance.now() > deadline) throw new Error('Fixture readiness timed out');
      await delay(10);
    }
  } finally { controller.abort(); }
  await rejected;
  assert.deepEqual((await events()).slice(-2), [{ completed: 'interrupted' }, { eof: true }]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await gone();
});
