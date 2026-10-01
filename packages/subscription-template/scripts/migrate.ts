import { readdir, readFile } from "node:fs/promises";
import { database } from "../src/database";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
export async function migrate(connection: string, directory = "supabase/migrations") {
  const files = await Promise.all(
    (await readdir(directory))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map(async (name) => {
        const sql = await readFile(directory + "/" + name, "utf8");
        return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
      }),
  );
  const pool = database(connection);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize even the initial ledger creation across concurrent deploys.
    await client.query("SELECT pg_advisory_xact_lock(739125408)");
    await client.query("CREATE SCHEMA IF NOT EXISTS subscription_meta");
    await client.query(
      "CREATE TABLE IF NOT EXISTS subscription_meta.migrations(name text PRIMARY KEY, checksum text NOT NULL)",
    );
    await client.query(
      "ALTER TABLE subscription_meta.migrations ADD COLUMN IF NOT EXISTS checksum text",
    );
    const applied = await client.query<{ name: string; checksum: string | null }>(
      "SELECT name,checksum FROM subscription_meta.migrations ORDER BY name",
    );
    for (const row of applied.rows) {
      if (!row.checksum) throw new Error("Unverified migration history: " + row.name);
      if (files.find((file) => file.name === row.name)?.checksum !== row.checksum)
        throw new Error("Migration drift: " + row.name);
    }
    const last = applied.rows.at(-1)?.name;
    for (const file of files) {
      if (!applied.rows.some((row) => row.name === file.name)) {
        if (last && file.name <= last)
          throw new Error("Migration must append to history: " + file.name);
        await client.query(file.sql);
        await client.query(
          "INSERT INTO subscription_meta.migrations(name,checksum) VALUES($1,$2)",
          [file.name, file.checksum],
        );
      }
    }
    await client.query("COMMIT");
    console.log("Migration history verified; schema ready");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error("Set DATABASE_URL explicitly for migrations");
  await migrate(connection);
}
