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

Remaining before launch completion:

- Publish the verified image and cut over the existing URL after confirming no active original Herbie work. Preserve the original image/configuration and database for rollback.
- Verify real GitHub login and repository discovery, CLI device approval, and a persisted run from each client, including reopen/polling and confirmed cleanup.
- Record the deployed revision, final acceptance evidence, and rollback procedure.

No production data migration or deployment change has been applied yet.
