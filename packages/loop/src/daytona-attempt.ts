import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CreateSandboxFromSnapshotParams, Sandbox } from '@daytona/sdk';

type AttemptSandbox = Pick<Sandbox, 'id' | 'delete'> & {
  git: Pick<Sandbox['git'], 'clone'>;
  fs: {
    createFolder: Sandbox['fs']['createFolder'];
    uploadFile(file: Buffer, path: string, timeout: number): Promise<void>;
    downloadFile(path: string, timeout: number): Promise<Buffer>;
  };
  process: Pick<Sandbox['process'], 'executeCommand'>;
};
type CreateSandbox = (params: CreateSandboxFromSnapshotParams, options: { timeout: number }) => Promise<AttemptSandbox>;
type Request = Pick<CreateSandboxFromSnapshotParams, 'secrets' | 'outboundProxyUrl'> & {
  snapshot: string; domainAllowList: string; repoUrl: string; commit?: string; goal: string;
  testCommand?: string[]; testTimeoutMs?: number;
};

export interface DaytonaTestResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DaytonaAttemptChanges {
  baseCommit: string;
  patch: Buffer;
  testResult?: DaytonaTestResult;
  // Issued by the host only after the goal, tests, and sandbox deletion succeed.
  verification?: {
    repoUrl: string;
    baseCommit: string;
    patchSha256: string;
    testCommand: string[];
    goalCompleted: true;
    sandboxDeleted: true;
  };
}

export class DaytonaAttemptError extends AggregateError {
  // Keep retrieved changes available even if subsequent testing or deletion fails.
  changes?: DaytonaAttemptChanges;
}

