import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { DaytonaSmokeError, daytonaErrorMessage, runDaytonaSmoke } from '../src/daytona.js';

function fixture() {
  const events: string[] = [];
  const sandbox = {
    id: 'smoke-sandbox',
    process: { executeCommand: mock.fn(async () => ({ exitCode: 0, result: 'herbie-daytona-ok\n' })) },
    delete: mock.fn(async () => { events.push('delete'); }),
  };
  const create = mock.fn<Parameters<typeof runDaytonaSmoke>[0]>(async () => sandbox);
  const report = (message: string) => { events.push(message); };
  return { sandbox, create, report, events };
}

test('creates a bounded minimum-size sandbox, executes the probe, and waits for deletion', async () => {
  const { sandbox, create, report, events } = fixture();
  await runDaytonaSmoke(create, report);
  assert.equal(create.mock.callCount(), 1);
  const [params, options] = create.mock.calls[0].arguments;
  assert.match(params.name ?? '', /^herbie-smoke-[0-9a-f-]+$/);
  assert.deepEqual(params, {
    name: params.name, image: 'ubuntu:22.04', resources: { cpu: 1, memory: 1, disk: 1 },
    networkBlockAll: true, ttlMinutes: 5,
  });
  assert.deepEqual(options, { timeout: 120 });
  assert.deepEqual(sandbox.process.executeCommand.mock.calls[0].arguments,
    ["printf 'herbie-daytona-ok\\n'", undefined, undefined, 10]);
  assert.equal(sandbox.delete.mock.callCount(), 1);
  assert.deepEqual(sandbox.delete.mock.calls[0].arguments, [60, true]);
  assert.deepEqual(events.slice(1), [
    'Created sandbox smoke-sandbox', 'Command passed: herbie-daytona-ok',
    'delete', 'Deletion confirmed for sandbox smoke-sandbox',
  ]);
});

test('reports ambiguous creation without retrying or claiming deletion', async () => {
  const { sandbox, create, report, events } = fixture();
  const failure = new Error('create request timed out');
  create.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(runDaytonaSmoke(create, report), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, failure);
    assert.match(error.message, /Creation failed for herbie-smoke-.*cleanup is unconfirmed/);
    return true;
  });
  assert.equal(create.mock.callCount(), 1);
  assert.equal(sandbox.process.executeCommand.mock.callCount(), 0);
  assert.equal(sandbox.delete.mock.callCount(), 0);
  assert.equal(events.length, 1);
});

for (const scenario of [
  { name: 'command rejection', run: async () => { throw new Error('request rejected'); } },
  { name: 'command timeout', run: async () => { throw new Error('execution timed out'); } },
  { name: 'nonzero exit', run: async () => ({ exitCode: 1, result: 'herbie-daytona-ok\n' }) },
  { name: 'unexpected output', run: async () => ({ exitCode: 0, result: 'wrong\n' }) },
]) {
  test(`waits for deletion after ${scenario.name}`, async () => {
    const { sandbox, create, report, events } = fixture();
    sandbox.process.executeCommand.mock.mockImplementation(scenario.run);
    await assert.rejects(runDaytonaSmoke(create, report), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.equal(error.message, 'Command failed in sandbox smoke-sandbox');
      return true;
    });
    assert.equal(create.mock.callCount(), 1);
    assert.equal(sandbox.process.executeCommand.mock.callCount(), 1);
    assert.equal(sandbox.delete.mock.callCount(), 1);
    assert.deepEqual(sandbox.delete.mock.calls[0].arguments, [60, true]);
    assert.equal(events.at(-1), 'Deletion confirmed for sandbox smoke-sandbox');
  });
}

test('fails when deletion is unconfirmed even if the command passed', async () => {
  const { sandbox, create, report, events } = fixture();
  const failure = new Error('delete request timed out');
  sandbox.delete.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(runDaytonaSmoke(create, report), error => {
    assert.ok(error instanceof AggregateError);
    const errors: unknown[] = error.errors;
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    assert.equal(errors[0].cause, failure);
    assert.match(error.message, /Deletion unconfirmed for sandbox smoke-sandbox/);
    return true;
  });
  assert.equal(sandbox.delete.mock.callCount(), 1);
  assert.equal(events.some(event => event.startsWith('Deletion confirmed')), false);
});

test('preserves both execution and cleanup failures without printing SDK error details', async () => {
  const { sandbox, create, report } = fixture();
  const commandFailure = new Error('private command request detail');
  const deleteFailure = new Error('private delete request detail');
  sandbox.process.executeCommand.mock.mockImplementation(async () => { throw commandFailure; });
  sandbox.delete.mock.mockImplementation(async () => { throw deleteFailure; });
  await assert.rejects(runDaytonaSmoke(create, report), error => {
    assert.ok(error instanceof AggregateError);
    const errors: unknown[] = error.errors;
    assert.equal(errors.length, 2);
    assert.ok(errors[0] instanceof Error);
    assert.ok(errors[1] instanceof Error);
    assert.equal(errors[0].cause, commandFailure);
    assert.equal(errors[1].cause, deleteFailure);
    assert.match(error.message, /Command failed.*Deletion unconfirmed/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

test('withholds unexpected constructor and disposal errors at the CLI boundary', () => {
  for (const error of [
    new Error('private constructor request detail'),
    new AggregateError([new Error('private cause')], 'private disposal detail'),
    'private non-Error detail',
  ]) {
    assert.equal(daytonaErrorMessage(error), 'Daytona smoke failed; SDK error details were withheld.');
  }
});

test('keeps authored missing-key and lifecycle messages without exposing their causes', () => {
  for (const message of [
    'Set DAYTONA_API_KEY in the host environment before running test:daytona.',
    'Deletion unconfirmed for sandbox smoke-sandbox; check Daytona before retrying',
  ]) {
    const error = new DaytonaSmokeError([new Error('private SDK detail')], message);
    assert.equal(daytonaErrorMessage(error), message);
  }
});
