import { Pool } from "pg";
import type { Config } from "./config.js";
import { supabaseProductionCa } from "./supabase-ca.js";

export function createPool(config: Config) {
  const url = new URL(config.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("DATABASE_URL must use Postgres");
  const local = ["localhost", "127.0.0.1", "[::1]", "db"].includes(url.hostname);
  // URL parameters must not override TLS or the private schema.
  for (const key of url.searchParams.keys())
    if (key !== "sslmode") throw new Error("Unsupported database URL option");
  url.search = "";
  const ca =
    config.DATABASE_CA ||
    (/^(?:db\.[a-z0-9]+\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$/.test(url.hostname)
      ? supabaseProductionCa
      : undefined);
  return new Pool({
    connectionString: url.href,
    options: `-c search_path=${config.DATABASE_SCHEMA}`,
    ssl: local ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: 10,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
}

export async function ensurePrivateSchema(pool: Pool, schema: string) {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(schema) ||
    ["public", "herbie", "auth", "storage"].includes(schema)
  )
    throw new Error("Use a separate private database schema for the rebuild");
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
  const { rows } = await pool.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')",
  );
  for (const { rolname } of rows) {
    await pool.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${rolname}`);
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${rolname}`);
    await pool.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${rolname}`);
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM ${rolname}`,
    );
  }
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]);
  for (const { tablename } of tables.rows) {
    const quoted = `"${tablename.replaceAll('"', '""')}"`;
    await pool.query(`ALTER TABLE ${schema}.${quoted} ENABLE ROW LEVEL SECURITY`);
    await pool.query(`REVOKE ALL ON ${schema}.${quoted} FROM PUBLIC`);
  }
}
