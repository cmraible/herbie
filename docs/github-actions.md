# GitHub Actions verification and delivery

`.github/workflows/ci-deploy.yml` runs on pull requests and pushes to `main`.
It verifies builds and strict typechecking, unit and PostgreSQL integration
coverage, the compiled CLI, Chromium browser scenarios, and the portable Node
container. **All tests passed** requires every verification job to succeed;
require this status in branch protection. The container job calls the reusable
`portable-smoke.yml` workflow, which has only read permission.

Checks use Node 24.19.0, pnpm 10.34.6 and the frozen lockfile. Actions are pinned
to commit SHAs, and PostgreSQL and Node container images are pinned by digest.
The runner and Debian package repositories still receive upstream updates.
Tests use disposable PostgreSQL and deterministic demo execution, without live
OAuth, Daytona, or model calls. Failure evidence expires after seven days.

Run `HERBIE_TEST_DATABASE_URL=<disposable-loopback-postgres-url> bash
scripts/ci-verify.sh all` locally for builds, typechecks, release-artifact tests,
unit/integration tests, CLI and browser coverage. Build the root Dockerfile and
run `bash scripts/test-portable-container.sh <image> <expected-revision>` for the
container smoke check. The workspace has no separate lint script.

## Automatic image delivery

After all blocking checks pass on a push to `main`, CI calls the portable workflow
with publication enabled and its monotonically increasing run number. Publication
also requires `HERBIE_IMAGE_PUBLISH_ENABLED=true` and the existing `homelab-image`
environment restrictions. Only the publication job has `packages: write`; it
uses the short-lived GitHub token and rejects a superseded main commit.

The job builds and smoke-tests the exact image, pushes its source-SHA and ordered
channel tags to GHCR, then announces an OCI release artifact tagged
`0.0.<CI-run-number>`. The checksum-pinned Flux publisher emits only public resource
identities, immutable image digest and source revision. Flux polls this channel
and applies private infrastructure patches to roll out k3s. There is no Git
writeback, cluster credential, production hostname, or infrastructure account ID
in the public workflow. See [portable deployment](portable-deployment.md) for
runtime configuration, rollout verification and OCI rollback.

A manual dispatch of the portable workflow on `main` can publish a recovery image
when requested, but cannot announce an automatic OCI release. PR checks have no
publication credentials. Cloudflare DNS and Tunnel remain private ingress
infrastructure; application CI no longer uses Workers, Durable Objects or Wrangler.
