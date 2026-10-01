# Subscription template

An extractable pnpm package for a subscription product on Cloudflare Workers, Supabase Postgres, Better Auth and Stripe. [USE_CASES.md](USE_CASES.md) records acceptance criteria; [QUALITY.md](QUALITY.md) records verification, measured coverage and remaining live checks. [DEPLOYMENT.md](DEPLOYMENT.md) describes hosting prerequisites and trust boundaries.

## Local development

Node 24 and pnpm 10.34.6. Run `pnpm install --frozen-lockfile` from the monorepo root; the remaining commands run inside this package.

```sh
pnpm db:start
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55433/postgres
pnpm test:prepare
pnpm db:migrate
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:coverage
pnpm test:coverage:http
pnpm api:generate
```

`db:start` uses a loopback-bound PostgreSQL 17 Docker service. `test:prepare` writes ignored, public test fixtures to `.dev.vars` and refuses a non-loopback database. Playwright starts and stops the Worker and loopback email/Stripe fixtures automatically. For interactive development, run `pnpm exec tsx scripts/email-fixture.ts`, `pnpm exec tsx scripts/stripe-fixture.ts`, and `pnpm dev` in separate terminals. Open http://localhost:8790; read test email links at `http://127.0.0.1:8791/emails?to=YOUR_EMAIL`.

This execution environment could not pull Docker images. Validation instead used native PostgreSQL 18.4 from `@embedded-postgres/linux-x64@18.4.0-beta.17`, initialized in `/tmp`, on port 55433, plus `CHROMIUM_PATH=/usr/bin/chromium`. An earlier PGlite fallback was removed after concurrent sessions exposed wire-protocol failures. CI uses ordinary PostgreSQL 17. Neither local engine is evidence of hosted Supabase verification.

## Identity and permissions

Better Auth is the only identity/session owner. Supabase supplies Postgres only. Private `subscription_auth`, `subscription_billing`, and `subscription_meta` schemas are never exposed through Supabase Data API. No Supabase service-role key reaches the browser. The server database role owns these schemas; public schema/table grants are revoked and RLS has no public policies.

Verified users create workspaces and become their owners. All members can see their workspace and membership list. Administrators invite/remove ordinary members and manage billing. Only the owner grants/revokes administrator roles. The owner cannot be removed or demoted; ownership transfer is deliberately unavailable in this milestone. Invitations are serialized per workspace, bound to a verified recipient, expiring, and consumed once. Resending reuses the pending invitation. Removing membership also cancels outstanding invitations; an inviter whose authority was revoked cannot admit new members.

Passkeys use Better Auth's maintained WebAuthn plugin. TOTP requires enrollment confirmation and challenges subsequent password sign-ins; recovery codes are consumed once. Password reset invalidates other sessions. Provider account linking by email is disabled. Google/GitHub buttons appear only with complete credentials. ChatGPT uses the [official website identity flow](https://developers.openai.com/siwc/website), with registered client ID, discovery/JWKS verification, PKCE, nonce and verified email. Public clients use token authentication `none`; confidential clients use `client_secret_basic`. ChatGPT subjects include issuer/client identity. Callback: `/api/auth/callback/chatgpt`. Registration remains [partner-gated](https://developers.openai.com/siwc/request-client-id); this does not grant OpenAI model API usage.

## Billing and recovery

Checkout uses a server-configured recurring price. Only workspace administrators can start Checkout, open the Portal or refresh billing. A success URL never grants entitlement. Signed Stripe events trigger retrieval of current subscriptions under a database lock; duplicate event IDs commit atomically with state updates. Delayed events cannot overwrite current state with stale payload fields. Paid access requires the configured price and active status with a paid latest invoice, or an explicitly configured trial in Stripe. Past-due/canceled/unpaid states deny access. No tax collection or live payment mode is enabled automatically.

Customer mapping commits before downstream Checkout/Portal operations. Pending Checkout attempts retain stable idempotency keys. Uncertain operations older than 23 hours stop for operator reconciliation rather than relying on Stripe's finite key-retention window. Reconcile the customer/session in Stripe before editing a reservation; never clear an uncertain attempt blindly. Closed sessions can be cleared with **Refresh billing** after canonical state permits resubscription.

Paid access fails closed whenever billing configuration is incomplete, including a missing webhook signing secret; cached entitlement never overrides that policy. Cached billing state is scoped by mode, price and a secret-key fingerprint. Changing any of those fails closed until an operator verifies and migrates the customer mapping; even key rotation requires this explicit reconciliation. Use separate databases/accounts for test and live. An administrator can refresh after a missed webhook; configure provider retries and monitor delivery failures. This milestone does not include a background billing reconciliation scheduler or an operator recovery UI.

## Contracts and verification

`pnpm api:generate` derives product schemas from Zod and auth schemas from installed Better Auth metadata, then validates OpenAPI 3.1 with Swagger Parser. The committed contract is served at `/api/openapi`; CI checks regeneration drift. The auth handler exposes only an explicit route allowlist. Origin checks cover user mutations; the signed Stripe webhook is the exception. HttpOnly cookies, CSP, no-store responses, sanitized errors and disabled Worker request logs protect authentication URLs.

Playwright covers real browser/Worker/Postgres behavior. Email and Stripe are external HTTP fixtures. Stripe fixture tests cover key-based idempotency (including changed-parameter rejection), actual request timeouts after Customer/Checkout creation, and webhook retry after reconciliation failure; they do not model every Stripe behavior or prove live transport. WebAuthn uses a virtual authenticator. The ChatGPT OIDC API scenario signs real JWTs and verifies PKCE/JWKS/nonce against an explicitly mocked external issuer. No test claims that these fixtures validate live provider transport or customer credentials. Google/GitHub tests cover authorization URLs/state and rejected unsolicited callbacks, not real token exchange.

## Extraction

Copy this directory to a standalone repository, retain its Node/packageManager settings and create a local lockfile with `pnpm install`. It has no runtime imports from other Herbie packages. Copy/adapt the three `subscription-template*.yml` workflows, replacing monorepo filters/paths as needed. New dependencies extend the shared lockfile; pnpm adds optional pg/Vitest peer contexts to the existing Better Auth version. Agent-factory regressions are checked separately; its source and hosting are untouched.
