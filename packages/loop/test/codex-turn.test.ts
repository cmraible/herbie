import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { runCodexTurn } from '../src/codex-turn.js';

test('interrupts a turn over real subprocess pipes', { timeout: 3_000 }, async () => {
  const fixture = fileURLToPath(new URL('./fixtures/app-server.ts', import.meta.url));
  const child = spawn(process.execPath, [fixture, 'turn-interrupt'], { stdio: 'pipe' });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  const controller = new AbortController();
  child.stderr.resume();
  try {
    const rejected = assert.rejects(runCodexTurn(lines, message => {
      child.stdin.write(JSON.stringify(message) + '\n');
    }, 'thread-1', 'Fixture only', { signal: controller.signal }), { message: 'Codex turn cancelled' });
    lines.once('line', () => controller.abort());
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    lines.close();
    child.kill('SIGKILL');
    await closed;
  }
});

function connection(t: TestContext) {
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const sent: unknown[] = [];
  const send = (message: unknown) => { sent.push(message); };
  const receive = (message: unknown) => stdout.write(JSON.stringify(message) + '\n');
  const initial = new Map(['line', 'close', 'error'].map(event => [event, lines.listeners(event)]));
  t.after(() => {
    try {
      for (const [event, listeners] of initial) {
        assert.ok(lines.listeners(event).every(listener => listeners.includes(listener)));
      }
    } finally { lines.close(); stdout.destroy(); }
  });
  return { stdout, lines, sent, send, receive };
}

const started = { id: 2, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } };
function completed(threadId = 'thread-1', turnId = 'turn-1', status = 'completed') {
  return { method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items: [] } } };
}

