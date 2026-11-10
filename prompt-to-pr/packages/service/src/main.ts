import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { configuration } from "./config.js";
import { createPool, ensurePrivateSchema } from "./database.js";
import { createIdentity } from "./auth.js";
import { GitHub } from "./github.js";
import { Store } from "./store.js";
import { createHandler } from "./http.js";
import { createExecutor } from "./execution.js";
import { work, publishSaved } from "./worker.js";

const config = configuration();
const pool = createPool(config);
const store = new Store(pool);
const auth = createIdentity(config, pool);
const github = new GitHub(config.GITHUB_APP_ID, config.GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n"));
const role = process.argv[2] ?? "api";
if (role === "migrate") {
  await ensurePrivateSchema(pool, config.DATABASE_SCHEMA);
  await store.migrate();
  await (await getMigrations(auth.identity.options)).runMigrations();
  await ensurePrivateSchema(pool, config.DATABASE_SCHEMA);
  await pool.end();
} else if (role === "recover-publication") {
  const id = process.argv[3];
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Provide a run UUID");
  const worker = randomUUID();
  const run = await store.claimPublication(id, worker);
  const heartbeat = setInterval(() => {
    void store.heartbeat(id, worker).catch(() => {});
  }, 15000);
  try {
    await publishSaved(store, run, worker, auth, github);
    console.log(`Recovered publication for ${id}`);
  } catch {
    await store
      .checkpoint(
        id,
        worker,
        {
          status: "needs_attention",
          error: {
            code: "recovery_failed",
            message: "Publication recovery failed; inspect GitHub before repeating",
          },
        },
        "Publication recovery stopped",
      )
      .catch(() => {});
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    await pool.end();
  }
} else if (role === "worker") {
  if (!config.E2B_API_KEY || !config.E2B_OPENAI_SECRET || !config.E2B_TEMPLATE)
    throw new Error("Worker requires E2B credentials, template, and model secret name");
  const stop = new AbortController();
  process.on("SIGTERM", () => stop.abort());
  process.on("SIGINT", () => stop.abort());
  await work(
    store,
    auth,
    github,
    createExecutor({
      apiKey: config.E2B_API_KEY,
      template: config.E2B_TEMPLATE,
      openaiSecretName: config.E2B_OPENAI_SECRET,
    }),
    config.AGENT_MODEL,
    stop.signal,
  );
  await pool.end();
} else if (role === "api") {
  const handler = createHandler(store, auth, github, config);
  const root = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url ?? "/", config.PUBLIC_URL);
      if (!url.pathname.startsWith("/api/")) {
        const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
        if (path !== resolve(root) && !path.startsWith(resolve(root) + sep)) {
          outgoing.writeHead(404).end();
          return;
        }
        let file = path;
        let contents;
        try {
          contents = await readFile(file);
        } catch {
          file = resolve(root, "index.html");
          contents = await readFile(file);
        }
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        };
        outgoing
          .writeHead(200, {
            "content-type": types[extname(file)] ?? "application/octet-stream",
            "x-content-type-options": "nosniff",
            "referrer-policy": "same-origin",
            "content-security-policy":
              "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://avatars.githubusercontent.com; frame-ancestors 'none'; base-uri 'self'",
          })
          .end(contents);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 64 * 1024) {
          outgoing.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const request = new Request(url, {
        method: incoming.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const response = await handler(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") outgoing.setHeader(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.setHeader("cache-control", "no-store");
      outgoing.setHeader("x-content-type-options", "nosniff");
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500).end("Request failed");
    }
  });
  server.listen(config.PORT, "0.0.0.0", () =>
    console.log(`Prompt to PR listening on port ${config.PORT}`),
  );
  const close = () =>
    server.close(() => {
      void pool.end();
    });
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
} else throw new Error("Expected api, worker, or migrate");
