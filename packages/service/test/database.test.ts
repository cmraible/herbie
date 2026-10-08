import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { Pool } from 'pg';
import { test, type TestContext } from 'node:test';
import { Store } from '../src/store.js';
import { migrateAuth, PgAuthStore } from '../src/auth-store.js';
import { createDatabasePoolConfig, prepareDatabase } from '../src/database.js';

test('remote database configuration requires verified TLS and a private bounded session pool', async () => {
  const config = await createDatabasePoolConfig({ databaseUrl: 'postgresql://postgres.project:fixture-secret@aws-0-region.pooler.supabase.com:5432/postgres?sslmode=verify-full', mode: 'live' });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(config.options, '-c search_path=herbie');
  assert.equal(config.max, 5);
  assert.equal(config.connectionTimeoutMillis, 10_000);
  assert.equal(config.statement_timeout, 30_000);
  assert.ok(config.connectionString);
  assert.equal(new URL(config.connectionString).search, '');
  for (const query of ['sslmode=disable', 'sslmode=require', 'ssl=no-verify', 'sslrootcert=/tmp/untrusted', 'options=-c%20search_path=public']) {
    await assert.rejects(createDatabasePoolConfig({ databaseUrl: `postgresql://user:private-secret@db.example:5432/postgres?${query}`, mode: 'live' }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-secret/);
      return true;
    });
  }
  await assert.rejects(createDatabasePoolConfig({ databaseUrl: 'postgresql://postgres.project:secret@aws-0-region.pooler.supabase.com:6543/postgres', mode: 'live' }), /session|5432/);
});

async function privateDatabase(t: TestContext) {
  const url = process.env.HERBIE_TEST_DATABASE_URL;
  if (!url) { t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL security integration'); return null; }
  const address = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) throw new Error('Database security integration must use loopback Postgres');
  const suffix = randomUUID().replaceAll('-', '');
  const name = `herbie_private_${suffix}`;
  const owner = `herbie_owner_${suffix}`;
  const probe = `herbie_probe_${suffix}`;
  const password = randomUUID();
  const createdRoles: string[] = [];
  const additionalPools: Pool[] = [];
  const admin = new Pool({ connectionString: url });
  let created = false;
  let pool: Pool | undefined;
  let inspect: Pool | undefined;
  t.after(async () => {
    for (const additional of additionalPools) await additional.end();
    await pool?.end(); await inspect?.end();
    if (created) await admin.query(`DROP DATABASE ${name}`);
    for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  });
  for (const role of ['anon', 'authenticated', 'service_role', probe]) {
    if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
      await admin.query(`CREATE ROLE ${role} NOLOGIN`);
      createdRoles.push(role);
    }
  }
  await admin.query(`CREATE ROLE ${owner} LOGIN PASSWORD '${password}'`);
  createdRoles.push(owner);
  await admin.query(`CREATE DATABASE ${name} OWNER ${owner}`);
  created = true;
  address.pathname = `/${name}`;
  inspect = new Pool({ connectionString: address.href });
  address.username = owner;
  address.password = password;
  pool = new Pool(await createDatabasePoolConfig({ databaseUrl: address.href, mode: 'live' }));
  return { pool, inspect, probe, url: address.href, additionalPools };
}

