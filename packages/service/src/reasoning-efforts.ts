import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { reasoningEffort } from "@herbie/contracts";

const page = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort })),
    }),
  ),
  nextCursor: z.string().nullable(),
});
type Catalog = z.infer<typeof page>["data"];

// Read capabilities from the same pinned Codex version used by sandbox agents.
// This starts no thread and performs no inference.
export async function readReasoningCatalog(): Promise<Catalog> {
  const root = dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json"));
  const home = await mkdtemp(join(tmpdir(), "herbie-catalog-"));
  try {
    return await new Promise<Catalog>((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, "bin/codex.js"), "app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
        env: { ...process.env, CODEX_HOME: home },
      });
      const lines = createInterface({ input: child.stdout });
      const catalog: Catalog = [];
      let settled = false;
      const timer = setTimeout(() => finish(new Error("Reasoning discovery timed out")), 10_000);
      function finish(error?: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        child.once("close", () => {
          if (error) reject(error);
          else resolve(catalog);
        });
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGTERM");
        } catch {
          // The owned process group may already have exited.
        }
      }
      const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
      child.on("error", () => finish(new Error("Reasoning discovery failed")));
      child.stdin.on("error", () => finish(new Error("Reasoning discovery failed")));
      child.on("exit", () => finish(new Error("Reasoning discovery exited")));
      lines.on("line", (line) => {
        try {
          const response = z
            .object({
              id: z.number().optional(),
              result: z.unknown().optional(),
              error: z.unknown().optional(),
            })
            .parse(JSON.parse(line));
          if (response.id === undefined) return;
          if (response.error) throw new Error();
          if (response.id === 0) {
            send({ method: "initialized" });
            send({ id: 1, method: "model/list", params: { includeHidden: true } });
          } else if (response.id === 1) {
            const result = page.parse(response.result);
            catalog.push(...result.data);
            if (result.nextCursor)
              send({
                id: 1,
                method: "model/list",
                params: { cursor: result.nextCursor, includeHidden: true },
              });
            else finish();
          }
        } catch {
          finish(new Error("Invalid reasoning discovery response"));
        }
      });
      send({
        id: 0,
        method: "initialize",
        params: { clientInfo: { name: "herbie-catalog", version: "0.1.0" } },
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export function createReasoningEffortLister(read = readReasoningCatalog) {
  let cached: { catalog: Catalog; expires: number } | undefined;
  let pending: Promise<Catalog> | undefined;
  return async (model: string): Promise<string[]> => {
    if (!cached || cached.expires <= Date.now()) {
      pending ??= read()
        .then((catalog) => {
          cached = { catalog, expires: Date.now() + 5 * 60_000 };
          return catalog;
        })
        .finally(() => {
          pending = undefined;
        });
      await pending;
    }
    return (
      cached!.catalog
        .find((entry) => entry.model === model)
        ?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort) ?? []
    );
  };
}
