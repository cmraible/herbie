import { Daytona } from '@daytona/sdk';
import { runDaytonaSmoke } from '../src/daytona.js';

async function main(): Promise<void> {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey?.trim()) throw new Error('Set DAYTONA_API_KEY in the host environment before running test:daytona.');
  await using daytona = new Daytona({ apiKey, requestTimeoutMs: 30_000 });
  await runDaytonaSmoke((params, options) => daytona.create(params, options), console.log);
  console.log('PASS: Daytona created the sandbox, ran the probe, and confirmed deletion.');
}

main().catch(error => {
  // SDK causes may include request details; print only our safe phase summary.
  console.error(error instanceof Error ? error.message : 'Daytona smoke failed.');
  process.exitCode = 1;
});
