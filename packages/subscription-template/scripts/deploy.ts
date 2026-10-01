// Trusted deployment control plane. Never execute scripts or package manifests from a PR artifact.
import { z } from "zod";
import { mkdtemp, writeFile, rm, appendFile, readdir, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { migrate } from "./migrate";
import {
  management,
  reviewDatabase,
  target,
  assertCurrentTarget,
  productionDatabase,
} from "./hosting";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error("Missing deployment setting: " + name);
  return value;
}
async function safeTree(path: string) {
  for (const entry of await readdir(path)) {
    const item = join(path, entry),
      stat = await lstat(item);
    if (stat.isSymbolicLink()) throw new Error("Artifact symlinks are forbidden");
    if (stat.isDirectory()) await safeTree(item);
  }
}
async function run(args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "wrangler", ...args], { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Wrangler deployment failed")),
    );
  });
}
async function deploy() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "workflow_run")
    throw new Error("Deployment requires the trusted workflow_run pipeline");
  const pr = process.env.PR_NUMBER || undefined,
    name = target(pr),
    review = pr !== undefined;
  if (required(review ? "PREVIEW_ENABLED" : "PRODUCTION_ENABLED") !== "true")
    throw new Error("Hosting environment is not enabled");
  const account = z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(required("CLOUDFLARE_ACCOUNT_ID"));
  const cfToken = required("CLOUDFLARE_API_TOKEN"),
    emailKey = required("EMAIL_API_KEY"),
    emailFrom = required("EMAIL_FROM");
  const seed = z.string().min(32).parse(required("BETTER_AUTH_SECRET"));
  const artifact = await realpath(required("ARTIFACT_DIR"));
  await safeTree(artifact);
  const main = join(artifact, "dist/worker/worker.js"),
    assets = join(artifact, "dist/client"),
    migrations = join(artifact, "supabase/migrations");
  await Promise.all([lstat(main), lstat(assets), lstat(migrations)]);
  await assertCurrentTarget(
    async (path) => {
      const response = await fetch("https://api.github.com" + path, {
        headers: {
          Authorization: "Bearer " + required("GITHUB_TOKEN"),
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error("Cannot verify current deployment target");
      return response.json();
    },
    z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .parse(required("GITHUB_REPOSITORY")),
    z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(required("VALIDATED_SHA")),
    pr,
  );
  let connection: string;
  if (review) {
    const parent = z
      .string()
      .regex(/^[a-z0-9]{20}$/)
      .parse(required("SUPABASE_PREVIEW_PROJECT_REF"));
    if (parent === required("SUPABASE_PRODUCTION_PROJECT_REF"))
      throw new Error("Review project must be separate from production");
    connection = await reviewDatabase(management(required("SUPABASE_ACCESS_TOKEN")), parent, name);
  } else
    connection = productionDatabase(
      required("DATABASE_URL"),
      required("SUPABASE_PRODUCTION_PROJECT_REF"),
    );
  const subdomainResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`,
    { headers: { Authorization: "Bearer " + cfToken }, signal: AbortSignal.timeout(30000) },
  );
  const subdomain = z
    .object({
      success: z.literal(true),
      result: z.object({ subdomain: z.string().regex(/^[a-z0-9-]+$/) }),
    })
    .parse(await subdomainResponse.json()).result.subdomain;
  const origin = `https://${name}.${subdomain}.workers.dev`;
  const secrets: Record<string, string> = {
    DATABASE_URL: connection,
    BETTER_AUTH_SECRET: review ? createHmac("sha256", seed).update(name).digest("hex") : seed,
    EMAIL_API_KEY: emailKey,
  };
  const vars: Record<string, string> = { APP_ORIGIN: origin, EMAIL_FROM: emailFrom };
  if (process.env.EMAIL_API_URL) vars.EMAIL_API_URL = process.env.EMAIL_API_URL;
  if (!review) {
    for (const key of [
      "GOOGLE_CLIENT_SECRET",
      "GITHUB_CLIENT_SECRET",
      "OPENAI_CLIENT_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ])
      if (process.env[key]) secrets[key] = required(key);
    for (const key of [
      "GOOGLE_CLIENT_ID",
      "GITHUB_CLIENT_ID",
      "OPENAI_CLIENT_ID",
      "STRIPE_PRICE_ID",
      "BILLING_MODE",
    ])
      if (process.env[key]) vars[key] = required(key);
  }
  // Migrations receive only the isolated DB connection, never provider master tokens.
  await migrate(connection, migrations);
  const temporary = await mkdtemp(join(tmpdir(), "subscription-deploy-"));
  try {
    const config = join(temporary, "wrangler.json"),
      secretFile = join(temporary, "secrets.json");
    await writeFile(
      config,
      JSON.stringify({
        name,
        main,
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: true,
        preview_urls: false,
        assets: { directory: assets, binding: "ASSETS", run_worker_first: true },
        observability: { enabled: false },
        vars,
      }),
      { mode: 0o600 },
    );
    await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600 });
    await run(["deploy", "--no-bundle", "--config", config, "--secrets-file", secretFile], {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      COREPACK_HOME: process.env.COREPACK_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_API_TOKEN: cfToken,
      CI: "true",
    });
    const response = await fetch(origin + "/ready", { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("Hosted health check failed");
    z.object({ ok: z.literal(true) }).parse(await response.json());
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `Deployed ${origin}\n\nProvider sign-in, email and billing still require configured smoke tests.\n`,
      );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
void deploy().catch(() => {
  console.error(
    "Subscription deployment failed. Inspect the last completed stage; credentials and provider response bodies are intentionally omitted.",
  );
  process.exitCode = 1;
});
