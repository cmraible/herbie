import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DaytonaTestResult } from './daytona-attempt.js';

// Executed only inside the disposable sandbox, after the host retrieves the patch.
try {
  const input: unknown = JSON.parse(await readFile(new URL('./test.json', import.meta.url), 'utf8'));
  if (typeof input !== 'object' || input === null
    || !('cwd' in input) || typeof input.cwd !== 'string'
    || !('baseCommit' in input) || typeof input.baseCommit !== 'string'
    || !('command' in input) || !Array.isArray(input.command) || !input.command.length
    || !input.command.every((arg: unknown): arg is string => typeof arg === 'string')
    || !('timeoutMs' in input) || typeof input.timeoutMs !== 'number') throw new Error('Invalid repository test input');
  const run = promisify(execFile);
  const checkout = fileURLToPath(new URL('./verification', import.meta.url));
  await run('git', ['worktree', 'add', '--detach', checkout, input.baseCommit], { cwd: input.cwd, timeout: 30_000 });
  const patchFile = fileURLToPath(new URL('./recovered.patch', import.meta.url));
  if ((await readFile(patchFile)).length) {
    await run('git', ['apply', '--index', patchFile], { cwd: checkout, timeout: 30_000 });
  }
  let result: DaytonaTestResult;
  try {
    const { stdout, stderr } = await run(input.command[0], input.command.slice(1), {
      cwd: checkout, timeout: input.timeoutMs, killSignal: 'SIGKILL',
    });
    result = { exitCode: 0, stdout, stderr };
  } catch (error) {
    // A test assertion failure is a completed result; timeouts/signals/spawn errors are not.
    if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number'
      || !('stdout' in error) || typeof error.stdout !== 'string'
      || !('stderr' in error) || typeof error.stderr !== 'string') throw error;
    result = { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  await writeFile(new URL('./test-result.json', import.meta.url), JSON.stringify(result));
  process.stdout.write('herbie-tests-completed\n');
} catch {
  console.error('Sandbox patch verification failed');
  process.exitCode = 1;
}
