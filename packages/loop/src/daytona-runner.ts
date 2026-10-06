import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runCodexAttempt } from './codex-process.js';

// Uploaded alongside the built attempt helpers; executed inside the disposable sandbox.
try {
  const input: unknown = JSON.parse(await readFile(new URL('./attempt.json', import.meta.url), 'utf8'));
  if (typeof input !== 'object' || input === null
    || !('cwd' in input) || typeof input.cwd !== 'string'
    || !('goal' in input) || typeof input.goal !== 'string') throw new Error('Invalid attempt input');
  const cwd = input.cwd;
  const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd, timeout: 30_000 })).stdout;
  const baseCommit = (await git('rev-parse', 'HEAD')).trim();
  await runCodexAttempt('codex', ['app-server'], { cwd, goal: input.goal, turnTimeoutMs: 300_000 });
  // This checkout is disposable. Stage its final state to include new, non-ignored files.
  await git('add', '--all');
  const patchFile = new URL('./changes.patch', import.meta.url);
  await git('diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv',
    `--output=${fileURLToPath(patchFile)}`, baseCommit, '--');
  await writeFile(new URL('./changes.json', import.meta.url), JSON.stringify({
    baseCommit, patchBase64: (await readFile(patchFile)).toString('base64'),
  }));
  process.stdout.write('herbie-attempt-completed\n');
} catch {
  console.error('Sandbox Codex attempt failed');
  process.exitCode = 1;
}
