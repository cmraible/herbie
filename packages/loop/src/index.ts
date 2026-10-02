import { parseArgs } from 'node:util';

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
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exitCode = 1;
}
