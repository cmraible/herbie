import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const record = process.argv[3];
if (!record) throw new Error('Missing fixture record');
appendFileSync(record, `${process.pid}\n`);
const fixture = fileURLToPath(import.meta.url);
if (mode === 'grandchild') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  process.send?.('ready');
} else {
  const child = spawn(process.execPath, [fixture, mode === 'child' ? 'grandchild' : 'child', record], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const ready = new Promise<void>(resolve => child.once('message', () => resolve()));
  if (mode === 'child') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    await ready;
    process.send?.('ready');
  } else {
    if (mode === 'ignore-term') process.on('SIGTERM', () => {});
    const lines = createInterface({ input: process.stdin });
    lines.on('line', async line => {
      const message: unknown = JSON.parse(line);
      if (typeof message !== 'object' || message === null || !('method' in message)) return;
      if (message.method !== 'initialize') return;
      await ready;
      appendFileSync(record, 'ready\n');
      if (mode === 'silent') return;
      if (mode === 'early-exit') process.exit(7);
      process.stdout.write(mode === 'bad-json' ? 'invalid\n' : '{"id":0,"result":{"userAgent":"fixture"}}\n');
    });
    lines.on('close', () => {
      appendFileSync(record, 'shutdown\n');
      if (mode !== 'ignore-term') process.exit(0);
      setInterval(() => {}, 1000);
    });
  }
}
