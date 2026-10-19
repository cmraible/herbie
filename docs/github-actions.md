# GitHub Actions verification and delivery

`.github/workflows/ci-deploy.yml` runs on pull requests and pushes to `main`.
On pull requests, it verifies builds and strict typechecking, unit and PostgreSQL
integration coverage, the compiled CLI, Chromium browser scenarios, and the portable Node
container. **All tests passed** requires every verification job to succeed;
require this status in branch protection. The container job calls the reusable
`portable-smoke.yml` workflow, which builds and smoke-tests the image once.
For same-repository PRs, it also uploads that exact image to GHCR before the
container check passes. Fork PRs verify without uploading.

When PR image publishing is enabled, same-repository PRs share intermediate
BuildKit layers through `ghcr.io/<owner>/<repo>:buildcache-linux-amd64`.
Recovery builds on main use the same cache; ordinary manifest-only promotion
still needs no build. Cached builds use an isolated builder and load the image
into Docker for the existing smoke test before any candidate is published.
Missing cache entries cause a normal build, and cache export failures are
nonblocking. Fork PRs and local verification keep their existing build path.
Revision metadata is applied after runtime installation layers so a new commit
SHA does not force system packages to be installed again.

Checks use Node 24.19.0, pnpm 10.34.6 and the frozen lockfile. Actions are pinned
to commit SHAs, and PostgreSQL and Node container images are pinned by digest.
The runner and Debian package repositories still receive upstream updates.
Tests use disposable PostgreSQL and injected test adapters, without live OAuth,
Daytona, or model calls. Failure evidence expires after seven days.

Run **`pnpm verify`** (or `bash scripts/verify.sh` without host Node/pnpm) for
local validation. Requires a running Docker engine with Buildx,
Bash, Git, curl and jq. It runs builds, typechecks, release-artifact tests,
unit/PostgreSQL tests, compiled CLI and Chromium scenarios, and manifest promotion
against a disposable local registry. Production image builds and container smoke
tests run in CI through `portable-smoke.yml`. Nothing is published to GHCR or
deployed. The workspace has no separate lint script.

The first run downloads and caches Linux tools, dependencies and Chromium;
allow extra time for this bootstrap and after dependency changes. Subsequent
runs target under two minutes, with workspace and promotion checks
running concurrently. Every invocation executes the tests against the current
working tree, including uncommitted edits; only Docker build layers are cached.
An Apple Silicon Mac with OrbStack completed a cached run in 56 seconds; the
first successful run, including tool installation, took 125 seconds.
The local workspace runner uses the Docker engine's native architecture.
Each run creates and removes its own databases and containers, without loading
your `.env` or exposing database ports. Logs and browser evidence are saved in
the printed `artifacts/ci/herbie-verify-*` directory. Any failed stage fails the
command, which prints the total elapsed time including cleanup. The final timing
tree includes each parallel branch, setup/check step, package build/typecheck/test,
and browser spec. Durations are elapsed wall time; parallel entries overlap and
must not be added together. Browser spec durations span their first test start
through their last test finish, including retries. The same report is saved as
`timings.txt` and machine-readable `timings.json` alongside the logs, including
completed and failed checks when verification fails.

For an individual workspace stage on Linux with Node 24 and installed
dependencies, use `HERBIE_TEST_DATABASE_URL=<disposable-loopback-postgres-url>
bash scripts/ci-verify.sh <build|unit|cli|browser|all>`.

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
When the candidate exists, main needs no rebuild, test run, image pull, or layer upload. Promotion still
requires `HERBIE_IMAGE_PUBLISH_ENABLED=true` and the `homelab-image` environment.
Both PR upload and main promotion use the short-lived GitHub token with
`packages: write`; other PR checks have read-only access.

Branches may merge without being current with main. If an intervening merge
changes the tree and no candidate exists, main builds its exact checkout, runs
the same isolated container smoke test as PRs, and uploads the candidate before
promotion. Build, smoke-test, or upload failure stops the release. An existing
candidate with a mismatched source-tree label still fails without rebuilding.
The same fallback covers direct pushes and fork PRs; branch protection still
requires **All tests passed** on PRs.

After promotion, the job announces an OCI release artifact tagged
`0.0.<CI-run-number>`, containing the existing image digest and main commit SHA.
It rejects superseded main commits before promotion and before announcing the
release. Flux polls this channel and applies private infrastructure patches to
roll out k3s. Registry promotion removes the build/upload delay; Flux polling,
node image pulls, and pod startup still determine rollout latency.

A manual dispatch on `main` with `publish=true` retags the matching PR image for
recovery without announcing an automatic OCI release. With `publish=false`, it
only builds and verifies the container. Recovery with `publish=true` also builds
and smoke-tests the current checkout if its candidate is missing.

See [portable deployment](portable-deployment.md) for runtime configuration,
revision metadata, rollout verification and OCI rollback. There is no Git
writeback, cluster credential, production hostname, or infrastructure account ID
in the public workflow. Cloudflare DNS and Tunnel remain private ingress;
application CI no longer uses Workers, Durable Objects or Wrangler.

References: [GitHub PR merge checkout](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request),
[Docker manifest copying](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/).

## Experimental PR classification

`classify-pr.yml` uses OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions)
with `gpt-6-luna` and the repository's `OPENAI_API_KEY` Actions secret. It runs on
PR creation, reopening, pushes, title/description edits, and ready-for-review events.
It sends the title, description, changed paths, and patches to OpenAI in one request.
No dependency installation or PR code execution is involved.

Automatic runs maintain `ai:change_type:*`, `ai:risk:*`, and `ai:required_approvals:*` labels, preserving other
labels. The Actions summary includes independent subsystem and risk-signal
probabilities. The `pr-classification-*` artifact retains the raw answers, token
usage, effective classification, and base/head SHAs for 30 days; it excludes the
submitted source. These assessments are advisory and are not part of **All tests
passed**. OpenAI API errors fail this separate workflow and leave previous labels unchanged.

Risk means potential unintended production impact: low for narrow, reversible
changes without runtime behavior changes; medium for bounded runtime changes;
high for authentication, authorization, data integrity, destructive migrations,
public contracts, or broadly shared runtime behavior. Missing/truncated patches,
GitHub's 3,000-file cap, or the 120,000-character patch budget force
`insufficient_context`. A model refusal also produces an unknown classification.
Required human approvals are 0 for very straightforward, low-risk changes, 1 for
moderate complexity with bounded risk, and 2 for significant architectural choices
or risky changes. Incomplete evidence or a refusal to answer this question defaults
to 2 approvals. This recommendation does not enforce GitHub merge requirements.
The raw answer remains in the artifact even when incomplete evidence overrides it.
Probabilities have not been calibrated against this repository.

The workflow executes the trusted base revision via `pull_request_target`, never
the PR head, and reads PR contents only through the GitHub API. It must be merged
into the base branch before automatic classification works. Repository Actions
policies must allow this event (see [GitHub's policy guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)).
It checks that the PR title, description, and base/head SHAs are still current
before applying labels. Labels describe the last successful assessment; consult
the run's head SHA when a newer run fails or is still in progress.

For historical evaluation, select **Actions → Classify PR → Run workflow** on
`main` and enter a PR number. Manual runs produce the summary and artifact without
changing labels, including for closed PRs. Start with 50 manually labeled PRs,
including high-risk examples, then compare change-type accuracy and high-risk
false negatives. Historical results use the PR data GitHub returns at run time,
not a reconstruction of the original review context.

Run the classifier's offline regression tests with
`node --test scripts/classify-pr.test.mjs`; these also run in unit verification.
