import { readdir, readFile } from "node:fs/promises";
import { database } from "../src/database";
const connection = process.env.DATABASE_URL;
if (!connection) throw new Error("Set DATABASE_URL explicitly for migrations");
const pool = database(connection);
const client = await pool.connect();
try {
  await client.query("CREATE SCHEMA IF NOT EXISTS subscription_meta");
  await client.query(
    "CREATE TABLE IF NOT EXISTS subscription_meta.migrations(name text PRIMARY KEY)",
  );
  for (const file of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await client.query("BEGIN");
    try {
      await client.query("LOCK TABLE subscription_meta.migrations IN EXCLUSIVE MODE");
      const applied = await client.query<{ name: string }>(
        "SELECT name FROM subscription_meta.migrations WHERE name=$1",
        [file],
      );
      if (!applied.rowCount) {
        await client.query(await readFile("supabase/migrations/" + file, "utf8"));
        await client.query("INSERT INTO subscription_meta.migrations VALUES($1)", [file]);
      }
      await client.query("COMMIT");
      console.log("Migration ready: " + file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}
