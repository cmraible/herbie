import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    'commit', '-m', 'Baseline failing addition');
  assert.equal(git(repo, 'remote'), '');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  return repo;
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'herbie-e2e-'));
  console.log(`Smoke-test fixture and logs: ${directory}`);
  try {
    const repo = createFixture(directory);
    runTests(repo, join(directory, 'baseline.log'), 2);
    assert.deepEqual(readFileSync(join(repo, 'add.test.mjs')), Buffer.from(tests));
    rmSync(directory, { recursive: true });
    console.log('Fixture baseline verified.');
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
