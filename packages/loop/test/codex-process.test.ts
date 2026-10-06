import assert from 'node:assert/strict';
import childProcess, { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { once, getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeCodexProcess } from '../src/codex-process.js';

const fixture = fileURLToPath(new URL('./fixtures/app-server.ts', import.meta.url));
const treeFixture = fileURLToPath(new URL('./fixtures/process-tree.ts', import.meta.url));
const posix = { skip: process.platform === 'win32', timeout: 10_000 };

function exists(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function tree(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'herbie-process-'));
  const record = join(directory, 'pids');
  const contents = () => readFile(record, 'utf8').catch(error => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  });
  const pids = async () => (await contents()).trim().split('\n').filter(line => /^\d+$/.test(line)).map(Number);
  t.after(async () => {
    const [leader] = await pids();
    if (leader !== undefined && exists(-leader)) {
      process.kill(-leader, 'SIGKILL');
      const deadline = performance.now() + 1_000;
      while (exists(-leader)) {
        if (performance.now() > deadline) throw new Error('Fixture group cleanup unconfirmed');
        await delay(10);
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const ready = async (marker = 'ready') => {
    const deadline = performance.now() + 3_000;
    while (!(await contents()).includes(`${marker}\n`)) {
      if (performance.now() > deadline) throw new Error('Fixture readiness timed out');
      await delay(10);
    }
  };
  const assertGone = async () => {
    const ids = await pids();
    assert.equal(ids.length, 3);
    for (const pid of ids) assert.equal(exists(pid), false, `fixture PID ${pid} survived`);
    const [leader] = ids;
    assert.ok(leader !== undefined);
    assert.equal(exists(-leader), false);
  };
  return { record, ready, pids, assertGone };
}

for (const mode of ['normal', 'flush']) {
  test(`initializes and drains ${mode} shutdown output`, posix, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'herbie-exit-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const exitRecord = join(directory, 'exit');
    await initializeCodexProcess(process.execPath, [fixture, mode, exitRecord]);
    // SIGTERM/SIGKILL cannot run the fixture's exit handler.
    assert.equal(await readFile(exitRecord, 'utf8'), '0');
  });
}

for (const stream of ['stdin', 'stdout', 'stderr']) {
  test(`rejects ${stream} errors and confirms owned group cleanup`, posix, async t => {
    const originalSpawn = childProcess.spawn;
    let child: ChildProcessWithoutNullStreams | undefined;
    // Inject a stream fault at the OS boundary while preserving the real isolated spawn.
    const mocked = t.mock.method(childProcess, 'spawn', (
      command: string, args: readonly string[], options: { stdio: 'pipe'; detached: true },
    ) => {
      const spawned = originalSpawn(command, args, options);
      child = spawned;
      spawned.once('spawn', () => {
        if (stream === 'stdin') spawned.stdin.destroy(new Error('Fixture stdin failure'));
        if (stream === 'stdout') spawned.stdout.destroy(new Error('Fixture stdout failure'));
        if (stream === 'stderr') spawned.stderr.destroy(new Error('Fixture stderr failure'));
      });
      return spawned;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(initializeCodexProcess(process.execPath, [fixture, 'silent'], { shutdownMs: 200 }),
        error => {
          assert.ok(error instanceof AggregateError);
          const causes: unknown[] = error.errors;
          assert.ok(causes.some(cause => cause instanceof Error && cause.message === 'Codex process transport failed'));
          return true;
        });
      assert.ok(child?.pid !== undefined);
      assert.equal(exists(-child.pid), false);
      for (const emitter of [child, child.stdin, child.stdout, child.stderr]) {
        assert.equal(emitter.listenerCount('error'), 0);
      }
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      if (child?.pid !== undefined && exists(-child.pid)) process.kill(-child.pid, 'SIGKILL');
    }
  });
}

for (const mode of ['parent-exits', 'ignore-term', 'bad-json', 'early-exit', 'silent']) {
  test(`cleans up child and grandchild when ${mode}`, posix, async t => {
    const { record, assertGone } = await tree(t);
    const done = initializeCodexProcess(process.execPath, [treeFixture, mode, record], {
      timeoutMs: 1_000, shutdownMs: 200,
    });
    if (['bad-json', 'early-exit', 'silent'].includes(mode)) await assert.rejects(done, AggregateError);
    else await done;
    await assertGone();
  });
}

test('cancellation waits for the owned group, leaving a separate child alive', posix, async t => {
  const { record, ready, assertGone } = await tree(t);
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const bystanderClosed = once(bystander, 'close');
  const controller = new AbortController();
  const done = assert.rejects(initializeCodexProcess(process.execPath, [treeFixture, 'silent', record], {
    signal: controller.signal, shutdownMs: 200,
  }), error => {
    assert.ok(error instanceof AggregateError);
    const causes: unknown[] = error.errors;
    assert.ok(causes.some(cause => cause instanceof Error && cause.message === 'Codex process cancelled'));
    return true;
  });
  try {
    await ready();
    controller.abort();
    await done;
    await assertGone();
    assert.ok(bystander.pid !== undefined);
    assert.equal(exists(bystander.pid), true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    controller.abort();
    await done;
    bystander.kill('SIGKILL');
    await bystanderClosed;
  }
});

test('does not spawn when already cancelled', async () => {
  await assert.rejects(initializeCodexProcess('/herbie-missing-executable', [], {
    signal: AbortSignal.abort(),
  }), { message: 'Codex process cancelled' });
});

test('cancellation during shutdown still waits for group cleanup and rejects', posix, async t => {
  const { record, ready, assertGone } = await tree(t);
  const controller = new AbortController();
  const rejected = assert.rejects(initializeCodexProcess(process.execPath, [treeFixture, 'ignore-term', record], {
    signal: controller.signal, shutdownMs: 200,
  }), AggregateError);
  await ready('shutdown');
  controller.abort();
  await rejected;
  await assertGone();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const failure of ['ineffective-signal', 'permission-error']) {
  test(`preserves cancellation and reports unconfirmed group exit after ${failure}`, posix, async t => {
    const { record, ready, pids } = await tree(t);
    const controller = new AbortController();
    const rejected = assert.rejects(initializeCodexProcess(process.execPath, [treeFixture, 'silent', record], {
      signal: controller.signal, shutdownMs: 50,
    }), error => {
      assert.ok(error instanceof AggregateError);
      const causes: unknown[] = error.errors;
      assert.ok(causes.some(cause => cause instanceof Error && cause.message === 'Codex process cancelled'));
      assert.ok(causes.some(cause => cause instanceof Error && /group exit unconfirmed/.test(cause.message)));
      return true;
    });
    await ready();
    const [leader] = await pids();
    assert.ok(leader !== undefined);
    const kill = process.kill;
    const signals: (number | NodeJS.Signals | undefined)[] = [];
    const mocked = t.mock.method(process, 'kill', (pid: number, signal?: number | NodeJS.Signals) => {
      if (pid !== -leader) return kill(pid, signal);
      if (failure === 'permission-error') throw Object.assign(new Error('Fixture permission error'), { code: 'EPERM' });
      if (signal === 0) return kill(pid, signal);
      signals.push(signal);
      return true; // Simulate accepted signals that do not terminate the owned group.
    });
    try {
      controller.abort();
      await rejected;
      if (failure === 'ineffective-signal') assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { mocked.mock.restore(); }
  });
}

test('handles a missing executable without an unhandled error', posix, async () => {
  await assert.rejects(initializeCodexProcess('/herbie-missing-executable', []), AggregateError);
});

test('rejects invalid shutdown deadlines before spawning', posix, async () => {
  for (const shutdownMs of [NaN, Infinity, -1]) {
    await assert.rejects(initializeCodexProcess('/herbie-missing-executable', [], { shutdownMs }), {
      message: 'Invalid Codex shutdown deadline',
    });
  }
});
