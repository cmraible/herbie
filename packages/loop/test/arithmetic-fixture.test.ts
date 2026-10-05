import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createArithmeticFixture, runArithmeticTests, verifyArithmeticFixture } from './fixtures/arithmetic.js';

test('creates the baseline without running global Git hooks', t => {
  const directory = mkdtempSync(join(tmpdir(), 'herbie-fixture-hooks-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const hooks = join(directory, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "fixture hook ran" >&2\nexit 1\n', { mode: 0o755 });
  const config = join(directory, 'gitconfig');
  writeFileSync(config, `[core]\n  hooksPath = ${hooks}\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  const repo = join(directory, 'repo');
  const fixture = new URL('./fixtures/arithmetic.ts', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { createArithmeticFixture } from ${JSON.stringify(fixture)}; createArithmeticFixture(process.argv[1]);`,
    repo,
  ], { env, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);

  // An ordinary commit still runs the hook: the override must be command-local.
  const commit = spawnSync('git', ['-C', repo,
    '-c', 'user.name=Fixture Test', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Hook probe',
  ], { env, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(commit.error);
  assert.equal(commit.status, 1, commit.stderr);
  assert.match(commit.stderr, /fixture hook ran/);
});

test('a failing fixture accepts only the arithmetic fix and passes its unchanged tests', t => {
  const directory = mkdtempSync(join(tmpdir(), 'herbie-fixture-test-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const repo = join(directory, 'repo');
  const head = createArithmeticFixture(repo);
  assert.match(runArithmeticTests(repo, 2), /^# fail 2$/m);
  const tests = readFileSync(join(repo, 'add.test.mjs'));
  writeFileSync(join(repo, 'add.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
  assert.match(runArithmeticTests(repo, 0), /^# pass 2$/m);
  assert.match(verifyArithmeticFixture(repo, head), /\+  return a \+ b;/);
  assert.deepEqual(readFileSync(join(repo, 'add.test.mjs')), tests);
});

for (const change of ['source', 'tests', 'extra file', 'mode', 'commit']) {
  test(`rejects a passing fixture with an unauthorized ${change} change`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'herbie-fixture-test-'));
    t.after(() => rmSync(directory, { recursive: true }));
    const repo = join(directory, 'repo');
    const head = createArithmeticFixture(repo);
    const source = join(repo, 'add.mjs');
    writeFileSync(source, 'export function add(a, b) {\n  return a + b;\n}\n');
    switch (change) {
      case 'source': writeFileSync(source, 'export const add = (a, b) => a + b;\n'); break;
      case 'tests': writeFileSync(join(repo, 'add.test.mjs'), readFileSync(join(repo, 'add.test.mjs'), 'utf8') + '// changed\n'); break;
      case 'extra file': writeFileSync(join(repo, 'extra.txt'), 'unexpected'); break;
      case 'mode': chmodSync(source, 0o755); break;
      case 'commit': {
        const result = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null',
          '-c', 'user.name=Fixture Test', '-c', 'user.email=fixture@example.invalid',
          '-c', 'commit.gpgsign=false', 'commit', '-am', 'Unexpected commit'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        break;
      }
    }
    runArithmeticTests(repo, 0);
    assert.throws(() => verifyArithmeticFixture(repo, head));
  });
}
