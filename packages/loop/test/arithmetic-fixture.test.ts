import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createArithmeticFixture, runArithmeticTests, verifyArithmeticFixture } from './fixtures/arithmetic.js';

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
