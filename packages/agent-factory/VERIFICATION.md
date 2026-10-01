# Milestone verification

Validated locally on 2026-10-01 with Node 24.19.0 and the repository's pnpm 10.34.6. No deployment, credential creation, capacity purchase, live repository execution, external PR publication or merge occurred.

| Check | Result |
| --- | --- |
| Frozen-lockfile pnpm install | Passed |
| Root controller typecheck and build | Passed; existing controller source unchanged |
| Agent-factory typecheck | Passed |
| Domain, provider-adapter and security suite | 21 tests passed |
| Compiled Worker integration | 1 test passed with real local D1/SQLite and Durable Objects |
| Worker dry-run build | Passed; approximately 2,252 KiB uncompressed / 285 KiB gzip |
| Local D1 migration | All 11 SQL commands applied successfully |
| Runner JavaScript and Docker-preflight shell syntax | Passed |
| Git whitespace/diff check | Passed |

The fake-adapter suite covers initial reservations, create/repair/merge-to-next loop, review/CI feedback, duplicate events, concurrent ticks, prompt snapshots, response-loss recovery, stopped/lost processes, lease expiry, exhausted attempts, repeated ineffective repairs, close without merge, reopened PRs, pause/resume with pending publication and repair feedback, and generated-PR scope policy.

The production adapters are tested at their interfaces with transport/SDK fakes: VM-only enforcement, deterministic VM recovery, confirmed deletion, no master API key in uploaded job data, paginated progress-comment reconciliation, and problem-first draft PR metadata.

Cryptographic tests cover signed Google identities and rejected issuer/audience/signature/expiry/nonce/domain claims, webhook body authentication, scoped run tokens, and branch-limited Git pushes. The compiled Worker test exercises workspace isolation, automatic member—not admin—join, disabled domains, colleague goal editing, admin-only connection settings, execution-disabled behavior, CAS/quota persistence, signed webhook replay and early CI inbox retention.

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

Four Standards findings and five Spec findings were addressed. These reviews and local tests do not establish production readiness. The provider smoke tests, operator setup, billing/onboarding product gaps and scale limits are detailed in `README.md`.
