import { randomUUID } from 'node:crypto';
import type { CreateSandboxFromImageParams } from '@daytona/sdk';

interface SmokeSandbox {
  id: string;
  process: {
    executeCommand(command: string, cwd: undefined, env: undefined, timeout: number):
      Promise<{ exitCode: number; result: string }>;
  };
  delete(timeout: number, wait: boolean): Promise<void>;
}

type CreateSandbox = (params: CreateSandboxFromImageParams, options: { timeout: number }) => Promise<SmokeSandbox>;

// Only messages authored by this smoke test are safe to print at the CLI boundary.
export class DaytonaSmokeError extends AggregateError {}

export function daytonaErrorMessage(error: unknown): string {
  return error instanceof DaytonaSmokeError ? error.message : 'Daytona smoke failed; SDK error details were withheld.';
}

export async function runDaytonaSmoke(create: CreateSandbox, report: (message: string) => void): Promise<void> {
  const name = `herbie-smoke-${randomUUID()}`;
  report(`Creating sandbox ${name}`);
  let sandbox: SmokeSandbox;
  try {
    sandbox = await create({
      name,
      image: 'ubuntu:22.04',
      resources: { cpu: 1, memory: 1, disk: 1 },
      networkBlockAll: true,
      ttlMinutes: 5,
    }, { timeout: 120 });
  } catch (cause) {
    throw new DaytonaSmokeError([cause], `Creation failed for ${name}; cleanup is unconfirmed. Check Daytona by name.`, { cause });
  }

  const failures: Error[] = [];
  try {
    report(`Created sandbox ${sandbox.id}`);
    const response = await sandbox.process.executeCommand("printf 'herbie-daytona-ok\\n'", undefined, undefined, 10);
    if (response.exitCode !== 0) throw new Error(`Command exited ${response.exitCode}`);
    if (response.result !== 'herbie-daytona-ok\n') throw new Error('Unexpected command output');
    report('Command passed: herbie-daytona-ok');
  } catch (cause) {
    failures.push(new Error(`Command failed in sandbox ${sandbox.id}`, { cause }));
  } finally {
    try {
      await sandbox.delete(60, true);
      report(`Deletion confirmed for sandbox ${sandbox.id}`);
    } catch (cause) {
      failures.push(new Error(`Deletion unconfirmed for sandbox ${sandbox.id}; check Daytona before retrying`, { cause }));
    }
  }
  if (failures.length > 0) throw new DaytonaSmokeError(failures, failures.map(error => error.message).join('; '));
}
