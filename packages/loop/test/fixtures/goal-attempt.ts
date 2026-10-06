import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2];
const record = process.argv[3];
if (!record) throw new Error('Missing fixture record');
const log = (event: unknown) => appendFileSync(record, JSON.stringify(event) + '\n');
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
log({ pid: process.pid, cwd: process.cwd() });
let stage = 0;
const complete = (status: string) => {
  log({ completed: status });
  send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status } } });
};
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message: unknown = JSON.parse(line);
  assert.ok(typeof message === 'object' && message !== null && 'method' in message);
  log(message);
  if (message.method === 'initialize') {
    assert.equal(stage++, 0);
    if (mode === 'init-fail') { process.stdout.write('invalid\n'); return; }
    send({ id: 0, result: { userAgent: 'fixture' } });
  } else if (message.method === 'initialized') {
    assert.equal(stage++, 1);
  } else if (message.method === 'thread/start') {
    assert.equal(stage++, 2);
    send(mode === 'thread-fail' ? { id: 1, error: { code: -1 } } : { id: 1, result: { thread: { id: 'thread-1' } } });
  } else if (message.method === 'turn/start') {
    assert.equal(stage++, 3);
    const worker = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');",
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    log({ workerPid: worker.pid });
    worker.stdout.once('data', () => {
      send({ id: 2, result: { turn: { id: 'turn-1' } } });
      log({ active: true });
      if (mode === 'turn-exit') process.exit(7);
      if (mode === 'success' || mode === 'turn-fail' || mode === 'cleanup-fail') {
        setImmediate(() => {
          complete(mode === 'turn-fail' ? 'failed' : 'completed');
          if (mode === 'cleanup-fail') process.exit(7);
        });
      }
    });
  } else if (message.method === 'turn/interrupt') {
    assert.equal(stage++, 4);
    assert.ok('params' in message);
    assert.deepEqual(message.params, { threadId: 'thread-1', turnId: 'turn-1' });
    send({ id: 3, result: {} });
    if (mode !== 'interrupt-unconfirmed') setImmediate(() => complete('interrupted'));
  } else throw new Error('Unexpected fixture request');
});
lines.on('close', () => { log({ eof: true }); process.exit(0); });
