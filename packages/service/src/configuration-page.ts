import { createServer } from "node:http";
import { ConfigurationError } from "./config.js";
import { StartupConfigurationError } from "./startup-diagnostic.js";

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function configurationIssues(error: unknown): ConfigurationError["issues"] | undefined {
  if (error instanceof ConfigurationError) return error.issues;
  if (error instanceof StartupConfigurationError)
    return (
      configurationIssues(error.cause) ?? [
        {
          variable: "Startup configuration",
          message:
            "Check the database URL, CA certificate, and GitHub private key. Configuration could not be initialized.",
        },
      ]
    );
  return undefined;
}

export function configurationPage(issues: ConfigurationError["issues"]) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configuration error · Herbie</title>
<style>:root{font-family:system-ui,sans-serif;color:#20242b;background:#f6f7f9}body{margin:0;border-top:8px solid #b42318}main{max-width:960px;margin:64px auto;padding:0 24px}h1{font-size:36px;letter-spacing:-1px}p{line-height:1.6}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;padding:16px;border:1px solid #d8dce2;overflow-wrap:anywhere}code{font-family:ui-monospace,monospace}small{color:#626b78}</style></head>
<body><main><small>HERBIE · DEVELOPMENT</small><h1>Invalid environment configuration</h1><p>Herbie could not start. Fix the following ${issues.length === 1 ? "setting" : "settings"} in <code>.env</code> or your shell environment, then restart the service and reload this page.</p>
<table><thead><tr><th>Environment variable</th><th>How to fix it</th></tr></thead><tbody>${issues.map((issue) => `<tr><td><code>${escape(issue.variable)}</code></td><td>${escape(issue.message)}</td></tr>`).join("")}</tbody></table>
<p>See <code>.env.example</code> for configuration examples. Environment values are hidden.</p><small>The application and worker have not started. This diagnostic server is available only in development on loopback.</small></main></body></html>`;
}

export async function serveConfigurationError(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if ((environment.NODE_ENV ?? "development") !== "development") return false;
  const issues = configurationIssues(error);
  if (!issues) return false;
  const requestedPort = Number(environment.HERBIE_PORT ?? 8787);
  const port =
    Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
      ? requestedPort
      : 8787;
  const host = ["localhost", "127.0.0.1", "::1"].includes(environment.HERBIE_HOST ?? "")
    ? environment.HERBIE_HOST!
    : "127.0.0.1";
  const page = configurationPage(issues);
  const server = createServer((_request, response) => {
    response.writeHead(503, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    });
    response.end(page);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const close = () => {
    server.close();
    server.closeIdleConnections();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  console.error(
    `Herbie configuration error: http://${host === "::1" ? "[::1]" : host}:${port}. Fix the environment and restart.`,
  );
  return server;
}
