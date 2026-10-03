import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
