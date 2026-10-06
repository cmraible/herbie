import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CreateSandboxFromSnapshotParams, Sandbox } from '@daytona/sdk';

type AttemptSandbox = Pick<Sandbox, 'id' | 'delete'> & {
  git: Pick<Sandbox['git'], 'clone'>;
  fs: {
    createFolder: Sandbox['fs']['createFolder'];
    uploadFile(file: Buffer, path: string, timeout: number): Promise<void>;
  };
  process: Pick<Sandbox['process'], 'executeCommand'>;
};
type CreateSandbox = (params: CreateSandboxFromSnapshotParams, options: { timeout: number }) => Promise<AttemptSandbox>;
type Request = Pick<CreateSandboxFromSnapshotParams, 'secrets' | 'outboundProxyUrl'> & {
  snapshot: string; domainAllowList: string; repoUrl: string; commit?: string; goal: string;
};

export class DaytonaAttemptError extends AggregateError {}

// Use the built adapter (or provide a directory containing the built runtime files).
// Secret values stay outside Herbie; secrets contains existing Daytona Secret names only.
export async function runDaytonaAttempt(
  create: CreateSandbox, request: Request, report: (message: string) => void,
  runtimeDirectory = new URL('.', import.meta.url),
): Promise<void> {
  const repo = new URL(request.repoUrl);
  if (repo.protocol !== 'https:' || repo.username || repo.password || repo.search || repo.hash) {
    throw new Error('Use a public HTTPS repository URL without credentials, query, or fragment');
  }
  if (!request.snapshot.trim() || !request.domainAllowList.trim() || !request.goal.trim()) {
    throw new Error('Snapshot, domain allowlist, and goal are required');
  }
  const runtime = await Promise.all([
    'codex-initialize.js', 'codex-thread.js', 'codex-turn.js', 'codex-process.js', 'daytona-runner.js',
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
    const result = await sandbox.process.executeCommand(`node ${directory}/daytona-runner.js`, directory, undefined, 360);
    if (result.exitCode !== 0 || result.result !== 'herbie-attempt-completed\n') throw new Error('Sandbox goal attempt failed');
    report(`Goal completed in sandbox ${sandbox.id}`);
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
  if (failures.length) throw new DaytonaAttemptError(failures, failures.map(error => error.message).join('; '));
}
