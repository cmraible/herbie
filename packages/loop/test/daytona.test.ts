import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { runDaytonaSmoke } from '../src/daytona.js';

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
