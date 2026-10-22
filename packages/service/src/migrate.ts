import pg from "pg";
import { readConfig } from "./config.js";
import { createGithub } from "./github.js";
import { createBetterAuth } from "./better-auth.js";
import { createDatabasePoolConfig, prepareDatabase } from "./database.js";

const config = await readConfig();
const github = config.github ? createGithub(config.github) : undefined;
const pool = new pg.Pool(
  await createDatabasePoolConfig({
    databaseUrl: config.databaseUrl,
    mode: config.mode,
    ca: config.databaseCa,
    caFile: config.databaseCaFile,
  }),
);
try {
  const connection = await pool.connect();
  connection.release();
  const identity =
    config.mode === "live" && config.github && github
      ? createBetterAuth({ ...config, github: config.github }, pool, github)
      : undefined;
  await prepareDatabase(pool, config.mode, undefined, identity?.migrate);
  console.log("Database migrations completed.");
} finally {
  await pool.end();
}
