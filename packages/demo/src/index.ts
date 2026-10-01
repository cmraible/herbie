import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rmdir } from 'node:fs/promises';
import { Auth } from './auth.js';
import { createApp } from './server.js';

const port = Number(process.env.PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const origin = `http://127.0.0.1:${port}`;
const directory = resolve(process.env.HERBIE_DATA_DIR || fileURLToPath(new URL('../../../.herbie', import.meta.url)));
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = resolve(directory, 'running.lock');
try { await mkdir(lock); }
catch { throw new Error(`Herbie may already be running. If it previously crashed, remove ${lock} and restart.`); }
const release = () => rmdir(lock).catch(() => {});
try {
  const auth = new Auth(directory, `${origin}/auth/callback`);
  await auth.init();
  const server = createApp(auth, origin);
  server.once('error', async () => { await release(); console.error('Could not start Herbie. Check whether the port is in use.'); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(`Herbie is ready at ${origin}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => { server.close(); server.closeAllConnections(); await release(); process.exit(0); });
  }
} catch (error) { await release(); throw error; }