test('cancellation requests interruption and waits for matching terminal completion', async t => {
  const { lines, sent, send, receive } = connection(t);
  const controller = new AbortController();
  let settled = false;
  const rejected = assert.rejects(runCodexTurn(lines, send, 'thread-1', 'Fix addition', {
    signal: controller.signal,
  }), /Codex turn cancelled/).then(() => { settled = true; });
  receive(started);
  controller.abort();
  assert.deepEqual(sent[1], {
    id: 3, method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' },
  });
  receive({ id: 3, result: {} });
  receive(completed('other-thread', 'turn-1', 'interrupted'));
  receive(completed('thread-1', 'other-turn', 'interrupted'));
  await Promise.resolve();
  assert.equal(settled, false);
  receive(completed('thread-1', 'turn-1', 'interrupted'));
  await rejected;
  assert.equal(sent.length, 2);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('already cancelled does not send a turn', async t => {
  const { lines, sent, send } = connection(t);
  await assert.rejects(runCodexTurn(lines, send, 'thread-1', 'Fix addition', {
    signal: AbortSignal.abort(),
  }), /cancelled/);
  assert.deepEqual(sent, []);
});

for (const earlyCompletion of [false, true]) {
  test(`cancellation before start response handles ${earlyCompletion ? 'completed' : 'active'} turn`, async t => {
    const { lines, sent, send, receive } = connection(t);
    const controller = new AbortController();
    const rejected = assert.rejects(runCodexTurn(lines, send, 'thread-1', 'Fix addition', {
      signal: controller.signal,
    }), { message: 'Codex turn cancelled' });
    controller.abort();
    assert.equal(sent.length, 1);
    if (earlyCompletion) receive(completed());
    receive(started);
    if (!earlyCompletion) receive(completed('thread-1', 'turn-1', 'interrupted'));
    await rejected;
    assert.equal(sent.length, earlyCompletion ? 1 : 2);
  });
}

for (const status of ['completed', 'failed', 'interrupted']) {
  test(`timeout remains a failure when cancellation races with ${status}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { lines, sent, send, receive } = connection(t);
    const controller = new AbortController();
    const rejected = assert.rejects(runCodexTurn(lines, send, 'thread-1', 'Fix addition', {
      timeoutMs: 20, signal: controller.signal,
    }), { message: 'Codex turn timed out' });
    receive(started);
    t.mock.timers.tick(20);
    controller.abort(); // The first reason wins; interruption is sent only once.
    receive(completed('thread-1', 'turn-1', status));
    await rejected;
    assert.equal(sent.length, 2);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

for (const failure of ['deadline', 'missing-start', 'rejected', 'bad-json', 'send', 'close', 'error']) {
  test(`reports unconfirmed termination after cancellation: ${failure}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { stdout, lines, send, receive } = connection(t);
    const controller = new AbortController();
    const rejected = assert.rejects(runCodexTurn(lines, message => {
      if (failure === 'send' && controller.signal.aborted) throw new Error('private detail');
      send(message);
    }, 'thread-1', 'Fix addition', { signal: controller.signal, interruptTimeoutMs: 20 }), error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /cancelled; Codex turn termination unconfirmed/);
      const causes: unknown[] = error.errors;
      assert.equal(causes.length, 2);
      assert.ok(causes[0] instanceof Error);
      assert.equal(causes[0].message, 'Codex turn cancelled');
      assert.doesNotMatch(String(error) + causes.map(String).join(), /private detail/);
      return true;
    });
    if (failure !== 'missing-start') receive(started);
    controller.abort();
    if (failure === 'rejected') receive({ id: 3, error: { message: 'private detail' } });
    if (failure === 'bad-json') stdout.write('invalid\n');
    if (failure === 'close') stdout.end();
    if (failure === 'error') stdout.destroy(new Error('private detail'));
    if (failure === 'deadline') receive({ id: 3, result: {} });
    if (failure === 'deadline' || failure === 'missing-start') t.mock.timers.tick(20);
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

for (const early of [false, true]) {
  test(`waits for matching completion ${early ? 'before' : 'after'} the start response`, async t => {
    const { lines, sent, send, receive } = connection(t);
    let settled = false;
    const done = runCodexTurn(lines, send, 'thread-1', 'Fix addition').then(() => { settled = true; });
    assert.deepEqual(sent, [{ id: 2, method: 'turn/start', params: {
      threadId: 'thread-1', input: [{ type: 'text', text: 'Fix addition' }],
    } }]);
    receive({ id: 9, result: { turn: { id: 'other-turn' } } });
    receive(completed('other-thread'));
    receive(completed('thread-1', 'other-turn'));
    receive(early ? completed() : started);
    if (!early) receive({ id: 2, result: { turn: { id: 'other-turn' } } });
    receive(completed('other-thread', 'turn-1', 'failed'));
    receive(completed('thread-1', 'other-turn', 'interrupted'));
    await Promise.resolve();
    assert.equal(settled, false);
    receive(early ? started : completed());
    await done;
    assert.equal(sent.length, 1);
    assert.equal(lines.listenerCount('line'), 0);
  });
}

for (const status of ['failed', 'interrupted']) {
  for (const early of [false, true]) {
    test(`rejects ${status} completion ${early ? 'before' : 'after'} acknowledgement`, async t => {
      const { lines, send, receive } = connection(t);
      const rejected = assert.rejects(runCodexTurn(lines, send, 'thread-1', 'Fix addition'),
        { message: `Codex turn ${status}` });
      receive(early ? completed('thread-1', 'turn-1', status) : started);
      receive(early ? started : completed('thread-1', 'turn-1', status));
      await rejected;
    });
  }
}

for (const [name, response] of [
  ['rejected request', { id: 2, error: { code: -1, message: 'private detail' } }],
  ['missing turn', { id: 2, result: {} }],
  ['empty turn ID', { id: 2, result: { turn: { id: '' } } }],
  ['ambiguous response', { ...started, error: null }],
  ['invalid terminal status', completed('thread-1', 'turn-1', 'inProgress')],
  ['missing completion turn', { method: 'turn/completed', params: { threadId: 'thread-1' } }],
  ['non-object response', null],
]) {
  test(`rejects ${name}`, { timeout: 200 }, async t => {
    const { lines, send, receive } = connection(t);
    const rejected = assert.rejects(runCodexTurn(lines, send, 'thread-1', 'Fix addition'),
      /Codex turn failed: invalid or rejected response/);
    receive(response);
    await rejected;
  });
}

for (const failure of ['close', 'error', 'send', 'timeout', 'timeout-after-start', 'timeout-before-start', 'bad-json']) {
  test(`cleans up after ${failure}`, { timeout: 200 }, async t => {
    const { stdout, lines, send, receive } = connection(t);
    const events = ['line', 'close', 'error'];
    const before = new Map(events.map(event => [event, lines.listeners(event)]));
    const transportSend = (message: unknown) => {
      if (failure === 'send') throw new Error('private detail');
      send(message);
    };
    const expected = failure.startsWith('timeout') ? /Codex turn timed out/
      : failure === 'bad-json' ? /invalid or rejected response/
      : failure === 'close' ? /connection closed/ : /transport error/;
    const rejected = assert.rejects(runCodexTurn(lines, transportSend, 'thread-1', 'Fix addition', {
      timeoutMs: 20, interruptTimeoutMs: 20,
    }), expected);
    if (failure === 'close') stdout.end();
    if (failure === 'error') stdout.destroy(new Error('private detail'));
    if (failure === 'timeout-after-start') receive(started);
    if (failure === 'timeout-before-start') receive(completed());
    if (failure === 'bad-json') stdout.write('invalid JSON\n');
    await rejected;
    for (const event of events) {
      assert.ok(lines.listeners(event).every(listener => before.get(event)?.includes(listener)));
    }
  });
}

test('Daytona turns use the isolated runtime and interrupt at the cumulative spending cutoff', async t => {
  const { lines, sent, send, receive } = connection(t);
  const rejected = assert.rejects(runCodexTurn(lines, send, 'thread-1', 'Fix addition', {
    disposableDaytona: true,
  }), /spending cutoff/);
  assert.deepEqual(sent[0], { id: 2, method: 'turn/start', params: {
    threadId: 'thread-1', input: [{ type: 'text', text: 'Fix addition' }],
    model: 'gpt-6-luna', effort: 'low', serviceTierForTurn: 'default', approvalPolicy: 'never',
    sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' },
  } });
  receive(started);
  const usage = (inputTokens: number, outputTokens: number, threadId = 'thread-1', turnId = 'turn-1') => receive({
    method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { inputTokens, outputTokens } } },
  });
  usage(40_000, 0, 'other-thread');
  usage(40_000, 0, 'thread-1', 'other-turn');
  usage(30_000, 0);
  usage(30_000, 0); // Notifications contain cumulative totals, not deltas.
  assert.equal(sent.length, 1);
  usage(38_426, 340); // Earlier successful probe: $0.00497325, still below the guard.
  assert.equal(sent.length, 1);
  usage(40_000, 0); // $0.005 conservative estimate (all input charged at cache-write price).
  assert.deepEqual(sent[1], { id: 3, method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  receive(completed('thread-1', 'turn-1', 'interrupted'));
  await rejected;
});

for (const failure of ['late-start', 'invalid-usage', 'missing-interrupt-completion']) {
  test(`Daytona spending guard remains bounded: ${failure}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { lines, sent, send, receive } = connection(t);
    const rejected = assert.rejects(runCodexTurn(lines, send, 'thread-1', 'Fix addition', {
      disposableDaytona: true, interruptTimeoutMs: 20,
    }), failure === 'missing-interrupt-completion' ? /spending cutoff.*termination unconfirmed/ : /spending cutoff/);
    if (failure !== 'late-start') receive(started);
    const update = (turnId: string, inputTokens: number) => receive({
      method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId,
        tokenUsage: { total: { inputTokens, outputTokens: 0 } } },
    });
    update('other-turn', 100_000);
    update('turn-1', failure === 'invalid-usage' ? -1 : 40_000);
    if (failure === 'late-start') {
      assert.equal(sent.length, 1);
      receive(started);
    }
    assert.equal(sent.length, 2);
    receive({ id: 3, result: {} });
    if (failure === 'missing-interrupt-completion') t.mock.timers.tick(20);
    else receive(completed('thread-1', 'turn-1', 'interrupted'));
    await rejected;
  });
}

test('early usage for another turn does not cancel the requested Daytona turn', async t => {
  const { lines, sent, send, receive } = connection(t);
  const done = runCodexTurn(lines, send, 'thread-1', 'Fix addition', { disposableDaytona: true });
  receive({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'other-turn',
    tokenUsage: { total: { inputTokens: 100_000, outputTokens: 0 } } } });
  receive(started);
  receive(completed());
  await done;
  assert.equal(sent.length, 1);
});
