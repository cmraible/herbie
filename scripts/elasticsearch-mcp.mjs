#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Elastic v0.3.1, including its dependency lockfile. Bump the adapter version
// whenever the local proxy adaptation changes so cached builds are invalidated.
const revision = "f5fb6e22719cc2de1cde37f31ecfe24471cf1852";
const adapterVersion = "1";
const cacheRoot = join(
  process.env.XDG_CACHE_HOME || join(tmpdir(), `herbie-${process.getuid?.() ?? "user"}`),
  "herbie",
  "elasticsearch-mcp",
);
const installation = join(cacheRoot, `${revision}-${adapterVersion}`);
const entrypoint = join(installation, "dist", "index.js");
const env = { ...process.env };
// This local tool has no telemetry collector unless explicitly configured.
env.OTEL_SDK_DISABLED ??= "true";
// Node extends its normal roots with this CA; never disable TLS verification.
if (!env.NODE_EXTRA_CA_CERTS && env.CODEX_PROXY_CERT)
  env.NODE_EXTRA_CA_CERTS = env.CODEX_PROXY_CERT;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: ["ignore", 2, 2] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

try {
  if (!env.ES_URL || !env.ES_API_KEY) throw new Error("ES_URL and ES_API_KEY must be configured");
  if (!existsSync(entrypoint)) {
    mkdirSync(cacheRoot, { recursive: true });
    const temporary = mkdtempSync(join(cacheRoot, ".install-"));
    try {
      console.error("Preparing pinned Elasticsearch MCP server (first run only)…");
      run("git", ["init", "--quiet", temporary]);
      run(
        "git",
        [
          "fetch",
          "--quiet",
          "--depth=1",
          "https://github.com/elastic/mcp-server-elasticsearch.git",
          revision,
        ],
        temporary,
      );
      run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], temporary);
      const sourcePath = join(temporary, "index.ts");
      let source = readFileSync(sourcePath, "utf8");
      for (const [before, after] of [
        ["  Client,", "  Client,\n  HttpConnection,"],
        [
          "    node: url,",
          "    node: url,\n    Connection: HttpConnection,\n    proxy: process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy,",
        ],
      ]) {
        if (source.split(before).length !== 2)
          throw new Error("Pinned source no longer matches the proxy adapter");
        source = source.replace(before, after);
      }
      writeFileSync(sourcePath, source);
      run(
        "npm",
        [
          "ci",
          "--cache",
          join(cacheRoot, "npm"),
          "--include=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--loglevel=error",
        ],
        temporary,
      );
      run("npm", ["run", "build"], temporary);
      // Publish only complete builds. A simultaneous launcher may win this race.
      try {
        renameSync(temporary, installation);
      } catch (error) {
        if (!existsSync(entrypoint)) throw error;
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const child = spawn(process.execPath, [entrypoint, "stdio"], { env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
} catch (error) {
  console.error(`Elasticsearch MCP startup failed: ${error.message}`);
  process.exitCode = 1;
}
