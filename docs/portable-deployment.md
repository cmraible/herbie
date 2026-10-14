# Portable deployment preparation

The root Dockerfile runs the API, React UI, and background coordinator on port
8787 with Node 24 and native Git. PostgreSQL stores durable state. Coding and
verification still run in Daytona; no generated code runs on the coordinator.
No application PVC is required. Retain the existing owner-only GitHub login,
credential encryption key, database TLS verification, and explicit execution gate.

## Image delivery

`Portable image` builds and smoke-tests every PR without publishing credentials.
Every push to main runs the full CI suite. Only after all blocking checks pass,
CI calls the portable workflow to build, smoke-test, and publish that exact commit.
Publication retains the `HERBIE_IMAGE_PUBLISH_ENABLED=true` repository gate and
existing `homelab-image` environment restrictions. The job rejects a commit if
main has advanced before publication. Cloudflare deployment remains disabled.

The image name is `ghcr.io/<repository-owner>/<repository-name>`, lowercased from
GitHub repository context. Only publication has `packages: write`, using the
short-lived `GITHUB_TOKEN`; no infrastructure credential enters the public repo.
A manual main-branch dispatch with `publish=true` still publishes a source-SHA tag
for recovery, but cannot advance the automatic deployment channel.

Successful CI publication also produces `main-<CI-run-number>-<source-SHA>`.
The private infrastructure repository's Flux image policy selects the highest
numeric CI sequence, reflects its digest, and commits both the immutable image
reference and matching deployment tag. An older run finishing late cannot replace
a newer selected release. Infrastructure commits do not trigger application CI,
so this path has no commit loop. Public GHCR visibility permits anonymous image
pulls; publishing does not change package visibility or registry permissions.

`HERBIE_DEPLOYMENT_ID` identifies the selected deployment tag while the baked
`HERBIE_IMAGE_REVISION` remains the exact source SHA. Verify the running digest,
source SHA, Flux readiness, and public health after rollout. To roll back, suspend
the private image automation first, then restore an approved digest and deployment
ID together; otherwise the policy will select the newer release again. Do not
reset the CI run-number ordering or delete channel tags as part of a rollback.

The Docker context is an allowlist of public source/manifests, excluding local
.env files, Git metadata, deployment configuration, tests, and credentials. The
runtime copies only production dependencies, compiled service/loop/UI and contracts.
Runtime secrets are injected after deployment; no runtime secret is a build input.
Before public publication, audit the actual context, image configuration/history,
and all final-image layers, including files removed in later layers. This is a
release check, not a claim that a generic secret scan can prove absence of secrets.

## Runtime contract

- `GET /api/live` checks the responding HTTP process without external dependencies.
- `GET /api/health` checks PostgreSQL and reports mode, execution gate, deployment
  ID and baked image revision. Use it for readiness, never liveness.
- Startup has its own 60-second deadline. Allow about 90 seconds for the startup
  probe including process overhead. A database outage must not cause restart churn.
- SIGTERM closes the listener and stops new claims, then waits for active bounded
  work and cleanup before closing the pool. Allow 20 minutes of termination grace
  for the roughly 15-minute attempt lifecycle plus publication/database overhead.
  This is an operating allowance, not a new global deadline. Never force-delete
  an active coordinator or assume a terminated process proves sandbox cleanup.
- One steady replica, `Recreate` strategy, no autoscaler. Budget bounded writable
  `/tmp` and ephemeral storage for native Git publication. Run as UID/GID 1000
  with a read-only root filesystem and no Linux capabilities.
- Starting the process runs migrations even when `HERBIE_EXECUTION_ENABLED=false`.
  Smoke and staging tests must use an isolated database. A disabled worker alone
  is not isolation from production state.

Provision runtime secrets through the operator's approved secret channel. The
standalone service expects `DATABASE_URL`, `HERBIE_CREDENTIAL_KEY`,
`HERBIE_ALLOWED_GITHUB_USER_ID`, `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`.
The GitHub names intentionally lack the deployment wrapper's `HERBIE_` prefix.
Preserve `HERBIE_DATABASE_CA` if configured. Execution also needs `DAYTONA_API_KEY`,
`HERBIE_DAYTONA_OPENAI_SECRET` (the existing Daytona secret name), and any configured
`DAYTONA_API_URL` / `HERBIE_DAYTONA_SNAPSHOT`. Do not export the model API key from
Daytona. Never log or commit any of these values.

## Handoff and rollback

Plan the handoff in the private infrastructure repository. Before either starting
against production or changing DNS, inventory jobs, leases, sandboxes, and uncertain
publication; stop new submissions and drain the old coordinator. Confirm it cannot
restart or run reconciliation. Only then start the new coordinator with execution
disabled, verify exact revision and database readiness, switch ingress and GitHub
App callback/setup/webhook URLs, test owner authentication, and explicitly enable
execution. Do not trigger a paid smoke goal without separate authorization.

Rollback must drain and stop the new coordinator first, restore routing and GitHub
App URLs, and resume only a schema-compatible old image. Never run old and new
enabled coordinators concurrently or downgrade the database as part of rollback.
Read structured redacted logs through the deployment's existing private logging
path; do not assume a separate observability stack is installed.
