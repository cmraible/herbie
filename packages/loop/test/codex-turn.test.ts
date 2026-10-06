import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { runCodexTurn } from '../src/codex-turn.js';

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
    const rejected = assert.rejects(runCodexTurn(lines, transportSend, 'thread-1', 'Fix addition', 20), expected);
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
