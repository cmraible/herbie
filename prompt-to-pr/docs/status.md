# Implementation status

The implementation lives in `cmraible/herbie/prompt-to-pr`, alongside the original app. It uses a separate private `prompt_to_pr` database schema and preserves the existing GitHub App and callback URLs.

Implemented:

- Four packages: API/worker, shared contracts/client, web, CLI.
- Durable runs/events, owner isolation, idempotent submission, queue quotas, single-run claiming, expired-lease detection.
- GitHub sign-in, CLI device approval, paginated repository discovery, scoped installation tokens.
- One E2B coding session, persisted change artifact, confirmed cleanup before trusted Git publication.
- Deterministic commits and reconciliation of lost push/PR responses; explicit saved-artifact recovery.
- Private redacted diagnostics, bounded safe read retries, container startup/migration checks, CI image build.

Verified locally: all packages build and typecheck; 25 integration tests pass, including real Postgres, the complete GitHub OAuth callback, Better Auth sessions/device approval, CLI process behavior, authorization, recovery eligibility, and Git publication. Container migrations pass twice; the API runs with a read-only filesystem and serves the web assets. Desktop and 390px mobile browser fixtures exercised submission and PR display.

Initial operator check: one paid E2B session produced [draft PR #224](https://github.com/cmraible/herbie/pull/224), changing only a smoke-test document. Sandbox deletion was independently confirmed. This operator-script test establishes execution/publication, not end-to-end web/CLI login.

Deployed on 2026-11-10 at [herbie.raible.dev](https://herbie.raible.dev):

- Source merged in [#225](https://github.com/cmraible/herbie/pull/225), runtime packaging improved in [#226](https://github.com/cmraible/herbie/pull/226).
- Login fixed in [#228](https://github.com/cmraible/herbie/pull/228): provider-mapped GitHub identity fields now survive account creation, and the auth error page is routed correctly. Regression coverage rejects unapproved/spoofed identities and keeps generic signup/profile writes unavailable.
- Running revision: `d998b27f45325460818a6d9253aa7a1890e978b0`.
- Image: `ghcr.io/cmraible/herbie-prompt-to-pr@sha256:33a5775bae83d98f434ff6c643d5422baed765c8e2ab0f7bb3a2af6056e47633`.
- Initial deployment: [homelab #30](https://github.com/cmraible/homelab/pull/30); login fix deployed in [homelab #31](https://github.com/cmraible/homelab/pull/31). Both API and worker are ready; public health returns the expected revision.
- The new private schema has seven tables, with RLS enabled and no anonymous/authenticated Data API grants. Original Herbie data remains intact; no original projects/jobs were active at cutover.
- OAuth initiation uses the existing App/callback and secure HttpOnly cookies. Anonymous run access returns 401. The deployed sign-in page was visually inspected.
- The exact production image has zero HIGH/CRITICAL Trivy findings in a local scan. Application checks and deployment configuration validation pass. The broader [homelab image scan](https://github.com/cmraible/homelab/actions/runs/42929143717) is still failing; it is not represented as passing.
- Rollback configuration and prior image/release digests are recorded in the private deployment repository's `kubernetes/prompt-to-pr/README.md`.

Full client acceptance passed on 2026-11-10 (America/New_York):

- Real GitHub browser sign-in as `cmraible` succeeded and loaded 84 accessible repositories. No production session was fabricated.
- Web run `88403db9-3970-4a8d-a061-31df38a4d284` produced [draft PR #229](https://github.com/cmraible/herbie/pull/229). The browser tab was closed during execution; reopening the saved run URL displayed the completed result and activity.
- CLI device login was approved in the signed-in browser. Repository discovery returned the same 84 repositories. Run `7bf8ce30-5f00-4778-99b4-b7349f95dd61` was submitted without waiting; after that process exited, a separate status command retrieved success and [draft PR #230](https://github.com/cmraible/herbie/pull/230).
- Both persisted runs succeeded. GitHub independently confirmed that each PR is a draft and changes only its requested three-line smoke-test document. Both remain unmerged for review.
- Both run records confirm cleanup, and independent E2B lookups confirmed both environments were absent after completion.

The requested MVP is implemented, deployed, and verified through both clients. Live execution used the authorized public repository; private repository access boundaries and failure/recovery cases are covered by integration tests. PR comment handling, CI repair, and new work after merge remain deferred as planned.
