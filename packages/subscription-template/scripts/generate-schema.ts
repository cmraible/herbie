import { getMigrations } from "better-auth/db/migration";
import { writeFile, mkdir } from "node:fs/promises";
import { database } from "../src/database";
import { authOptions } from "../src/auth";
const pool = database(
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55432/postgres",
);
try {
  const options = authOptions(
    {
      APP_ORIGIN: "http://localhost:8790",
      DATABASE_URL: "unused",
      BETTER_AUTH_SECRET: "local-schema-generator-not-a-real-secret",
    },
    pool,
  );
  const migrations = await getMigrations(options);
  await mkdir("supabase/migrations", { recursive: true });
  await writeFile(
    "supabase/migrations/20261001060000_auth.sql",
    await migrations.compileMigrations(),
  );
} finally {
  await pool.end();
}
