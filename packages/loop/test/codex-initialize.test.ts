import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { initializeCodex } from '../src/codex-initialize.js';

test('acknowledges initialization only after a matching successful response', async t => {
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  t.after(() => { lines.close(); stdout.destroy(); });
  const sent: unknown[] = [];
  const ready = initializeCodex(lines, message => { sent.push(message); });
  assert.deepEqual(sent, [{
    id: 0, method: 'initialize', params: { clientInfo: { name: 'herbie', version: '0.1.0' } },
  }]);
  stdout.write('{"method":"notification"}\n{"id":9,"result":{}}\n');
  assert.equal(sent.length, 1);
  stdout.write('{"id":0,"result":{"userAgent":"codex/0.159.2",');
  assert.equal(sent.length, 1);
  stdout.write('"platformFamily":"unix","platformOs":"linux"}}\n');
  await ready;
  assert.deepEqual(sent[1], { method: 'initialized' });
  assert.equal(sent.length, 2);
});

for (const [name, response] of [
  ['server rejection', '{"id":0,"error":{"code":-32600,"message":"private detail"}}'],
  ['missing result', '{"id":0}'],
  ['invalid result', '{"id":0,"result":{"userAgent":7}}'],
  ['both result and error', '{"id":0,"result":{"userAgent":"codex"},"error":null}'],
  ['malformed JSON', 'not JSON'],
  ['non-object response', 'null'],
]) {
  test(`rejects ${name} without acknowledging initialization`, async t => {
    const stdout = new PassThrough();
    const lines = createInterface({ input: stdout });
    t.after(() => { lines.close(); stdout.destroy(); });
    const sent: unknown[] = [];
    const ready = initializeCodex(lines, message => { sent.push(message); });
    const rejected = assert.rejects(ready, /Codex initialization/);
    stdout.write(response + '\n');
    await rejected;
    assert.equal(sent.length, 1);
    assert.equal(lines.listenerCount('line'), 0);
  });
}

for (const failure of ['close', 'error', 'timeout']) {
  test(`rejects initialization on ${failure} and detaches its listeners`, { timeout: 1_000 }, async t => {
    const stdout = new PassThrough();
    const lines = createInterface({ input: stdout });
    t.after(() => { lines.close(); stdout.destroy(); });
    const events = ['line', 'close', 'error'];
    const originalListeners = new Map(events.map(event => [event, lines.listeners(event)]));
    const sent: unknown[] = [];
    const ready = initializeCodex(lines, message => { sent.push(message); }, 20);
    const rejected = assert.rejects(ready, /Codex initialization/);
    if (failure === 'close') stdout.end();
    if (failure === 'error') stdout.destroy(new Error('private stream detail'));
    await rejected;
    assert.equal(sent.length, 1);
    for (const event of events) {
      assert.ok(lines.listeners(event).every(listener => originalListeners.get(event)?.includes(listener)));
    }
  });
}

test('rejects send failures and removes response listeners', async t => {
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  t.after(() => { lines.close(); stdout.destroy(); });
  await assert.rejects(initializeCodex(lines, () => { throw new Error('private transport detail'); }),
    /Codex initialization failed: transport/);
  assert.equal(lines.listenerCount('line'), 0);
});
