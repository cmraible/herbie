# GitHub Actions verification and delivery

`.github/workflows/ci-deploy.yml` runs on pull requests and pushes to `main`.
On pull requests, it verifies builds and strict typechecking, unit and PostgreSQL
integration coverage, the compiled CLI, Chromium browser scenarios, and the portable Node
container. **All tests passed** requires every verification job to succeed;
require this status in branch protection. The container job calls the reusable
`portable-smoke.yml` workflow, which builds and smoke-tests the image once.
For same-repository PRs, it also uploads that exact image to GHCR before the
container check passes. Fork PRs verify without uploading.

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

PR images use `tree-<git-tree-SHA>` tags. The tree identifies the exact repository
contents, so squash, rebase, and merge commits can reuse the PR image even when
the commit SHA changes. PRs check out GitHub's synthetic merge commit, including
the base branch's contents. Only same-repository PRs can upload candidates, and
uploading requires `HERBIE_IMAGE_PUBLISH_ENABLED=true`. PR uploads do not announce
Flux releases or deploy production.

Every push to `main` calls the portable workflow with its monotonically increasing
run number. It finds the candidate for main's exact tree and verifies the image's
source-tree label. It then copies the existing manifest to the main commit and
ordered channel tags using `docker buildx imagetools create --prefer-index=false`.
There is no rebuild, test run, image pull, or layer upload on main. Promotion still
requires `HERBIE_IMAGE_PUBLISH_ENABLED=true` and the `homelab-image` environment.
Both PR upload and main promotion use the short-lived GitHub token with
`packages: write`; other PR checks have read-only access.

A missing or mismatched candidate fails promotion. Keep PRs current with main and
wait for **All tests passed** before merging. If another merge changes the resulting
tree, update the PR and rerun its checks before merging. Direct pushes and fork PRs
need a matching image built on a same-repository PR; there is no fallback build.

After promotion, the job announces an OCI release artifact tagged
`0.0.<CI-run-number>`, containing the existing image digest and main commit SHA.
It rejects superseded main commits before promotion and before announcing the
release. Flux polls this channel and applies private infrastructure patches to
roll out k3s. Registry promotion removes the build/upload delay; Flux polling,
node image pulls, and pod startup still determine rollout latency.

A manual dispatch on `main` with `publish=true` retags the matching PR image for
recovery without announcing an automatic OCI release. With `publish=false`, it
only builds and verifies the container.

See [portable deployment](portable-deployment.md) for runtime configuration,
revision metadata, rollout verification and OCI rollback. There is no Git
writeback, cluster credential, production hostname, or infrastructure account ID
in the public workflow. Cloudflare DNS and Tunnel remain private ingress;
application CI no longer uses Workers, Durable Objects or Wrangler.

References: [GitHub PR merge checkout](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request),
[Docker manifest copying](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/).
