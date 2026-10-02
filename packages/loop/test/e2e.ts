import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const timeoutMs = 10 * 60_000;

const brokenSource = 'export function add(a, b) {\n  return a - b;\n}\n';
const tests = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './add.mjs';

test('adds positive numbers', () => assert.equal(add(2, 3), 5));
test('adds a negative and positive number', () => assert.equal(add(-2, 5), 3));
`;

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function runTests(repo: string, log: string, expectedFailures: number): void {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'add.test.mjs'], {
    cwd: repo, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
  });
  writeFileSync(log, result.stdout + result.stderr);
  assert.ifError(result.error);
  assert.equal(result.status, expectedFailures === 0 ? 0 : 1, `See ${log}`);
  assert.match(result.stdout, /^# tests 2$/m);
  assert.match(result.stdout, new RegExp(`^# fail ${expectedFailures}$`, 'm'));
}

function createFixture(directory: string): string {
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'add.mjs'), brokenSource);
  writeFileSync(join(repo, 'add.test.mjs'), tests);
  git(repo, 'init', '--template=', '-b', 'main');
  git(repo, 'add', 'add.mjs', 'add.test.mjs');
  git(repo, '-c', 'user.name=Herbie Smoke Test', '-c', 'user.email=smoke@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', 'Baseline failing addition');
  assert.equal(git(repo, 'remote'), '');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  return repo;
}

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

function verify(repo: string, directory: string, head: string, testBytes: Buffer): void {
  runTests(repo, join(directory, 'after.log'), 0);
  const diff = git(repo, 'diff', 'HEAD', '--');
  writeFileSync(join(directory, 'change.diff'), diff);
  assert.deepEqual(readFileSync(join(repo, 'add.test.mjs')), testBytes, 'Test bytes changed');
  assert.equal(readFileSync(join(repo, 'add.mjs'), 'utf8'), 'export function add(a, b) {\n  return a + b;\n}\n');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'HEAD changed');
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1\n');
  assert.equal(git(repo, 'remote'), '', 'A remote was added');
  assert.equal(git(repo, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'), ' M add.mjs\n');
  assert.equal(git(repo, 'diff', '--numstat'), '1\t1\tadd.mjs\n');
  assert.equal(git(repo, 'diff', '--summary'), '', 'File modes or paths changed');
}

async function main(): Promise<void> {
  assert.ok(process.platform === 'linux' || process.platform === 'darwin', 'This smoke test requires Linux or macOS process groups');
  const directory = mkdtempSync(join(tmpdir(), 'herbie-e2e-'));
  console.log(`Smoke-test fixture and logs: ${directory}`);
  try {
    const repo = createFixture(directory);
    runTests(repo, join(directory, 'baseline.log'), 2);
    const head = git(repo, 'rev-parse', 'HEAD');
    const testBytes = readFileSync(join(repo, 'add.test.mjs'));
    writeFileSync(join(directory, 'baseline-head.txt'), head);
    console.log('Baseline: both tests fail. Running real Codex (up to 10 minutes; consumes quota).');
    await runHerbie(repo, directory);
    verify(repo, directory, head, testBytes);
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
