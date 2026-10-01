# Subscription template

An extractable pnpm package for a subscription product on Cloudflare Workers, Supabase Postgres, Better Auth and Stripe. See [USE_CASES.md](USE_CASES.md) for the incremental scope and evidence; unfinished slices are explicitly marked.

## Local development

Node 24 and pnpm 10.34.6. From the monorepo root run `pnpm install --frozen-lockfile`. All commands below run in this package.

1. Start local-only infrastructure: `pnpm exec tsx scripts/local-services.ts`. This starts PGlite (Postgres engine with a pg-compatible wire server) and a loopback test email inbox. It is a fallback for environments where Docker/Supabase cannot start, not a substitute claim for hosted Supabase testing.
2. Run `pnpm test:prepare`, then `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres pnpm db:migrate`. The prepare command writes ignored, public local-only fixtures to `.dev.vars`. Never deploy those fixtures.
3. Run `pnpm build` and `pnpm dev`; open http://localhost:8790. Email links are available through the test inbox at `http://127.0.0.1:8791/emails?to=YOUR_EMAIL`.
4. Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, and `pnpm test:e2e`. Install Playwright Chromium with `pnpm exec playwright install chromium`; this workspace uses `CHROMIUM_PATH=/usr/bin/chromium` instead.

Better Auth owns authentication and sessions. Supabase is the database provider only. Application/auth tables use private schemas, never the Supabase `auth` schema or a browser service-role key. Production email uses an HTTPS sending adapter compatible with Resend; set the API key and sender through server secrets. Google/GitHub OAuth and partner-approved ChatGPT OIDC require separately supplied credentials and callback registration; none were generated or configured here.

## Extraction

Copy this directory into a standalone repository, run `pnpm install` to produce its own lockfile, and retain its packageManager/Node version. The monorepo root already includes `packages/*`; no root script migration is needed. This package has no runtime imports from other Herbie packages. New dependencies extend the shared lockfile. pnpm resolves the existing Better Auth package with additional optional pg/Vitest peers; its version is unchanged. Existing agent-factory checks are included in regression verification. No root workspace setting changes are required.

No deployment is performed by the package build command. It bundles static assets and dry-runs Wrangler. Live deployment and provider smoke checks need isolated resources and approved server-side secrets; KaizenKit and agent-factory must remain untouched.