// Use the built adapter (or provide a directory containing the built runtime files).
// Secret values stay outside Herbie; secrets contains existing Daytona Secret names only.
export async function runDaytonaAttempt(
  create: CreateSandbox, request: Request, report: (message: string) => void,
  runtimeDirectory = new URL('.', import.meta.url),
): Promise<DaytonaAttemptChanges> {
  const repo = new URL(request.repoUrl);
  if (repo.protocol !== 'https:' || repo.username || repo.password || repo.search || repo.hash) {
    throw new Error('Use a public HTTPS repository URL without credentials, query, or fragment');
  }
  if (!request.snapshot.trim() || !request.domainAllowList.trim() || !request.goal.trim()) {
    throw new Error('Snapshot, domain allowlist, and goal are required');
  }
  const testTimeoutMs = request.testTimeoutMs ?? 60_000;
  if (request.testCommand !== undefined && (!Array.isArray(request.testCommand) || !request.testCommand.length
    || request.testCommand.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !request.testCommand[0].trim())) {
    throw new Error('Test command must contain an executable followed by literal arguments');
  }
  if (!Number.isInteger(testTimeoutMs) || testTimeoutMs < 1 || testTimeoutMs > 60_000) {
    throw new Error('Test timeout must be an integer from 1 to 60000 milliseconds');
  }
  const testCommand = request.testCommand?.slice();
  const runtime = await Promise.all([
    'codex-initialize.js', 'codex-thread.js', 'codex-turn.js', 'codex-process.js', 'daytona-runner.js', 'daytona-test-runner.js',
  ].map(async name => ({ name, contents: await readFile(new URL(name, runtimeDirectory)) })));
  const name = `herbie-attempt-${randomUUID()}`;
  const directory = `/tmp/${name}`;
  const cwd = `${directory}/repo`;
  report(`Creating sandbox ${name}`);
  let sandbox: AttemptSandbox;
  try {
    sandbox = await create({
      name, snapshot: request.snapshot, domainAllowList: request.domainAllowList,
      secrets: request.secrets, outboundProxyUrl: request.outboundProxyUrl, ttlMinutes: 15,
    }, { timeout: 120 });
  } catch (cause) {
    throw new DaytonaAttemptError([cause], `Creation failed for ${name}; cleanup is unconfirmed. Check Daytona by name.`, { cause });
  }
  const failures: Error[] = [];
  let changes: DaytonaAttemptChanges | undefined;
  try {
    report(`Created sandbox ${sandbox.id}`);
    const preflight = await sandbox.process.executeCommand(
      `node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' && git --version && codex --version`,
      undefined, undefined, 30,
    );
    if (preflight.exitCode !== 0) throw new Error('Snapshot requires Node 24+, Git, and Codex on PATH');
    await sandbox.fs.createFolder(directory, '700');
    for (const file of runtime) await sandbox.fs.uploadFile(file.contents, `${directory}/${file.name}`, 30);
    await sandbox.fs.uploadFile(Buffer.from('{"type":"module"}'), `${directory}/package.json`, 30);
    await sandbox.fs.uploadFile(Buffer.from(JSON.stringify({ cwd, goal: request.goal })), `${directory}/attempt.json`, 30);
    await sandbox.git.clone(repo.href, cwd, undefined, request.commit);
    report(`Running goal in sandbox ${sandbox.id}`);
    // Only the generated UUID path enters the shell. The goal and repo URL never do.
    const result = await sandbox.process.executeCommand(`node ${directory}/daytona-runner.js`, directory, undefined, 480);
    if (result.exitCode !== 0 || result.result !== 'herbie-attempt-completed\n') throw new Error('Sandbox goal attempt failed');
    report(`Goal completed in sandbox ${sandbox.id}`);
    const artifact: unknown = JSON.parse((await sandbox.fs.downloadFile(`${directory}/changes.json`, 30)).toString('utf8'));
    if (typeof artifact !== 'object' || artifact === null
      || !('baseCommit' in artifact) || typeof artifact.baseCommit !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(artifact.baseCommit)
      || !('patchBase64' in artifact) || typeof artifact.patchBase64 !== 'string') throw new Error('Invalid repository changes artifact');
    const patch = Buffer.from(artifact.patchBase64, 'base64');
    if (patch.toString('base64') !== artifact.patchBase64) throw new Error('Invalid repository patch encoding');
    changes = { baseCommit: artifact.baseCommit, patch };
    report(`Changes retrieved from sandbox ${sandbox.id}`);
    if (testCommand) {
      await sandbox.fs.uploadFile(changes.patch, `${directory}/recovered.patch`, 30);
      await sandbox.fs.uploadFile(Buffer.from(JSON.stringify({
        cwd, baseCommit: changes.baseCommit, command: testCommand, timeoutMs: testTimeoutMs,
      })), `${directory}/test.json`, 30);
      report(`Testing recovered changes in sandbox ${sandbox.id}`);
      const verification = await sandbox.process.executeCommand(`node ${directory}/daytona-test-runner.js`, directory, undefined, 150);
      if (verification.exitCode !== 0 || verification.result !== 'herbie-tests-completed\n') throw new Error('Patch verification failed to complete');
      const outcome: unknown = JSON.parse((await sandbox.fs.downloadFile(`${directory}/test-result.json`, 30)).toString('utf8'));
      if (typeof outcome !== 'object' || outcome === null
        || !('exitCode' in outcome) || typeof outcome.exitCode !== 'number' || !Number.isInteger(outcome.exitCode) || outcome.exitCode < 0
        || !('stdout' in outcome) || typeof outcome.stdout !== 'string'
        || !('stderr' in outcome) || typeof outcome.stderr !== 'string') throw new Error('Invalid repository test result');
      changes.testResult = { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr };
      if (outcome.exitCode !== 0) throw new Error(`Repository tests exited ${outcome.exitCode}`);
      report(`Repository tests passed in sandbox ${sandbox.id}`);
    }
  } catch (cause) {
    failures.push(new Error(`Attempt failed in sandbox ${sandbox.id}`, { cause }));
  } finally {
    try {
      await sandbox.delete(60, true);
      report(`Deletion confirmed for sandbox ${sandbox.id}`);
    } catch (cause) {
      failures.push(new Error(`Deletion unconfirmed for sandbox ${sandbox.id}; check Daytona before retrying`, { cause }));
    }
  }
  if (!failures.length && changes) {
    if (testCommand && changes.testResult?.exitCode === 0) {
      changes.verification = {
        repoUrl: repo.href, baseCommit: changes.baseCommit,
        patchSha256: createHash('sha256').update(changes.patch).digest('hex'),
        testCommand, goalCompleted: true, sandboxDeleted: true,
      };
    }
    return changes;
  }
  const error = new DaytonaAttemptError(failures, failures.map(error => error.message).join('; '));
  error.changes = changes;
  throw error;
}
