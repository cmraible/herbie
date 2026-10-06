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
});
lines.on('close', () => {
  if (mode === 'flush') process.stdout.write('x'.repeat(2 * 1024 * 1024));
  if (mode === 'ignore-term') setInterval(() => {}, 1000);
});
