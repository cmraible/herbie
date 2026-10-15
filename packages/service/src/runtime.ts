import { logFailure } from "./diagnostic-log.js";
import pg from "pg";
import { safeStartupCauses, type StartupProgress } from "./startup-progress.js";
import { StartupConfigurationError, startupDiagnostic } from "./startup-diagnostic.js";
import { readConfig } from "./config.js";
import { Store } from "./store.js";
import { createGoalNamer } from "./goal-name.js";
import { PgAuthStore } from "./auth-store.js";
import { createBetterAuth } from "./better-auth.js";
import { createAuth } from "./auth.js";
import { createGithub } from "./github.js";
import { createLiveAdapters } from "./live.js";
import { createDatabasePoolConfig, prepareDatabase } from "./database.js";

export async function createRuntime(startup?: StartupProgress) {
  startup?.begin("configuration");
  const { config, github, poolConfig } = await (async () => {
    try {
      const config = await readConfig();
      const github = config.github ? createGithub(config.github) : undefined;
      const poolConfig = await createDatabasePoolConfig({
        databaseUrl: config.databaseUrl,
        mode: config.mode,
        ca: config.databaseCa,
        caFile: config.databaseCaFile,
      });
      return { config, github, poolConfig };
    } catch (error) {
      throw new StartupConfigurationError(error);
    }
  })();
  const pool = new pg.Pool(poolConfig);
  pool.on("error", (error) => {
    logFailure(error, { component: "database-pool" });
    console.error(
      `Herbie database pool error: ${startupDiagnostic(error)} causes=${safeStartupCauses(error)}.`,
    );
  });
  const store = new Store(
    pool,
    Math.random,
    config.mode === "live"
      ? createGoalNamer(config.openaiApiKey!, config.goalNameModel)
      : undefined,
  );
  try {
    startup?.begin("database-connect");
    const connection = await pool.connect();
    connection.release();
    const identity =
      config.mode === "live" && config.github && github
        ? createBetterAuth({ ...config, github: config.github }, pool, github)
        : undefined;
    await prepareDatabase(pool, config.mode, (phase) => startup?.begin(phase), identity?.migrate);
    startup?.begin("auth-setup");
    const auth = identity?.auth ?? createAuth(config, new PgAuthStore(pool), github);
    startup?.begin("adapter-setup");
    if (!github) throw new Error("Live runs require GitHub configuration");
    const adapters = createLiveAdapters(
      config.executionEnabled ? config.daytona : undefined,
      github,
      auth,
    );
    return { config, store, auth, adapters, github };
  } catch (error) {
    startup?.failure(error);
    startup?.begin("database-cleanup");
    try {
      await pool.end();
    } catch (error) {
      logFailure(error, { component: "startup-cleanup" });
    }
    throw error;
  }
}
