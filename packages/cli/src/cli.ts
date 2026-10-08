import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { goalInput, actionSchema } from '@herbie/contracts';
import { createClient, ApiError } from '@herbie/contracts/client';

const savedSession = z.object({baseUrl: z.string().url(), token: z.string().min(1)}).strict();
const help = `Herbie — durable coding goals\n\nCommands:\n  login --url URL [--demo]\n  logout\n  repositories\n  start --repo OWNER/REPO --prompt TEXT --test '["npm","test"]' [--max-attempts 1] [--request-id UUID]\n  status [GOAL_ID]\n  logs GOAL_ID [--after EVENT_ID]\n  pause|resume|cancel GOAL_ID\n\nResults are JSON. Login instructions and request IDs go to stderr.\n--demo explicitly uses a loopback-only deterministic service.\nSession file: HERBIE_CONFIG or ~/.config/herbie/session.json (mode 0600).\nGoals continue after this CLI exits. Reuse --request-id to safely retry a start.\n`;

export type CliIO = {configPath?: string; stdout: (value: string) => void; stderr: (value: string) => void};

function serviceUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Service URL must be an origin, without credentials, query, or path');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Use HTTPS, or HTTP on loopback for local development');
  return url.origin;
}

async function save(path: string, value: z.infer<typeof savedSession>) {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally { await rm(temporary, {force:true}); }
}

export async function runCli(args: string[], io: CliIO): Promise<number> {
  try {
    const { values, positionals } = parseArgs({args, allowPositionals: true, strict: true, options: {
      url: {type: 'string'}, demo: {type: 'boolean'}, repo: {type: 'string'}, prompt: {type: 'string'}, test: {type: 'string'},
      'max-attempts': {type: 'string'}, 'request-id': {type: 'string'}, after: {type: 'string'}, help: {type:'boolean',short:'h'},
    }});
    const [command, id, extra] = positionals;
    if (values.help || !command) { io.stdout(help); return 0; }
    if (extra) throw new Error('Unexpected positional argument');
    const configPath = io.configPath ?? process.env.HERBIE_CONFIG ?? join(homedir(), '.config', 'herbie', 'session.json');
    const print = (value: unknown) => io.stdout(JSON.stringify(value, null, 2) + '\n');
    if (command === 'login') {
      const baseUrl = serviceUrl(values.url ?? 'http://127.0.0.1:8787');
      const client = createClient({baseUrl, origin:baseUrl});
      if (values.demo) {
        if (!['localhost','127.0.0.1','[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('Demo login is only available on loopback');
        const result = await client.demoCliLogin();
        await save(configPath, {baseUrl, token: result.token}); print(result.session); return 0;
      }
      const auth = await client.authStart('cli');
      if (!auth.pollToken) throw new Error('Service did not provide a CLI login token');
      if (!auth.userCode) throw new Error('Service did not provide a CLI approval code; no session saved');
      io.stderr(`Service: ${baseUrl}\nApproval code: ${auth.userCode}\nOnly approve if you started this login on this computer. Enter this code in the browser. Never approve a code sent by someone else.\nOpen this URL to sign in with GitHub:\n${auth.url}\nWaiting for browser authorization…\n`);
      for (let count = 0; count < 150; count++) {
        const result = await client.authPoll(auth.pollToken);
        if (result.status === 'expired') throw new Error('Login expired; run login again');
        if (result.status === 'rejected') throw new Error('CLI authorization rejected; no session saved');
        if (result.status === 'complete') {
          if (!result.token) throw new Error('Service did not provide a session');
          const session = await createClient({baseUrl, origin:baseUrl, token: result.token}).session();
          await save(configPath, {baseUrl, token: result.token}); print(session); return 0;
        }
        await setTimeout(2000);
      }
      throw new Error('Login timed out; run login again');
    }
    if (values.demo) throw new Error('--demo is only valid with login');
    const metadata = await lstat(configPath).catch(() => null);
    if (!metadata) throw new Error('No valid session. Run herbie login --url URL first');
    if (!metadata.isFile() || (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600)) throw new Error('Session file must be private (0600); run login again');
    let config: z.infer<typeof savedSession>;
    try { config = savedSession.parse(JSON.parse(await readFile(configPath, 'utf8'))); }
    catch { throw new Error('No valid session. Run herbie login --url URL first'); }
    const baseUrl = serviceUrl(config.baseUrl);
    if (values.url && serviceUrl(values.url) !== baseUrl) throw new Error('Service URL differs from saved session; log in to that service first');
    const client = createClient({baseUrl, origin:baseUrl, token: config.token});
    if (command === 'logout') {
      // Clear the local credential before a network attempt that could fail or hang.
      await rm(configPath, {force:true});
      try { await client.logout(); }
      catch (failure) {
        if (!(failure instanceof ApiError && failure.status === 401)) {
          throw new Error(`Local session removed; remote sign-out could not be confirmed: ${failure instanceof Error ? failure.message : 'Unknown error'}`);
        }
      }
      print({ok:true}); return 0;
    }
    if (command === 'repositories') { print(await client.repositories()); return 0; }
    if (command === 'status') { print(id ? await client.goal(id) : await client.goals()); return 0; }
    if (command === 'start') {
      if (id) throw new Error('start accepts options, not a goal ID');
      let testCommand: unknown;
      try { testCommand = JSON.parse(values.test ?? ''); } catch { throw new Error('--test must be a JSON argument array, e.g. \'["npm","test"]\''); }
      const input = goalInput.parse({repository:values.repo, prompt:values.prompt, testCommand, maxAttempts:Number(values['max-attempts'] ?? 1)});
      const requestId = z.uuid().parse(values['request-id'] ?? randomUUID());
      io.stderr(`Request ID: ${requestId}\nIf the response is interrupted, retry with --request-id ${requestId}\n`);
      print(await client.start(input, requestId)); return 0;
    }
    if (!id) throw new Error(`${command} requires a goal ID`);
    if (command === 'logs') { print(await client.events(id, Number(values.after ?? 0))); return 0; }
    const action = actionSchema.safeParse(command);
    if (action.success) { print(await client.action(id, action.data)); return 0; }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    io.stderr(JSON.stringify({error:error instanceof Error ? error.message : 'Unknown error'}) + '\n'); return 1;
  }
}
