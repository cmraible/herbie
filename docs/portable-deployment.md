# Portable deployment preparation

The root Dockerfile runs the API, React UI, and background coordinator on port
8787 with Node 24 and native Git. PostgreSQL stores durable state. Coding and
verification still run in Daytona; no generated code runs on the coordinator.
No application PVC is required. Retain the existing owner-only GitHub login,
credential encryption key, database TLS verification, and explicit execution gate.

## Image delivery

`Portable image` builds and smoke-tests every PR without publishing credentials.
It publishes only through an explicit main-branch `workflow_dispatch` with
`publish=true` and repository variable `HERBIE_IMAGE_PUBLISH_ENABLED=true`.
The image name is `ghcr.io/<repository-owner>/<repository-name>`, lowercased from
GitHub repository context. Only the publication job has `packages: write`; its
login step uses the automatic `GITHUB_TOKEN` after building and testing. No personal
token, GCP identity, registry secret, or Kubernetes pull secret is needed.

Keep the `homelab-image` environment's intended approval/main-branch restrictions.
If a package with this name already exists, verify this repository has Actions
write access to it. The source/revision OCI labels link the image to its public
source. Image publication does not apply infrastructure. The Cloudflare deployment job
is explicitly paused during migration, so merging cannot redeploy the old
coordinator. The existing service continues running until the coordinated drain.
Re-enabling Cloudflare deployments requires a reviewed workflow change after
confirming the k3s coordinator is stopped.

**Public visibility is a separate operator step.** GHCR packages are private when
first published, even from a public repository. After the separately approved
first publication, set the package to public in GitHub Packages and verify an
anonymous pull using a clean Docker configuration. This workflow does not change
visibility. Do not enable Flux until that anonymous digest pull succeeds. See
[GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Publishing records the source SHA and complete immutable image digest reference.
Pin that digest in the private infrastructure repository; a source-SHA tag alone
is not immutable. Set `HERBIE_DEPLOYMENT_ID` to the matching source SHA, never
override baked `HERBIE_IMAGE_REVISION`, and compare both readiness fields after
rollout. Retain approved digests for rollback.

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
