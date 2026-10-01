# Verification and remaining setup

The reviewable package is `packages/subscription-template` on `feat/subscription-template`, [draft PR #1](https://github.com/cmraible/herbie/pull/1). No merge, live payment, credential creation or hosted template provisioning was performed.

## Acceptance evidence

| Area             | Verified locally and in automated checks                                                                                                                                                                                                                                                                                                  | Still requires live setup                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Accounts         | Verified-email signup, rejected unverified access, sign-in/out, old-cookie rejection, reset token consumption and session revocation                                                                                                                                                                                                      | Verified sender and real delivery                                                             |
| Team permissions | Owner/admin/member isolation; invite recipient binding; once-only concurrent acceptance; inviter demotion racing admission; owner protection; removed membership and stale invitations                                                                                                                                                    | Hosted database connectivity and operational monitoring                                       |
| Account security | Virtual passkey registration/login/removal; TOTP enrollment confirmation and challenge; one-use recovery codes                                                                                                                                                                                                                            | Physical authenticator/device and production HTTPS smoke test                                 |
| OAuth            | Google/GitHub authorization state and unsolicited-callback rejection; ChatGPT signed OIDC fixture with PKCE, nonce, JWKS, ID-token-only response and rejected replay/invalid tokens                                                                                                                                                       | Registered provider clients and real exchanges; ChatGPT approved client registration          |
| Billing          | Admin-only Checkout/Portal; success URL cannot grant access; signature/replay checks; canonical state despite delayed events; failed-payment/cancellation denial; retry after failed reconciliation; same-key recovery after actual provider-response timeouts; expired Checkout refresh; uncertain reservation older than 23 hours stops | Stripe sandbox keys, price, Portal, signed webhook delivery and real checkout/payment methods |
| API              | Zod inputs/outputs; generated validated OpenAPI; documented Origin/signature headers; unsupported method/path rejection                                                                                                                                                                                                                   | Contract validation against deployed origin                                                   |
| Database         | Real PostgreSQL transactions/concurrent sessions; immutable migration checksums; replay, edited/legacy history rejection and failed-batch rollback                                                                                                                                                                                        | Dedicated Supabase project and verified TLS destination                                       |
| Delivery         | Trusted control-plane scripts; current-head/closed/reopened/default-branch guards; cleanup remains enabled when preview creation stops; queue retention; DB readiness and destination tests                                                                                                                                               | Preview create/deploy/delete and main deployment against authorized resources                 |
| UI               | Real Chromium desktop 1280px and mobile 390px; keyboard submission/focus; blocked repeated actions; resolved errors clear; controls fit viewport                                                                                                                                                                                          | Broader device/browser/accessibility audit                                                    |

Email, Stripe and identity providers are explicit external seams. Stripe's fixture models key/fingerprint idempotency and lost responses, not every service behavior or key expiry. The 24-hour stale reservation check advances the clock in a directly imported Worker handler. The Google/GitHub tests do not execute token exchange. Migration, readiness, OIDC and selected configuration tests also call portable code directly; the remaining browser/API cases use workerd and real PostgreSQL. These distinctions matter when interpreting the test count.

Screenshots from the passing workerd run: [390px mobile](docs/evidence/mobile-390.png), [1280px desktop](docs/evidence/desktop-1280.png). Both were visually inspected.

## Measured coverage

Final local verification: **27/27 acceptance scenarios pass with workerd and native PostgreSQL 18.4**. The separate Node coverage run repeats all 27 successfully; Vitest reports 9 passing tests (8 unit tests plus the acceptance wrapper). Typecheck, Oxlint, Oxfmt, OpenAPI generation/validation and Vite/Wrangler dry-run build pass.

| Measurement                 | Statements           | Branches             |
| --------------------------- | -------------------- | -------------------- |
| Unit tests alone            | 3.98% (29/727)       | 7.14% (32/448)       |
| Unit + Node HTTP acceptance | **46.35% (337/727)** | **58.25% (261/448)** |
| Billing module              | 93.02%               | 88.33%               |
| Team module                 | 91.39%               | 84.84%               |
| Worker entrypoint           | 92.30%               | 85.50%               |
| Auth configuration          | 68.75%               | 65.38%               |

Combined line coverage is 48.00% (313/652); function coverage is 43.85% (50/114). These are the complete configured denominator, not a selectively reported server-only percentage. Hosted CI runs the same checks with PostgreSQL 17.

`pnpm test:coverage` measures unit tests. `pnpm test:coverage:http` repeats the acceptance suite with the real Worker fetch handler served by a Node HTTP transport, allowing V8 instrumentation. This is **not workerd runtime coverage**. Normal `pnpm test:e2e` independently uses workerd. CI retains separate `playwright-report` and `playwright-report-http` directories, including desktop/mobile screenshots, plus both coverage reports.

The denominator includes every `src/**/*.ts` file and `scripts/hosting.ts` / `scripts/migrate.ts`. Browser `client.ts` and migration execution occur outside the instrumented Node process and therefore remain **0% in the report**, despite their acceptance tests. Direct imports inside Playwright child processes are likewise uncollected. Dependencies, generated OpenAPI/SQL, fixtures, deploy/cleanup CLI entrypoints, and other build scripts are excluded. No repository-wide or live-provider coverage claim is made. Coverage is an observed baseline, not an arbitrary passing threshold.

## Regressions found and fixed

- Repeated pending form submissions were possible; actions now disable their controls and suppress duplicate submission. The test first failed on the enabled pending button and now checks one persisted workspace.
- Narrow layouts overflowed; controls and table content now fit 390px and keyboard focus remains usable at both tested widths.
- Public GET endpoints accepted POST and team routes accepted extra path aliases; explicit method/resource checks now reject them. Required mutation/signature headers are also generated in OpenAPI.
- Preview cleanup used the creation enablement gate and default queue replacement could lose cleanup; cleanup is independent and both lifecycle jobs retain queued work.
- Migration filenames alone did not prove immutable history; checksums and atomic pending batches now enforce it. Production deployment also validates the exact Supabase destination/TLS settings and checks database readiness.
- The coverage rerun originally replaced the real Worker browser report; each transport now writes separate reports and screenshots.

One local full-suite attempt was interrupted by regeneration/build while workerd was serving a timeout test (503 instead of the expected handled 500). The final verification holds source/build files stable during acceptance runs. This harness interruption was not hidden with test retries. A separate password-reset replay test raced its navigation against the pending sign-out redirect; it now awaits the visible signed-out screen before opening the consumed link.

## Review

### Standards

The standards reviewer found no material documented-standard violation or noteworthy heuristic smell. It found one P2 evidence issue: the coverage Playwright rerun overwrote the workerd report. Separate output/report directories resolve that finding. Current `queue: max` support was verified against GitHub's official documentation.

### Spec

The spec reviewer found no new actionable correctness/security finding in the hardening diff. Deployment guards match the requested scope; live integration limitations remain explicit.

Standards: one finding, resolved (P2 evidence preservation). Spec: zero new actionable findings.

## Minimal remaining setup

For a hosted account/team smoke test: approve an isolated Supabase project and cost, provide its project reference and server Postgres URL with `sslmode=verify-full`, a Cloudflare account/token, a strong Better Auth secret, and a verified restricted email sender/key through protected GitHub environments. OAuth and test billing can stay disabled until their separate credentials are supplied. Preview lifecycle additionally needs an empty, separate Supabase preview-parent project and scoped management token. The trusted workflows must exist on `main`, and deployment variables are enabled only after setup. Nothing is automatically merged.

[DEPLOYMENT.md](DEPLOYMENT.md) lists exact secret/variable names, callbacks, Stripe test settings, live smoke checks, and migration compatibility/roll-forward instructions. Provider integrations being connected does not supply runtime credentials or approve paid provisioning. The Supabase organization/cost confirmation is the remaining provisioning decision; no existing unrelated project is reused.
