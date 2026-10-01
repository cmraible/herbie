# Milestone verification

Validated locally on 2026-10-01 with Node 24.19.0 and the repository's pnpm 10.34.6. No direct provider deployment, credential creation, capacity purchase, live factory execution, external PR publication or merge occurred. GitHub Actions publication is now authorized; its outcome is reported separately.

| Check | Result |
| --- | --- |
| Frozen-lockfile pnpm install | Passed |
| Root controller typecheck and build | Passed; existing controller source unchanged |
| Agent-factory typecheck | Passed |
| Domain, provider-adapter and security suite | 27 tests passed |
| Compiled Worker integration | 9 tests passed with real local D1/SQLite and Durable Objects |
| Worker dry-run build | Passed; approximately 4,154 KiB uncompressed / 616 KiB gzip |
| Local D1 migration | All three migrations applied successfully to local D1 |
| Runner JavaScript and Docker-preflight shell syntax | Passed |
| Git whitespace/diff check | Passed |

The fake-adapter suite covers initial reservations, create/repair/merge-to-next loop, review/CI feedback, duplicate events, concurrent ticks, prompt snapshots, response-loss recovery, stopped/lost processes, lease expiry, exhausted attempts, repeated ineffective repairs, close without merge, reopened PRs, pause/resume with pending publication and repair feedback, and generated-PR scope policy.

The production adapters are tested at their interfaces with transport/SDK fakes: VM-only enforcement, deterministic VM recovery, confirmed deletion, no master API key in uploaded job data, paginated progress-comment reconciliation, and problem-first draft PR metadata.

Security tests cover webhook body authentication, scoped run tokens and branch-limited Git pushes. Better Auth native-D1 integration covers hashed magic links, concurrent single-use redemption, expiry, off-origin callbacks, private admission, session revocation and lack of workspace privileges from email verification alone. Compiled Worker tests redeem actual magic links through the Worker response wrapper. The compiled Worker test exercises workspace isolation, automatic member—not admin—join, disabled domains, colleague goal editing, admin-only connection settings, execution-disabled behavior, CAS/quota persistence, signed webhook replay and early CI inbox retention.

## Standards review

Independent read-only review followed `.agents/skills/code-review/SKILL.md`, comparing the new package to base commit `361298f`. The following findings were fixed:

1. Cleanup depended on a healthy/authorized GitHub connection. Paused cleanup now precedes GitHub reads; disabled connections/billing and the global kill switch pause and terminate execution.
2. Repair progress-comment recovery only inspected 100 comments. Lookup now paginates, with a bounded escalation rather than duplicate publication beyond the bound.
3. Daytona SDK construction prevented isolated adapter tests. A narrow injectable SDK interface now tests the real execution adapter without allocating capacity.
4. Structured-summary validation occurred after pushing code. Validation now occurs before staging/commit/push, with matching schema constraints. The reviewer confirmed this correction.

## Spec review

The originating spec is the supplied task, recorded in `SPEC.md`, including the user's later small-PR policy. The following findings were fixed:

1. Early CI events could be acknowledged before PR publication. The durable inbox now retains relevant events while a creation run is running or publishing.
2. Successful-but-ineffective repairs could loop forever. A persistent per-PR repair budget pauses after five automatic repair runs; explicit human resume resets it.
3. Reopened PRs were omitted from capacity. Tracked nonmerged PRs are reconciled before new reservations on resume.
4. Pausing after a lost PR-publication response discarded its reservation. Publishing checkpoints now survive pause and reconcile on resume.
5. Pausing discarded consumed repair feedback. Suspended repairs retain feedback and resume with a fresh attempt; exhausted repair feedback is restored once on explicit resume. The reviewer confirmed both pause fixes and their regression coverage.

Four Standards findings and five Spec findings were addressed. These reviews and local tests do not establish production readiness. The provider smoke tests, operator setup, remaining product gaps and scale limits are detailed in `README.md`.

## Onboarding, authentication and Actions review

DNS proof/expiry and competing company claims, existing tenant protection, explicit enablement, suspension and last-admin protection are tested against local D1. GitHub tests cover provider-derived authority, exact-session OAuth state, revocation, selection rollback across workspaces, concurrent acceptance and admin revocation. Deployment tests prove missing-config/enablement rejection and resource reuse.

Review corrections: bind GitHub state to the exact session; make repository selection and audit atomic; report missing Organization Members permission; clone redirect responses before common headers; enforce POST before logout side effects; allow logout after admission is removed. Targeted reviewers inspected both onboarding and the revised Better Auth/Actions implementation. No live sender/provider contracts have been validated.

Better Auth 1.7.7 schema was generated against its actual native-D1 configuration, including the magic-link plugin and persistent rate-limit table. The pinned dependency and generated SQL are committed together. The sender is replaceable; Mailgun is the selected sender, with US/EU routing, tracking disabled per message and sanitized delivery errors.

Full compiled-Worker GitHub OAuth callback coverage exposed Workers global-fetch receiver binding; all fetch-injectable adapters now bind the default transport to globalThis. The callback now returns its expected 303, and magic-link callbacks return 302 through the common response wrapper. Mailgun transport tests use fakes only; no real email was sent.
