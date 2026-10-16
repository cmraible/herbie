import { serveConfigurationError } from "./configuration-page.js";
import { logFailure } from "./diagnostic-log.js";
import { createRuntime } from "./runtime.js";
import { createModelLister } from "./models.js";
import { createApiServer } from "./http.js";

try {
  const { config, store, auth, adapters, github } = await createRuntime();
  const server = createApiServer({
    listModels: config.openaiApiKey ? createModelLister(config.openaiApiKey) : undefined,
    store,
    auth,
    adapters,
    publicUrl: config.publicUrl,
    verifyWebhook: github?.verifyWebhook,
    executionEnabled: config.executionEnabled,
    deploymentId: config.deploymentId,
    imageRevision: config.imageRevision,
  });
  server.listen(config.port, config.host, () =>
    console.log(`Herbie ${config.mode} API and web: ${config.publicUrl}`),
  );
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    server.close(() => {
      void store.close().catch((error) => {
        logFailure(error, { component: "shutdown" });
        process.exitCode = 1;
      });
    });
    server.closeIdleConnections();
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  try {
    if (!(await serveConfigurationError(error))) {
      logFailure(error, { component: "index-entrypoint" });
      process.exitCode = 1;
    }
  } catch (error) {
    logFailure(error, { component: "configuration-listener" });
    process.exitCode = 1;
  }
}
