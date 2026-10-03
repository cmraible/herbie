import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export function runArithmeticTests(repo: string, expectedFailures: 0 | 2, log?: string): string {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'add.test.mjs'], {
    cwd: repo, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    // This is a separate test run, even when called by our own node:test suite.
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  const output = result.stdout + result.stderr;
  if (log) writeFileSync(log, output);
  assert.ifError(result.error);
  assert.equal(result.status, expectedFailures === 0 ? 0 : 1, output);
  assert.match(result.stdout, /^# tests 2$/m);
  assert.match(result.stdout, new RegExp(`^# fail ${expectedFailures}$`, 'm'));
  return output;
}

export function createArithmeticFixture(repo: string): string {
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
  return git(repo, 'rev-parse', 'HEAD');
}

export function verifyArithmeticFixture(repo: string, head: string, log?: string): string {
  const diff = git(repo, 'diff', 'HEAD', '--');
  if (log) writeFileSync(log, diff);
  assert.equal(readFileSync(join(repo, 'add.test.mjs'), 'utf8'), tests, 'Test bytes changed');
  assert.equal(readFileSync(join(repo, 'add.mjs'), 'utf8'), 'export function add(a, b) {\n  return a + b;\n}\n');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'HEAD changed');
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1\n');
  assert.equal(git(repo, 'remote'), '', 'A remote was added');
  assert.equal(git(repo, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'), ' M add.mjs\n');
  assert.equal(git(repo, 'diff', '--numstat'), '1\t1\tadd.mjs\n');
  assert.equal(git(repo, 'diff', '--summary'), '', 'File modes or paths changed');
  return diff;
}
