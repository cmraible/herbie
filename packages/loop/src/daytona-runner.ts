import { readFile } from 'node:fs/promises';
import { runCodexAttempt } from './codex-process.js';

// Uploaded alongside the built attempt helpers; executed inside the disposable sandbox.
try {
  const input: unknown = JSON.parse(await readFile(new URL('./attempt.json', import.meta.url), 'utf8'));
  if (typeof input !== 'object' || input === null
    || !('cwd' in input) || typeof input.cwd !== 'string'
    || !('goal' in input) || typeof input.goal !== 'string') throw new Error('Invalid attempt input');
  await runCodexAttempt('codex', ['app-server'], { cwd: input.cwd, goal: input.goal, turnTimeoutMs: 300_000 });
  process.stdout.write('herbie-attempt-completed\n');
} catch {
  console.error('Sandbox Codex attempt failed');
  process.exitCode = 1;
}
