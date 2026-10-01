import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { migrate } from "../../scripts/migrate";
import { testEnv } from "../../scripts/test-env";

async function isolatedDatabase(run: (connection: string, directory: string) => Promise<void>) {
  const connection = new URL(testEnv().DATABASE_URL);
  const admin = new Pool({ connectionString: connection.toString() });
  const name = "migration_test_" + crypto.randomUUID().replaceAll("-", "");
  const directory = await mkdtemp(join(tmpdir(), "subscription-migrations-"));
  // Database creation is fixture setup; assertions observe the public migration command.
  await admin.query(`CREATE DATABASE ${name}`);
  connection.pathname = "/" + name;
  try {
    await run(connection.toString(), directory);
  } finally {
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}
test("migration replay is safe and editing an applied migration fails before new SQL executes", async () => {
  await isolatedDatabase(async (connection, directory) => {
    await writeFile(join(directory, "001.sql"), "CREATE TABLE initial(id integer);");
    await migrate(connection, directory);
    await migrate(connection, directory);
    await writeFile(join(directory, "001.sql"), "CREATE TABLE edited(id integer);");
    await writeFile(join(directory, "002.sql"), "INVALID SQL THAT MUST NOT EXECUTE;");
    await expect(migrate(connection, directory)).rejects.toThrow(/Migration drift: 001.sql/);
    await rm(join(directory, "001.sql"));
    await expect(migrate(connection, directory)).rejects.toThrow(/Migration drift: 001.sql/);
  });
});

test("failed migration batches roll back and corrected forward files can be retried", async () => {
  await isolatedDatabase(async (connection, directory) => {
    await writeFile(join(directory, "001.sql"), "CREATE TABLE initial(id integer);");
    await writeFile(join(directory, "002.sql"), "INVALID SQL;");
    await expect(migrate(connection, directory)).rejects.toThrow(/syntax error/);
    await writeFile(join(directory, "002.sql"), "ALTER TABLE initial ADD COLUMN label text;");
    await migrate(connection, directory);
    await writeFile(join(directory, "000.sql"), "SELECT 1;");
    await expect(migrate(connection, directory)).rejects.toThrow(/append to history/);
  });
});

test("legacy migration history requires verification instead of silently adopting current files", async () => {
  await isolatedDatabase(async (connection, directory) => {
    const legacy = new Pool({ connectionString: connection });
    try {
      await legacy.query(
        "CREATE SCHEMA subscription_meta; CREATE TABLE subscription_meta.migrations(name text PRIMARY KEY); INSERT INTO subscription_meta.migrations VALUES('001.sql');",
      );
    } finally {
      await legacy.end();
    }
    await writeFile(join(directory, "001.sql"), "SELECT 1;");
    await expect(migrate(connection, directory)).rejects.toThrow(/Unverified migration history/);
  });
});
