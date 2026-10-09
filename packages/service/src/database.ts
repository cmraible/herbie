import type {StartupPhase} from './startup-progress.js';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getCACertificates } from 'node:tls';
import { supabaseProductionCa } from './supabase-ca.js';
import type { Pool, PoolConfig } from 'pg';
import { Store } from './store.js';
import { migrateAuth } from './auth-store.js';

type DatabaseConfig = {databaseUrl:string;mode:'demo'|'live';ca?:string;caFile?:string};
export async function createDatabasePoolConfig(config: DatabaseConfig): Promise<PoolConfig> {
  let url: URL;
  try { url = new URL(config.databaseUrl); }
  catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1) || url.hash) {
    throw new Error('DATABASE_URL must identify a PostgreSQL host, user, and database');
  }
  // pg connection-string SSL/options fields override PoolConfig. Accept a verified-TLS
  // hint only, then remove all query fields so they cannot weaken our explicit settings.
  for (const [name, value] of url.searchParams) {
    if (name !== 'sslmode' || value !== 'verify-full') throw new Error('DATABASE_URL only supports sslmode=verify-full; configure the CA through HERBIE_DATABASE_CA or HERBIE_DATABASE_CA_FILE');
  }
  const verifiedHint = url.searchParams.has('sslmode');
  url.search = '';
  if (url.hostname.endsWith('.supabase.com') && url.port === '6543' || url.hostname.endsWith('.supabase.co') && url.port === '6543') {
    throw new Error('Herbie requires a direct connection or the Supavisor session pooler on port 5432, not transaction pooling');
  }
  if (config.ca !== undefined && config.caFile !== undefined) throw new Error('Set only one of HERBIE_DATABASE_CA and HERBIE_DATABASE_CA_FILE');
  const ca = config.ca ?? (config.caFile === undefined ? undefined : await readFile(config.caFile, 'utf8'));
  if (ca !== undefined) {
    try { new X509Certificate(ca); }
    catch { throw new Error('Database CA must be a PEM-encoded X.509 certificate'); }
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const tls = config.mode === 'live' && !loopback || verifiedHint || ca !== undefined;
  // Add the vendor root only for recognized Supabase database endpoints. Explicit
  // operator CA settings replace the fallback, and other connections keep Node's
  // default trust. Never mutate global trust or override hostname verification.
  const supabaseDatabase = /^(?:db\.[a-z0-9]+\.supabase\.co|[a-z0-9]+(?:-[a-z0-9]+)*\.pooler\.supabase\.com)$/.test(url.hostname);
  const trustedCa = ca ?? (tls && supabaseDatabase ? [...getCACertificates('default'), supabaseProductionCa] : undefined);
  return {
    connectionString: url.href,
    ssl: tls ? { rejectUnauthorized: true, ...(trustedCa === undefined ? {} : { ca: trustedCa }) } : false,
    options: `-c search_path=${config.mode === 'live' ? 'herbie' : 'public'}`,
    max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000,
    statement_timeout: 30_000, idle_in_transaction_session_timeout: 30_000,
    keepAlive: true, application_name: 'herbie-service',
  };
}

async function protectPrivateSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('herbie-private-schema-v1'))");
    const searchPath = await client.query<Record<string, unknown>>("SELECT current_setting('search_path') AS path");
    if (searchPath.rows[0]?.path !== 'herbie') throw Object.assign(new Error('Live database search_path must contain only the private herbie schema'),{code:'HERBIE_SEARCH_PATH_MISMATCH'});
    await client.query('CREATE SCHEMA IF NOT EXISTS herbie');
    await client.query(`
      DO $herbie_private$
      DECLARE grantee text; object_kind text; relation record;
      BEGIN
        FOR grantee IN
          SELECT 'PUBLIC' UNION ALL
          SELECT quote_ident(rolname) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')
        LOOP
          EXECUTE format('REVOKE ALL ON SCHEMA herbie FROM %s', grantee);
          FOREACH object_kind IN ARRAY ARRAY['TABLES','SEQUENCES','FUNCTIONS'] LOOP
            EXECUTE format('REVOKE ALL ON ALL %s IN SCHEMA herbie FROM %s', object_kind, grantee);
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA herbie REVOKE ALL ON %s FROM %s', object_kind, grantee);
          END LOOP;
        END LOOP;
        FOR relation IN
          SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='herbie' AND c.relkind IN ('r','p')
        LOOP
          EXECUTE format('ALTER TABLE herbie.%I ENABLE ROW LEVEL SECURITY', relation.relname);
          EXECUTE format('DROP POLICY IF EXISTS herbie_server_only ON herbie.%I', relation.relname);
          EXECUTE format('CREATE POLICY herbie_server_only ON herbie.%I AS RESTRICTIVE TO PUBLIC USING (false) WITH CHECK (false)', relation.relname);
        END LOOP;
      END $herbie_private$;
    `);
    // Role inheritance or ownership outside this application's schema is not repaired
    // implicitly. Fail closed if a Data API role still reaches the private namespace.
    const reachable = await client.query<Record<string, unknown>>("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') AND has_schema_privilege(oid,'herbie','USAGE,CREATE')");
    if (reachable.rows.length) throw Object.assign(new Error('A Data API role still has private-schema access; use a dedicated trusted database owner'),{code:'HERBIE_PRIVATE_SCHEMA_ACCESS'});
    await client.query('COMMIT');
  } catch (error) { try{await client.query('ROLLBACK');}catch{/* Preserve the original failure. */} throw error; }
  finally { client.release(); }
}

export async function prepareDatabase(pool: Pool, mode: 'demo' | 'live',phase?:(phase:StartupPhase)=>void): Promise<void> {
  // Revoke namespace access before migrations, so even legacy default grants cannot
  // expose a newly created table while migrations are running.
  if (mode === 'live') {phase?.('schema-protection');await protectPrivateSchema(pool);}
  phase?.('application-migrations');await new Store(pool).migrate();
  phase?.('auth-migrations');await migrateAuth(pool);
  if (mode === 'live') {phase?.('schema-verification');await protectPrivateSchema(pool);}
}
