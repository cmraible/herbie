#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const record = process.env['CODEX_TEST_RECORD'];
if (!record) throw new Error('Missing test record path');

writeFileSync(record, JSON.stringify(process.argv.slice(2)));
console.log('Codex test output');
console.error('Codex test diagnostics');

process.exitCode = Number(process.env['CODEX_TEST_EXIT'] ?? 0);
if (process.env['CODEX_TEST_SIGNAL']) {
  process.kill(process.pid, 'SIGTERM');
}

if (process.env['CODEX_TEST_WAIT']) {
  process.stdin.once('data', () => {
    console.log('Codex test finished');
    process.stdin.pause();
  });
}