test('private schema denies Data API roles, repairs old grants, and remains usable only by its trusted owner', async t => {
  const database = await privateDatabase(t);
  if (!database) return;
  const { pool, inspect, probe } = database;
  await pool.query('CREATE SCHEMA herbie');
  await pool.query('GRANT ALL ON SCHEMA herbie TO PUBLIC, anon, authenticated, service_role');
  await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA herbie GRANT ALL ON TABLES TO PUBLIC, anon, authenticated, service_role');
  await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA herbie GRANT ALL ON SEQUENCES TO PUBLIC, anon, authenticated, service_role');
  const store = new Store(pool);
  await store.migrate();
  await migrateAuth(pool);
  await pool.query("CREATE FUNCTION herbie.legacy_secret() RETURNS text LANGUAGE sql AS 'SELECT ''legacy secret''' ");
  await prepareDatabase(pool, 'live');
  await prepareDatabase(pool, 'live');
  const { goal } = await store.createGoal('owner', { repository: 'example/private', prompt: 'Sensitive goal', testCommand: ['node', '--test'], maxAttempts: 1 }, 'live', randomUUID());
  assert.equal((await store.getGoal(goal.id, 'owner'))?.prompt, 'Sensitive goal');
  const auth = new PgAuthStore(pool);
  await auth.putCredential({ id: 'owner', login: 'owner' }, 'encrypted-fixture-token', new Date(Date.now() + 60_000));
  assert.equal((await auth.credential('owner'))?.encryptedToken, 'encrypted-fixture-token');
  await pool.query('CREATE TABLE herbie.future_table(id bigserial PRIMARY KEY, secret text)');
  for (const role of ['anon', 'authenticated', 'service_role', probe]) {
    const schemaAccess = await inspect.query<Record<string, unknown>>('SELECT has_schema_privilege($1,\'herbie\',\'USAGE\') AS access', [role]);
    assert.equal(schemaAccess.rows[0]?.access, false);
    const tableAccess = await inspect.query<Record<string, unknown>>("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='herbie' AND c.relkind='r' AND has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')", [role]);
    assert.deepEqual(tableAccess.rows, []);
    assert.equal((await inspect.query<Record<string, unknown>>("SELECT has_function_privilege($1,'herbie.legacy_secret()','EXECUTE') AS access", [role])).rows[0]?.access, false);
    const client = await inspect.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      await assert.rejects(client.query('SELECT encrypted_token FROM herbie.auth_users'), { code: '42501' });
    } finally { await client.query('RESET ROLE'); client.release(); }
  }
  // RLS still blocks a client after accidental SQL grants and a permissive policy.
  await pool.query(`GRANT USAGE ON SCHEMA herbie TO ${probe}`);
  await pool.query(`GRANT SELECT ON herbie.goals TO ${probe}`);
  await pool.query('CREATE POLICY broad_access ON herbie.goals FOR SELECT TO PUBLIC USING (true)');
  const client = await inspect.connect();
  try {
    await client.query(`SET ROLE ${probe}`);
    assert.deepEqual((await client.query('SELECT prompt FROM herbie.goals')).rows, []);
  } finally { await client.query('RESET ROLE'); client.release(); }
  await prepareDatabase(pool, 'live');
  const tables = await pool.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='herbie' AND c.relkind='r' AND NOT c.relrowsecurity");
  assert.deepEqual(tables.rows, []);
});

test('database CA certificates work as PEM text or files without weakening verification', async t => {
  const ca = rootCertificates[0];
  assert.ok(ca);
  const directory = await mkdtemp(join(tmpdir(), 'herbie-database-ca-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caFile = join(directory, 'database-ca.pem');
  await writeFile(caFile, ca);
  const databaseUrl = 'postgresql://user:fixture@db.example:5432/postgres';
  const inline = await createDatabasePoolConfig({ databaseUrl, mode: 'live', ca });
  const file = await createDatabasePoolConfig({ databaseUrl, mode: 'live', caFile });
  assert.deepEqual(inline.ssl, { rejectUnauthorized: true, ca });
  assert.deepEqual(file.ssl, inline.ssl);
  await assert.rejects(createDatabasePoolConfig({ databaseUrl, mode: 'live', ca, caFile }), /only one/);
  await assert.rejects(createDatabasePoolConfig({ databaseUrl, mode: 'live', ca: 'not a certificate' }), /X.509/);
  const demo = await createDatabasePoolConfig({ databaseUrl: 'postgresql://user:fixture@127.0.0.1:55432/local', mode: 'demo' });
  assert.equal(demo.ssl, false);
  assert.equal(demo.options, '-c search_path=public');
  const localLive = await createDatabasePoolConfig({ databaseUrl: 'postgresql://user:fixture@127.0.0.1:55432/local', mode: 'live' });
  assert.equal(localLive.ssl, false);
  assert.equal(localLive.options, '-c search_path=herbie');
});

test('live preparation refuses a public search path while demo keeps its selected isolated schema', async t => {
  const database = await privateDatabase(t);
  if (!database) return;
  const wrong = new Pool({ connectionString: database.url, options: '-c search_path=public' });
  database.additionalPools.push(wrong);
  await assert.rejects(prepareDatabase(wrong, 'live'), /private herbie schema/);
  assert.equal((await wrong.query<Record<string, unknown>>("SELECT to_regclass('public.goals') AS name")).rows[0]?.name, null);
  const selected = `demo_${randomUUID().replaceAll('-', '')}`;
  await wrong.query(`CREATE SCHEMA ${selected}`);
  const demoPool = new Pool({ connectionString: database.url, options: `-c search_path=${selected}` });
  database.additionalPools.push(demoPool);
  await prepareDatabase(demoPool, 'demo');
  const store = new Store(demoPool);
  const { goal } = await store.createGoal('demo-user', { repository: 'demo/example', prompt: 'Local demo', testCommand: ['node', '--test'], maxAttempts: 1 }, 'demo', randomUUID());
  assert.equal((await store.getGoal(goal.id))?.prompt, 'Local demo');
  assert.equal((await demoPool.query<Record<string, unknown>>('SELECT current_schema() AS name')).rows[0]?.name, selected);
});
