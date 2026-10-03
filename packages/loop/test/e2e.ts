import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArithmeticFixture, runArithmeticTests, verifyArithmeticFixture } from './fixtures/arithmetic.js';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const timeoutMs = 10 * 60_000;

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

async function runHerbie(repo: string, directory: string): Promise<void> {
  const goal = 'Fix only add.mjs: change return a - b; to return a + b; so add returns the arithmetic sum. '
    + 'Keep add.test.mjs byte-for-byte unchanged and run node --test add.test.mjs. '
    + 'Do not create or modify any other files, commit, push, or use a remote.';
  const args = ['start', '--repo', repo, '--goal', goal];
  writeFileSync(join(directory, 'invocation.json'), JSON.stringify({ command: 'pnpm', args, timeoutMs }, null, 2));
  const log = openSync(join(directory, 'herbie.log'), 'w');
  try {
    await new Promise<void>((resolve, reject) => {
      // A separate POSIX process group lets a timeout stop pnpm, Herbie and Codex together.
      const child = spawn('pnpm', args, { cwd: workspace, detached: true, stdio: ['ignore', log, log] });
      let failure: Error | undefined;
      function stop(reason: string): void {
        failure = new Error(reason);
        killGroup(child.pid);
      }
      const timer = setTimeout(() => stop('Herbie exceeded the 10-minute timeout'), timeoutMs);
      const interrupt = () => stop('Smoke test interrupted');
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      child.once('error', error => { failure = error; });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
        // Stop any descendants left behind even when the command itself has exited.
        try {
          killGroup(child.pid);
          writeFileSync(join(directory, 'exit.json'), JSON.stringify({ code, signal }, null, 2));
          assert.ifError(failure);
          assert.equal(code, 0, `Herbie failed (${signal ?? code}); see ${join(directory, 'herbie.log')}`);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    closeSync(log);
  }
}

async function main(): Promise<void> {
  assert.ok(process.platform === 'linux' || process.platform === 'darwin', 'This smoke test requires Linux or macOS process groups');
  const directory = mkdtempSync(join(tmpdir(), 'herbie-e2e-'));
  console.log(`Smoke-test fixture and logs: ${directory}`);
  try {
    const repo = join(directory, 'repo');
    const head = createArithmeticFixture(repo);
    runArithmeticTests(repo, 2, join(directory, 'baseline.log'));
    writeFileSync(join(directory, 'baseline-head.txt'), head);
    console.log('Baseline: both tests fail. Running real Codex (up to 10 minutes; consumes quota).');
    await runHerbie(repo, directory);
    runArithmeticTests(repo, 0, join(directory, 'after.log'));
    verifyArithmeticFixture(repo, head, join(directory, 'change.diff'));
    rmSync(directory, { recursive: true });
    console.log('PASS: real Herbie exited 0, both tests pass, tests and HEAD unchanged, only the expected one-line fix.');
  } catch (error) {
    writeFileSync(join(directory, 'failure.txt'), String(error) + '\n');
    console.error(`Fixture and logs retained at ${directory}`);
    throw error;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
