import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const usage = 'Usage: pnpm start --repo <path> --goal <goal>';

function main(): void {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      goal: { type: 'string' },
      help: { type: 'boolean' },
    },
  });

  if (values.help) {
    console.log(usage);
    return;
  }

  if (!values.repo?.trim() || !values.goal?.trim()) {
    throw new Error('Both --repo and --goal must be nonempty.');
  }

  console.log(`Repository: ${values.repo}`);
  console.log(`Goal: ${values.goal}`);

  const prompt = [
    'Make one small improvement aligned with the goal below.',
    'Read the repository instructions, implement the change, and run proportionate tests.',
    'Keep the code minimal and readable. Summarize the change and verification.',
    'Leave changes local. Do not commit, push, create a pull request, or merge.',
    '',
    `Goal: ${values.goal}`,
  ].join('\n');

  spawnSync('codex', ['exec', '--cd', values.repo, '--sandbox', 'workspace-write', prompt], {
    stdio: 'inherit',
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exitCode = 1;
}
