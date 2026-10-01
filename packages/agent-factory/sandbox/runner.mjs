import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const root = '/tmp/herbie';
const resultPath = '/tmp/herbie-result.json';
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let output = '';
    child.stdout.on('data', b => { if (output.length < 65536) output += b.toString(); });
    // Do not send customer code or credentials to coordinator logs.
    child.stderr.resume();
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error('Command failed')));
    child.stdin.end(options.input ?? '');
  });
}
async function finish(result) { await writeFile(resultPath, JSON.stringify(result)); }
// flock ensures only one process can check this marker and execute a job.
if (await exists(resultPath)) process.exit(0);
if (await exists('/tmp/herbie-started')) { await finish({ status: 'failed' }); process.exit(1); }
await writeFile('/tmp/herbie-started', '1');
try {
  const job = JSON.parse(await readFile('/tmp/herbie-job.json', 'utf8'));
  await mkdir(root, { recursive: true });
  // A real build + container + Compose stack, not merely `docker --version`.
  await exec('bash', ['/opt/herbie/docker-preflight.sh']);
  const askpass = `${root}/askpass.sh`;
  await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s" herbie;; *) printf "%s" "$HERBIE_RUN_TOKEN";; esac\n', { mode: 0o700 });
  const env = { ...process.env, HERBIE_RUN_TOKEN: job.token, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0',
    CODEX_HOME: `${root}/codex`, OPENAI_API_KEY: undefined };
  const repo = `${root}/repo`;
  await exec('git', ['clone', `${job.origin}/git/${job.repo}.git`, repo], { env });
  const git = args => exec('git', args, { cwd: repo, env });
  await git(['config', 'user.name', 'Herbie']); await git(['config', 'user.email', 'herbie@users.noreply.github.com']);
  const remote = await git(['ls-remote', '--heads', 'origin', job.branch]);
  if (remote) await git(['checkout', '-B', job.branch, `origin/${job.branch}`]);
  else if (job.kind === 'repair') throw new Error('Repair branch disappeared');
  else await git(['checkout', '-b', job.branch]);
  // A push can succeed immediately before VM loss or a lost result response.
  // The commit itself carries the logical-run checkpoint outside the VM.
  const initialHead = await git(['rev-parse', 'HEAD']);
  const priorMessage = await git(['log', '-1', '--format=%B']);
  const marker = 'Herbie-Checkpoint: ';
  const checkpointLine = priorMessage.split('\n').find(line => line.startsWith(marker));
  if (checkpointLine) {
    try {
      const prior = JSON.parse(checkpointLine.slice(marker.length));
      if (prior.run === job.runId) {
        await finish({ status: 'succeeded', checkpoint: await git(['rev-parse', 'HEAD']), summary: prior.summary });
        process.exit(0);
      }
    } catch { /* A foreign commit message is not a Herbie checkpoint. */ }
  }
  await mkdir(env.CODEX_HOME, { recursive: true });
  await writeFile(`${env.CODEX_HOME}/config.toml`, [
    `model = ${JSON.stringify(job.model)}`, 'model_provider = "herbie"',
    '[model_providers.herbie]', 'name = "Herbie hosted API"',
    `base_url = ${JSON.stringify(job.origin + '/model/v1')}`, 'env_key = "HERBIE_RUN_TOKEN"',
    'wire_api = "responses"', 'requires_openai_auth = false',
  ].join('\n'));
  const prompt = job.instructions;
  const summaryPath = `${root}/summary.json`;
  const schemaPath = `${root}/summary-schema.json`;
  await writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: false,
    properties: { problem: { type: 'string', minLength: 1, maxLength: 2000 }, change: { type: 'string', minLength: 1, maxLength: 2000 }, verification: { type: 'string', minLength: 1, maxLength: 2000 } },
    required: ['problem', 'change', 'verification'] }));
  // The enclosing dedicated VM is the isolation boundary; there is no host Docker socket.
  await exec('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--output-schema', schemaPath, '--output-last-message', summaryPath, '-'], { cwd: repo, env, input: prompt });
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  for (const key of ['problem', 'change', 'verification']) if (typeof summary[key] !== 'string' || !summary[key].trim() || summary[key].length > 2000) throw new Error('Invalid summary');
  await git(['add', '-A']);
  if (await git(['status', '--porcelain'])) await git(['commit', '-m', summary.problem.split('\n')[0].slice(0, 150), '-m', marker + JSON.stringify({ run: job.runId, summary })]);
  // Repository instructions may have caused Codex to commit itself. Attach the
  // checkpoint to its unpushed tip as well, without creating a metadata-only commit.
  if (await git(['rev-parse', 'HEAD']) !== initialHead && !(await git(['log', '-1', '--format=%B'])).includes(marker + JSON.stringify({ run: job.runId, summary }))) {
    await git(['commit', '--amend', '-m', summary.problem.split('\n')[0].slice(0, 150), '-m', marker + JSON.stringify({ run: job.runId, summary })]);
  }
  const checkpoint = await git(['rev-parse', 'HEAD']);
  // A scoped Git proxy enforces the one branch writable by this job.
  await git(['push', 'origin', `HEAD:refs/heads/${job.branch}`]);
  await finish({ status: 'succeeded', checkpoint, summary });
} catch {
  await finish({ status: 'failed' }); process.exitCode = 1;
}
