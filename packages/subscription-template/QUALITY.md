# Verification and remaining setup

The reviewable package is `packages/subscription-template` on `feat/subscription-template`, [draft PR #1](https://github.com/cmraible/herbie/pull/1). No merge, live payment, credential creation or hosted template provisioning was performed.

## Acceptance evidence

| Area             | Verified locally and in automated checks                                                                                                                                                                                                                                                                                                  | Still requires live setup                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Accounts         | Verified-email signup, rejected unverified access, sign-in/out, old-cookie rejection, reset token consumption and session revocation                                                                                                                                                                                                      | Verified sender and real delivery                                                             |
| Team permissions | Owner/admin/member isolation; invite recipient binding; once-only concurrent acceptance; inviter demotion racing admission; owner protection; removed membership and stale invitations                                                                                                                                                    | Hosted database connectivity and operational monitoring                                       |
| Account security | Virtual passkey registration/login/removal and cross-account deletion rejection; TOTP enrollment/challenge, replacement invalidates old codes, credential-gated disable rotates the session and clears obsolete codes                                                                                                                     | Physical authenticator/device and production HTTPS smoke test                                 |
| OAuth            | Google/GitHub authorization state and unsolicited-callback rejection; ChatGPT signed OIDC fixture with PKCE, nonce, JWKS, ID-token-only response and rejected replay/invalid tokens                                                                                                                                                       | Registered provider clients and real exchanges; ChatGPT approved client registration          |
| Billing          | Admin-only Checkout/Portal; success URL cannot grant access; signature/replay checks; canonical state despite delayed events; failed-payment/cancellation denial; retry after failed reconciliation; same-key recovery after actual provider-response timeouts; expired Checkout refresh; uncertain reservation older than 23 hours stops | Stripe sandbox keys, price, Portal, signed webhook delivery and real checkout/payment methods |
| API              | Zod inputs/outputs; generated validated OpenAPI; documented Origin/signature headers; unsupported method/path rejection; malformed/extra input cannot mutate workspaces; auth middleware and provider error envelopes both documented                                                                                                     | Contract validation against deployed origin                                                   |
| Database         | Real PostgreSQL transactions/concurrent sessions; immutable migration checksums; replay, edited/legacy history rejection and failed-batch rollback                                                                                                                                                                                        | Dedicated Supabase project and verified TLS destination                                       |
| Delivery         | Trusted control-plane scripts; current-head/closed/reopened/default-branch guards; cleanup remains enabled when preview creation stops; queue retention; DB readiness and destination tests; fixture creation-response loss, missing credentials, partial cleanup retry and returned branch identity                                      | Preview create/deploy/delete and main deployment against authorized resources                 |
| UI               | Real Chromium desktop 1280px and mobile 390px; keyboard submission/focus; blocked repeated actions; resolved errors clear; controls fit viewport                                                                                                                                                                                          | Broader device/browser/accessibility audit                                                    |

Email, Stripe and identity providers are explicit external seams. Stripe's fixture models key/fingerprint idempotency and lost responses, not every service behavior or key expiry. The 24-hour stale reservation check advances the clock in a directly imported Worker handler. The Google/GitHub tests do not execute token exchange. Migration, readiness, OIDC and selected configuration tests also call portable code directly; the remaining browser/API cases use workerd and real PostgreSQL. These distinctions matter when interpreting the test count.

Screenshots from the passing workerd run: [390px mobile](docs/evidence/mobile-390.png), [1280px desktop](docs/evidence/desktop-1280.png). Both were visually inspected.

## Measured coverage

Final local verification: **29/29 acceptance scenarios pass with workerd and native PostgreSQL 18.4**. The separate Node coverage run repeats all 29 successfully; Vitest reports 21 passing tests (20 unit tests plus the acceptance wrapper). Typecheck, Oxlint, Oxfmt, OpenAPI generation/validation and Vite/Wrangler dry-run build pass.

| Measurement                 | Statements           | Branches             |
| --------------------------- | -------------------- | -------------------- |
| Unit tests alone            | 15.56% (118/758)     | 24.20% (114/471)     |
| Unit + Node HTTP acceptance | **52.63% (399/758)** | **67.51% (318/471)** |
| Billing module              | 93.02%               | 88.33%               |
| Team module                 | 93.54%               | 87.87%               |
| Worker entrypoint           | 93.84%               | 86.95%               |
| Auth configuration          | 68.75%               | 65.38%               |

The measurement scope now also includes `scripts/cleanup.ts`; the previous 727-statement denominator was smaller.

Combined line coverage is 53.97% (367/680); function coverage is 47.86% (56/117). These are the complete configured denominator, not a selectively reported server-only percentage. Hosted CI runs the same checks with PostgreSQL 17.

`pnpm test:coverage` measures unit tests. `pnpm test:coverage:http` repeats the acceptance suite with the real Worker fetch handler served by a Node HTTP transport, allowing V8 instrumentation. This is **not workerd runtime coverage**. Normal `pnpm test:e2e` independently uses workerd. CI retains separate `playwright-report` and `playwright-report-http` directories, including desktop/mobile screenshots, plus both coverage reports.

The denominator includes every `src/**/*.ts` file and `scripts/hosting.ts`, `scripts/migrate.ts` and `scripts/cleanup.ts`. Browser `client.ts` and migration execution occur outside the instrumented Node process and therefore remain **0% in the report**, despite their acceptance tests. Direct imports inside Playwright child processes are likewise uncollected. Dependencies, generated OpenAPI/SQL, fixtures, the deployment CLI, and other build scripts are excluded. No repository-wide or live-provider coverage claim is made. Coverage is an observed baseline, not an arbitrary passing threshold.

## Instrumentation gaps versus untested behavior

Browser code, migration execution and directly imported auth/readiness scenarios run outside V8's instrumented process; their zeros do not mean those use cases lack tests. `auth.ts`'s ChatGPT registration path is exercised by the signed OIDC fixture in a child process. Cleanup is now included in the measured source set because its real exported entrypoint runs with external HTTP provider fixtures; the CLI exit wrapper itself is not a live lifecycle test.

Genuine remaining gaps include live provider transport, physical passkey compatibility, cold-start/remote network behavior, complete email-outage recovery, natural session/invitation expiry and sustained rate-limit behavior, and PostgreSQL connection loss at every transaction boundary. Production deployment (artifact handling, Wrangler upload and post-upload probe together) is not exercised end-to-end against providers. Coverage is not a release-readiness or exhaustive failure-path claim. The focused additions target account security, authority, provider identity, partial cleanup and payment entitlement boundaries; no percentage target drives scope.

## Dependencies and fresh-checkout reproduction

On 2026-10-01, `pnpm audit --prod --json` and `pnpm audit --json` reported zero known advisories across the monorepo (346 and 522 reported dependency entries). Saved outputs: [production](docs/evidence/dependency-audit-production.json), [all](docs/evidence/dependency-audit-all.json). This is a point-in-time registry audit, not a guarantee about undisclosed defects.

A detached checkout of `c106aa1` at `/tmp/herbie-reproduction-c106aa1`, without existing `node_modules` or application credentials, passed `pnpm install --frozen-lockfile --offline --store-dir /tmp/herbie-store`, package typecheck, lint, all then-current unit tests and Vite/Wrangler dry-run build. Installation used the package cache but no preexisting installed tree; no tracked files changed. pnpm reported skipped dependency build scripts under its existing policy, and the build still passed with packaged platform binaries. This quality pass adds no dependencies or lockfile changes. Final GitHub CI independently installs from the frozen lockfile on a clean runner, then runs the expanded acceptance suite against PostgreSQL 17.

## Regressions found and fixed

- Disabling TOTP left obsolete replacement recovery codes visible; the flow now clears the setup URI and codes. A real browser regression first failed on the visible codes and now passes with session rotation and password-only login after disable.
- Auth OpenAPI errors omitted the coordinator’s `{error}` envelope; the generated schemas now allow both it and Better Auth’s `{message}` errors, and declare required Origin headers.
- A branch-create response with a different review name was not rejected before credential polling; exact returned-name validation now fences that mismatch.
- Repeated pending form submissions were possible; actions now disable their controls and suppress duplicate submission. The test first failed on the enabled pending button and now checks one persisted workspace.
- Narrow layouts overflowed; controls and table content now fit 390px and keyboard focus remains usable at both tested widths.
- Public GET endpoints accepted POST and team routes accepted extra path aliases; explicit method/resource checks now reject them. Required mutation/signature headers are also generated in OpenAPI.
- Preview cleanup used the creation enablement gate and default queue replacement could lose cleanup; cleanup is independent and both lifecycle jobs retain queued work.
- Migration filenames alone did not prove immutable history; checksums and atomic pending batches now enforce it. Production deployment also validates the exact Supabase destination/TLS settings and checks database readiness.
- The coverage rerun originally replaced the real Worker browser report; each transport now writes separate reports and screenshots.

One local full-suite attempt was interrupted by regeneration/build while workerd was serving a timeout test (503 instead of the expected handled 500). The final verification holds source/build files stable during acceptance runs. This harness interruption was not hidden with test retries. A separate password-reset replay test raced its navigation against the pending sign-out redirect; it now awaits the visible signed-out screen before opening the consumed link.

## Review

### Standards

The standards reviewer found no material documented-standard violation or noteworthy heuristic smell. It found one P2 evidence issue: the coverage Playwright rerun overwrote the workerd report. Separate output/report directories resolve that finding. A second pass found a P3 polling-test assertion tied to an exact call count. It now verifies timeout and HTTP GET-only behavior at the provider boundary. Current `queue: max` support was verified against GitHub's official documentation.

### Spec

The spec reviewer found no new actionable correctness/security finding in the hardening diff. Deployment guards match the requested scope; live integration limitations remain explicit.

Standards: two findings across both passes, resolved (P2 evidence preservation; P3 test brittleness). Spec: zero new actionable findings.

## Minimal remaining setup

For a hosted account/team smoke test: approve an isolated Supabase project and cost, provide its project reference and server Postgres URL with `sslmode=verify-full`, a Cloudflare account/token, a strong Better Auth secret, and a verified restricted email sender/key through protected GitHub environments. OAuth and test billing can stay disabled until their separate credentials are supplied. Preview lifecycle additionally needs an empty, separate Supabase preview-parent project and scoped management token. The trusted workflows must exist on `main`, and deployment variables are enabled only after setup. Nothing is automatically merged.

[DEPLOYMENT.md](DEPLOYMENT.md) lists exact secret/variable names, callbacks, Stripe test settings, live smoke checks, and migration compatibility/roll-forward instructions. Provider integrations being connected does not supply runtime credentials or approve paid provisioning. The Supabase organization/cost confirmation is the remaining provisioning decision; no existing unrelated project is reused.
