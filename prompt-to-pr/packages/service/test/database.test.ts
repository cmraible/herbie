import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { createPool, ensurePrivateSchema } from "../src/database.js";
import { createIdentity } from "../src/auth.js";
import { Store } from "../src/store.js";

test("full migrations are idempotent in a private schema and all tables deny anonymous access", async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema = `private_${randomUUID().replaceAll("-", "")}`;
  const config = {
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_SCHEMA: schema,
    PUBLIC_URL: "http://localhost:8787",
    AUTH_SECRET: "test-secret-at-least-thirty-two-characters",
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "test",
    GITHUB_CLIENT_ID: "test",
    GITHUB_CLIENT_SECRET: "test",
    GITHUB_PRIVATE_KEY: "test",
    ALLOWED_GITHUB_IDS: "123",
    AGENT_MODEL: "test",
    PORT: 8787,
  };
  const pool = createPool(config);
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await ensurePrivateSchema(pool, schema);
      await new Store(pool).migrate();
      const auth = createIdentity(config, pool);
      await (await getMigrations(auth.identity.options)).runMigrations();
      await ensurePrivateSchema(pool, schema);
    }
    const { rows } = await pool.query(
      "select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind='r'",
      [schema],
    );
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => row.relrowsecurity));
    assert.equal((await pool.query("select current_schema() as name")).rows[0].name, schema);
    await assert.rejects(ensurePrivateSchema(pool, "herbie"));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
