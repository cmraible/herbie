import { createInterface } from 'node:readline';

const mode = process.argv[2];
if (mode === 'exit') process.exit(7);
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message: unknown = JSON.parse(line);
  if (typeof message !== 'object' || message === null || !('method' in message)) return;
  if (message.method === 'initialize') {
    if (mode === 'silent') return;
    if (mode === 'bad-json') { process.stdout.write('invalid\n'); return; }
    process.stdout.write(JSON.stringify({ id: 0, result: { userAgent: 'fixture' } }) + '\n');
  }
  if (mode === 'turn-interrupt' && message.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: 2, result: { turn: { id: 'turn-1' } } }) + '\n');
  }
  if (mode === 'turn-interrupt' && message.method === 'turn/interrupt') {
    if (!('params' in message) || typeof message.params !== 'object' || message.params === null
      || !('threadId' in message.params) || message.params.threadId !== 'thread-1'
      || !('turnId' in message.params) || message.params.turnId !== 'turn-1') process.exit(8);
    process.stdout.write(JSON.stringify({ id: 3, result: {} }) + '\n');
    setImmediate(() => process.stdout.write(JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
    }) + '\n'));
  }
});
lines.on('close', () => {
  if (mode === 'flush') process.stdout.write('x'.repeat(2 * 1024 * 1024));
  if (mode === 'ignore-term') setInterval(() => {}, 1000);
});
