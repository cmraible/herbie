// Coverage-only Node transport around the real Worker fetch handler.
// Normal acceptance runs still use workerd; this is not Cloudflare runtime coverage.
import { test, expect } from "vitest";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { spawn } from "node:child_process";
import worker from "../../src/worker";
import { testEnv } from "../../scripts/test-env";

test("measure the public HTTP acceptance suite against the real Worker handler and PostgreSQL", async () => {
  const root = resolve("dist/client");
  const env = {
    ...testEnv(),
    ASSETS: {
      async fetch(request: Request) {
        let file = resolve(root, "." + decodeURIComponent(new URL(request.url).pathname));
        if (file !== root && !file.startsWith(root + sep)) return new Response("", { status: 404 });
        if (!extname(file)) file = resolve(root, "index.html");
        const mime: Record<string, string> = {
          ".js": "text/javascript",
          ".css": "text/css",
          ".html": "text/html",
        };
        try {
          return new Response(new Uint8Array(await readFile(file)), {
            headers: { "Content-Type": mime[extname(file)] ?? "application/octet-stream" },
          });
        } catch {
          return new Response("", { status: 404 });
        }
      },
    },
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        if (!Buffer.isBuffer(chunk)) throw new Error("Invalid request body");
        chunks.push(chunk);
      }
      const method = incoming.method ?? "GET";
      const request = new Request(env.APP_ORIGIN + (incoming.url ?? "/"), {
        method,
        headers,
        ...(["GET", "HEAD"].includes(method)
          ? {}
          : { body: new Uint8Array(Buffer.concat(chunks)) }),
      });
      const response = await worker.fetch(request, env);
      outgoing.statusCode = response.status;
      for (const [name, value] of response.headers)
        if (name !== "set-cookie") outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      outgoing.statusCode = 500;
      outgoing.end("Coverage transport failed");
    });
  });
  await new Promise<void>((done, failed) => {
    server.once("error", failed);
    server.listen(8790, "127.0.0.1", done);
  });
  try {
    const code = await new Promise<number | null>((done, failed) => {
      const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test"], {
        stdio: "inherit",
        env: { ...process.env, COVERAGE_HTTP_SERVER: "true" },
      });
      child.once("error", failed);
      child.once("exit", done);
    });
    expect(code).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 240000);
