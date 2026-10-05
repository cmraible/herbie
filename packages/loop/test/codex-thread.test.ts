import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { startCodexThread } from '../src/codex-thread.js';

function connection(t: TestContext) {
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const sent: unknown[] = [];
  const send = (message: unknown) => { sent.push(message); };
  t.after(() => { lines.close(); stdout.destroy(); });
  return { stdout, lines, sent, send };
}

test('starts one ephemeral thread and returns only the matching response ID', async t => {
  const { stdout, lines, sent, send } = connection(t);
  const started = startCodexThread(lines, send, '/fixture');
  assert.deepEqual(sent, [{ id: 1, method: 'thread/start', params: { cwd: '/fixture', ephemeral: true } }]);
  stdout.write('{"method":"thread/started","params":{"thread":{"id":"notification"}}}\n');
  stdout.write('{"id":9,"result":{"thread":{"id":"unrelated"}}}\n');
  stdout.write('{"id":1,"result":{"thread":');
  stdout.write('{"id":"thread-1"}}}\n');
  assert.equal(await started, 'thread-1');
  assert.equal(sent.length, 1);
  assert.equal(lines.listenerCount('line'), 0);
});

for (const [name, response] of [
  ['server rejection', '{"id":1,"error":{"code":-32600,"message":"private detail"}}'],
  ['missing thread', '{"id":1,"result":{}}'],
  ['invalid ID', '{"id":1,"result":{"thread":{"id":7}}}'],
  ['empty ID', '{"id":1,"result":{"thread":{"id":""}}}'],
  ['ambiguous response', '{"id":1,"result":{"thread":{"id":"thread-1"}},"error":null}'],
  ['malformed JSON', 'not JSON'],
  ['non-object response', 'null'],
]) {
  test(`rejects ${name} without sending another request`, { timeout: 200 }, async t => {
    const { stdout, lines, sent, send } = connection(t);
    const rejected = assert.rejects(startCodexThread(lines, send, '/fixture'),
      /Codex thread start failed: invalid or rejected response/);
    stdout.write(response + '\n');
    await rejected;
    assert.equal(sent.length, 1);
    assert.equal(lines.listenerCount('line'), 0);
  });
}

for (const failure of ['close', 'error', 'timeout', 'send']) {
  test(`rejects thread start on ${failure} and removes only its listeners`, { timeout: 200 }, async t => {
    const { stdout, lines, sent, send } = connection(t);
    const events = ['line', 'close', 'error'];
    const originalListeners = new Map(events.map(event => [event, lines.listeners(event)]));
    const transportSend = (message: unknown) => {
      if (failure === 'send') throw new Error('private transport detail');
      send(message);
    };
    const rejected = assert.rejects(startCodexThread(lines, transportSend, '/fixture', 20),
      /Codex thread start (failed: (connection closed|transport error)|timed out)/);
    if (failure === 'close') stdout.end();
    if (failure === 'error') stdout.destroy(new Error('private stream detail'));
    await rejected;
    assert.equal(sent.length, failure === 'send' ? 0 : 1);
    for (const event of events) {
      assert.ok(lines.listeners(event).every(listener => originalListeners.get(event)?.includes(listener)));
    }
  });
}
