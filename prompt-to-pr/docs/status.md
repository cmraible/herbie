# Implementation status

The implementation lives in `cmraible/herbie/prompt-to-pr`, alongside the original app. It uses a separate private `prompt_to_pr` database schema and preserves the existing GitHub App and callback URLs.

Implemented:

- Four packages: API/worker, shared contracts/client, web, CLI.
- Durable runs/events, owner isolation, idempotent submission, queue quotas, single-run claiming, expired-lease detection.
- GitHub sign-in, CLI device approval, paginated repository discovery, scoped installation tokens.
- One E2B coding session, persisted change artifact, confirmed cleanup before trusted Git publication.
- Deterministic commits and reconciliation of lost push/PR responses; explicit saved-artifact recovery.
- Private redacted diagnostics, bounded safe read retries, container startup/migration checks, CI image build.

Verified locally: all packages build and typecheck; 24 integration tests pass, including real Postgres, Better Auth sessions/device approval, CLI process behavior, authorization, recovery eligibility, and Git publication. Container migrations pass twice; the API runs with a read-only filesystem and serves the web assets. Desktop and 390px mobile browser fixtures exercised submission and PR display.

Verified live: one paid E2B session produced [draft PR #224](https://github.com/cmraible/herbie/pull/224), changing only a smoke-test document. Sandbox deletion was independently confirmed. This operator-script test establishes execution/publication, not end-to-end web/CLI login.

Deployed on 2026-11-10 at [herbie.raible.dev](https://herbie.raible.dev):

- Source merged in [#225](https://github.com/cmraible/herbie/pull/225), runtime packaging improved in [#226](https://github.com/cmraible/herbie/pull/226).
- Running revision: `ddf35c96e4ab7c7bc10b205d3eb5c93908b4b054`.
- Image: `ghcr.io/cmraible/herbie-prompt-to-pr@sha256:9a6320dd80083d1c856a73e3b02c0ad0092babc71b2695f31ad431a14aec838d`.
- Deployment: [homelab #30](https://github.com/cmraible/homelab/pull/30). Both API and worker are ready; public health returns the expected revision.
- The new private schema has seven tables, with RLS enabled and no anonymous/authenticated Data API grants. Original Herbie data remains intact; no original projects/jobs were active at cutover.
- OAuth initiation uses the existing App/callback and secure HttpOnly cookies. Anonymous run access returns 401. The deployed sign-in page was visually inspected.
- The exact production image has zero HIGH/CRITICAL Trivy findings in local and CI scans. The broader homelab scan remains red on pre-existing unrelated image references/findings; it is not represented as passing.
- Rollback configuration and prior image/release digests are recorded in the private deployment repository's `kubernetes/prompt-to-pr/README.md`.

Remaining before full acceptance:

- Complete real GitHub sign-in in the browser. An interactive sign-in request is pending with the user; no production login/session is fabricated for testing.
- Verify repository discovery and a persisted run from the web client, including reopening while it runs.
- Approve CLI device login and verify a persisted CLI run, then confirm both draft PRs and sandbox cleanup.

The direct live operator test and automated client/auth tests passed, but they do not replace these remaining interactive checks.
