import { readFile } from "node:fs/promises";
import { createE2BTemplateResolver } from "./e2b-templates.js";

// Export all distinct project resource/setup combinations from the deployment.
// Do not reconstruct project setup scripts from an old filesystem snapshot.
const [manifest] = process.argv.slice(2);
if (!manifest || !process.env.E2B_API_KEY)
  throw new Error(
    "Usage: E2B_API_KEY=... pnpm --filter @herbie/loop regenerate:e2b <manifest.json>",
  );
const entries: unknown = JSON.parse(await readFile(manifest, "utf8"));
if (!Array.isArray(entries) || entries.length === 0)
  throw new Error(
    "Manifest must be a nonempty array of { cpu, memory, disk, setupScript?, template? }.",
  );
// Validate the entire manifest before starting any paid builds.
for (const entry of entries) {
  if (
    !entry ||
    ![entry.cpu, entry.memory, entry.disk].every(
      (size) => Number.isSafeInteger(size) && size > 0 && Number.isSafeInteger(size * 1024),
    ) ||
    (entry.setupScript !== undefined && typeof entry.setupScript !== "string") ||
    (entry.template !== undefined && (typeof entry.template !== "string" || !entry.template.trim()))
  )
    throw new Error("Invalid E2B regeneration manifest entry.");
}
for (const entry of entries) {
  const resolve = createE2BTemplateResolver({
    apiKey: process.env.E2B_API_KEY,
    template: entry.template,
  });
  const name = await resolve(
    { cpu: entry.cpu, memory: entry.memory, disk: entry.disk },
    undefined,
    entry.setupScript ?? "",
  );
  console.log(JSON.stringify({ name, status: "ready" }));
}
