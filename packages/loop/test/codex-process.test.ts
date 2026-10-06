import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, mock } from 'node:test';
import { once, getEventListeners } from 'node:events';
import { initializeCodexProcess } from '../src/codex-process.js';

const fixture = fileURLToPath(new URL('./fixtures/app-server.ts', import.meta.url));

test('initializes a subprocess and waits for clean exit', async () => {
  const child = spawn(process.execPath, [fixture, 'normal'], { stdio: 'pipe' });
  const controller = new AbortController();
  let starts = 0;
  try {
    await initializeCodexProcess(() => { starts++; return child; }, { signal: controller.signal });
    assert.equal(starts, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    for (const emitter of [child, child.stdin, child.stdout, child.stderr]) {
      assert.equal(emitter.listenerCount('error'), 0);
    }
    assert.equal(child.exitCode, 0);
    assert.equal(child.stdout.destroyed, true);
  } finally { child.kill('SIGKILL'); }
});

for (const mode of ['exit', 'bad-json', 'silent']) {
  test(`rejects ${mode} and confirms child exit`, async () => {
    const child = spawn(process.execPath, [fixture, mode], { stdio: 'pipe' });
    let closed = false;
    child.once('close', () => { closed = true; });
    try {
      await assert.rejects(initializeCodexProcess(() => child, { timeoutMs: mode === 'silent' ? 20 : 1_000, shutdownMs: 100 }), AggregateError);
      assert.equal(closed, true);
    } finally { child.kill('SIGKILL'); }
  });
}

test('escalates shutdown to SIGKILL when the initialized child ignores SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, [fixture, 'ignore-term'], { stdio: 'pipe' });
  let closed = false;
  child.once('close', () => { closed = true; });
  try {
    await initializeCodexProcess(() => child, { shutdownMs: 100 });
    assert.equal(closed, true);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally { child.kill('SIGKILL'); }
});

test('does not start a process when already cancelled', async () => {
  let starts = 0;
  await assert.rejects(initializeCodexProcess(() => {
    starts++;
    throw new Error('must not start');
  }, { signal: AbortSignal.abort() }), /cancelled/);
  assert.equal(starts, 0);
});

test('cancellation during initialization waits for child exit', async () => {
  const controller = new AbortController();
  const child = spawn(process.execPath, [fixture, 'silent'], { stdio: 'pipe' });
  let closed = false;
  child.once('close', () => { closed = true; });
  child.once('spawn', () => controller.abort());
  try {
    await assert.rejects(initializeCodexProcess(() => child, { signal: controller.signal, shutdownMs: 100 }),
      error => {
        assert.ok(error instanceof AggregateError);
        const causes: unknown[] = error.errors;
        assert.ok(causes.some(cause => cause instanceof Error && cause.message === 'Codex process cancelled'));
        return true;
      });
    assert.equal(closed, true);
  } finally { child.kill('SIGKILL'); }
});

test('handles a missing executable without an unhandled error', async () => {
  await assert.rejects(initializeCodexProcess(
    () => spawn('/herbie-missing-executable', [], { stdio: 'pipe' }),
  ), AggregateError);
});

for (const stream of ['stdin', 'stdout', 'stderr']) {
  test(`handles ${stream} failure and confirms exit`, async () => {
    const child = spawn(process.execPath, [fixture, 'silent'], { stdio: 'pipe' });
    let closed = false;
    child.once('close', () => { closed = true; });
    child.once('spawn', () => {
      if (stream === 'stdin') child.stdin.destroy(new Error('fixture write failure'));
      if (stream === 'stdout') child.stdout.destroy(new Error('fixture read failure'));
      if (stream === 'stderr') child.stderr.destroy(new Error('fixture diagnostics failure'));
    });
    try {
      await assert.rejects(initializeCodexProcess(() => child, { shutdownMs: 100 }), AggregateError);
      assert.equal(closed, true);
    } finally { child.kill('SIGKILL'); }
  });
}

test('reports unconfirmed exit when termination fails instead of claiming success', async () => {
  const child = spawn(process.execPath, [fixture, 'ignore-term'], { stdio: 'pipe' });
  const kill = mock.method(child, 'kill', () => false);
  try {
    await assert.rejects(initializeCodexProcess(() => child, { shutdownMs: 20 }), error => {
      assert.ok(error instanceof AggregateError);
      const causes: unknown[] = error.errors;
      assert.ok(causes.some(cause => cause instanceof Error && /exit unconfirmed/.test(cause.message)));
      return true;
    });
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    kill.mock.restore();
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
});

test('cancellation during shutdown still rejects after confirmed exit', async () => {
  const controller = new AbortController();
  const child = spawn(process.execPath, [fixture, 'normal'], { stdio: 'pipe' });
  let closed = false;
  child.once('close', () => { closed = true; });
  child.stdin.once('finish', () => controller.abort());
  try {
    await assert.rejects(initializeCodexProcess(() => child, { signal: controller.signal }), AggregateError);
    assert.equal(closed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { child.kill('SIGKILL'); }
});

test('drains shutdown output beyond pipe capacity so the child exits cleanly', async () => {
  const child = spawn(process.execPath, [fixture, 'flush'], { stdio: 'pipe' });
  try {
    await initializeCodexProcess(() => child);
    assert.equal(child.exitCode, 0);
    assert.equal(child.signalCode, null);
  } finally { child.kill('SIGKILL'); }
});
