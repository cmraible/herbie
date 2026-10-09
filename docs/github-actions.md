# GitHub Actions verification and deployment

Production deployment runs through `.github/workflows/ci-deploy.yml`. Desktop
Wrangler login is unnecessary. The workflow is inert for production until an
operator completes the setup below; merging this workflow alone deploys nothing.

## What runs and when

Every pull request and push to `main`, plus manual dispatch, is eligible for
**Verify** on a fresh GitHub-hosted Ubuntu runner. Runs intended to deploy must
first pass **Deployment configuration preflight**, described below. Verify
installs Node 24.19.0 and pnpm 10.34.6, uses
the frozen lockfile, and runs build, strict typecheck, all unit/Postgres integration
tests, compiled CLI integration, Chromium browser scenarios, local workerd checks,
and a Docker/Worker deployment dry-run. No live OAuth, Daytona or model run occurs.
Postgres is disposable. Test evidence contains local demo data and expires after
seven days. The executable equivalent is `scripts/ci-verify.sh`.

Actions are pinned to full commit SHAs. PostgreSQL, the Dockerfile frontend and
Node base images are pinned by digest; Wrangler and pnpm have exact versions.
The hosted runner and Debian package repositories still receive upstream updates,
so this is not a claim that every resulting image byte is reproducible forever.
Review dependency and image-pin updates through ordinary pull requests.

Repository variable `HERBIE_DEPLOY_MODE` controls deployment:

| Value | Deployment behavior after Verify succeeds |
| --- | --- |
| Missing or any value other than those below | No deployment |
| `manual` | Only **Run workflow**, selecting branch `main` |
| `automatic` | Pushes to `main` and manual runs on `main` |

For a deployment-intended run, preflight runs before Verify, dependency
installation, browser setup or image building. It checks out the exact run SHA
and uses Node 24's native TypeScript support to run
`node packages/cloudflare/scripts/preflight.ts`, with no dependency installation.
Missing or empty required inputs and malformed known-format inputs fail the job;
diagnostics contain field names and sanitized reasons only. A failed preflight
prevents Verify and deployment. PRs and runs outside the deployment mode gate
skip preflight and retain ordinary Verify checks without production secrets.

Preflight uses the protected `production` environment, so its approval must happen
before GitHub releases environment secrets. The later deployment job may require
its own approval. Event-triggered workflows cannot declare environment secrets
as required inputs; preflight provides that runtime check. It validates shape,
template configuration and internal consistency only. Opaque tokens receive
nonempty, single-line format checks, not authentication. Preflight makes no
provider authentication or connectivity check and proves no provider access. It
also checks GitHub's current main SHA using a read-only request before Verify;
unreachable GitHub or a stale run fails closed.

Production additionally requires current `main`, the `production` environment's
approval/protection rules, and an exact repository match with the private
`HERBIE_DEPLOY_REPOSITORY` secret. PRs, tags and other branches cannot deploy;
forks do not inherit the production environment secrets. The job uses a separate
clean runner, no PR artifacts or dependency caches, and a read-only `GITHUB_TOKEN`.
There is no `pull_request_target`, `workflow_run`, `id-token: write`, repository
write permission or model credential in the workflow.

Deployments share `herbie-production` concurrency with cancellation disabled.
Immediately before release, the helper checks GitHub's current `main` SHA and
rejects stale queued runs/reruns. Newer commits arriving during an existing
deployment wait; they do not cancel its rollout. The job runs full `wrangler
deploy`, including image push, assets, Worker, Durable Object and Cron setup.
Each run/attempt gives the image a distinct public revision, including secret-only
updates. The image has its own baked-in revision, independent of the Worker startup
configuration. Success requires `/api/health` to report both revisions matching the
requested release, working Postgres, live mode and **execution disabled** within
ten minutes. An old image restarted with new configuration cannot pass readiness.

## One-time operator setup

1. Confirm Workers Paid eligibility on the operator-selected Cloudflare account.
   The approved $20/month incremental hosting budget excludes AI/Daytona and is
   not a hard billing cap. A plan upgrade needs separate approval if the account
   is not already eligible.
2. Create GitHub environment **production**. Select deployment **branch `main`
   only**, with no tag rule. Add the intended human reviewer and disable admin
   bypass. With one operator, do not prevent self-review unless another reviewer
   is available. Use **Selected branches and tags**, because **Protected branches
   only** allows all branches when no branch rules exist.
3. Protect `main`: require a pull request and the **Verify** check, disallow force
   pushes/deletion, and arrange human review of deployment workflows, helpers,
   Dockerfile, dependency pins and runtime changes. These settings are operator
   actions; checking in this workflow does not configure GitHub protections.
4. Create an **account-owned Cloudflare API token**, scoped only to the account
   selected for this deployment. Initial creation requires **Workers Admin at
   Workers product scope** plus **Containers Edit** (API catalog: **Containers
   Write**). Once
   `herbie-service` exists, replace the bootstrap token with **Workers Editor
   scoped to that Worker**, retaining account-scoped Containers Edit. No DNS,
   Zone Workers Routes, R2, D1, KV, Pages or separate Images permission is needed.
   API permission sufficiency still needs verification during the approved first
   deployment. Never reuse a broad personal/global API key.
5. Enter the following values directly in the **production environment** settings.
   The user handles sensitive transfer; do not put values in chat, source, issues,
   workflow inputs or shell arguments. Account and project identifiers belong in
   **secrets even when they are not authentication credentials**. Use the selected
   Herbie Supabase project's password; creating this workflow does not reset it or
   create a GitHub App. Keep the environment URL unset so an account-specific
   application origin is not recorded in the public workflow.

| Environment secret | Value |
| --- | --- |
| `HERBIE_DEPLOY_REPOSITORY` | Exact expected GitHub `owner/repository`, such as the synthetic placeholder `<github-owner>/<repository>` |
| `CLOUDFLARE_ACCOUNT_ID` | The selected account ID; replace `<cloudflare-account-id>` privately |
| `HERBIE_PUBLIC_URL` | Exact HTTPS Worker origin, such as `https://herbie-service.<workers-subdomain>.workers.dev`, with no path, query or fragment |
| `HERBIE_SUPABASE_PROJECT_REF` | The selected project's reference; replace `<supabase-project-ref>` privately |
| `HERBIE_SUPABASE_POOLER_HOST` | Exact session pooler hostname from that project's connection settings; replace `<session-pooler-host>` privately, without a scheme, port or path |
| `HERBIE_GITHUB_APP_ID` | Approved GitHub App numeric ID |
| `HERBIE_GITHUB_CLIENT_ID` | That App's OAuth client ID |
| `CLOUDFLARE_API_TOKEN` | The scoped deployment token described above |
| `HERBIE_DATABASE_URL` | Exact **session** pooler URL, using username `postgres.<supabase-project-ref>`, the selected session pooler hostname, port 5432 and database `postgres`; URL-encode its password |
| `HERBIE_CREDENTIAL_KEY` | Stable 32-byte base64 encryption key, generated once through the approved secret-management process; keep with database backups |
| `HERBIE_GITHUB_CLIENT_SECRET` | App OAuth client secret |
| `HERBIE_GITHUB_PRIVATE_KEY` | App RSA private-key PEM, with actual newlines |
| `HERBIE_GITHUB_WEBHOOK_SECRET` | App webhook secret |
| `HERBIE_DATABASE_CA` | Optional Supabase public CA PEM; unset or empty when system trust suffices |

Every angle-bracketed value above is a synthetic placeholder, not a usable account
or project identifier. Do not commit the substituted values. `HERBIE_DEPLOY_MODE`
remains a nonidentifying **repository variable**; the identifying deployment inputs
in this table are **production environment secrets**, not public variables.

GitHub App permissions, callback, webhook and repository installation are in
[service setup](service.md) and [the deployment runbook](cloudflare-deployment.md).
The app uses GitHub sign-in; Supabase publishable/service-role keys are unnecessary.
The workflow deliberately has no Daytona or OpenAI inputs.

## Runtime secret bundle and first release

GitHub stores sensitive values separately so its masking does not depend on a
single structured JSON secret. Only the preflight and deployment steps receive
them; a shared step-level YAML mapping keeps their inputs identical. Neither
job-wide environments, outputs nor artifacts carry production secrets. The
deployment job reruns preflight with fresh secrets before installing dependencies
or building, because settings may have changed since the first approval. The
actual deployment helper validates the same inputs again before any Cloudflare
write. It checks the running repository against `HERBIE_DEPLOY_REPOSITORY`,
the expected Worker name `herbie-service` against `HERBIE_PUBLIC_URL`, the database username against
`HERBIE_SUPABASE_PROJECT_REF`, and the exact database hostname against
`HERBIE_SUPABASE_POOLER_HOST`. These private comparisons retain the deployment
target checks without hardcoding an account in source. The helper constructs the
allowlisted `HERBIE_RUNTIME_SECRETS` JSON bundle, and writes Wrangler's secrets
file with mode **0600** in a private temporary directory outside the Docker context.
Runtime credentials are excluded from child-tool environments and build arguments.
Among child tools, the Cloudflare token reaches only Wrangler. Transient registry
credentials and Wrangler logs use the same temporary directory. Files are removed
on completion or handled interruption; the disposable runner is the final cleanup boundary.
No production logs or secret files are uploaded as workflow artifacts. Child-tool
output is suppressed to avoid credential-bearing diagnostics. Removing identifiers
from the current repository tree does not erase Git history, prior logs, workflow
artifacts or previously published copies. Historical cleanup remains a separate
operator decision.

After permissions, inputs and protections are ready, set the **repository** variable
`HERBIE_DEPLOY_MODE=manual`. Dispatch the workflow from current `main`, approve
the preflight environment access, and review its result followed by Verify.
Approve the later deployment environment job when requested. The helper supplies
the bundle through pinned Wrangler's `deploy --secrets-file` support, so the first
release does not need a separate desktop secret-upload command.

Check login, repository access, disabled start/resume, actual Supabase TLS and
security advisors before setting `HERBIE_DEPLOY_MODE=automatic`. Automatic mode
still observes configured environment approvals. Every release keeps execution
off; enabling paid work requires a separately reviewed change and explicit run
approval. Do not add execution credentials to bypass that gate.

## Failure and rotation

An invalid/missing input fails before Cloudflare writes. A stale-main run is
refused. A rollout/health failure marks the job failed. Deployment is not
transactional: the new Worker can be active even if image publication or container
replacement fails. Inspect Cloudflare state before another run; do not assume
automatic rollback. Rerun current `main` after correcting the cause; never rerun
an old successful SHA to downgrade production. Roll back through a reviewed revert
on `main`, after checking schema compatibility. Secret changes get a fresh image
revision on the next run so an old process cannot retain the old bundle silently.

Set `HERBIE_DEPLOY_MODE` to `disabled` to prevent future deployment jobs. This does
not cancel an already-approved running deployment or stop application work. Before
any future rollout of an execution-enabled service, follow the all-goals drain
procedure in the deployment runbook; this workflow only supports disabled execution.

Sources: [Cloudflare GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/),
[Workers roles](https://developers.cloudflare.com/workers/authorization/workers/),
[Durable Objects authorization](https://developers.cloudflare.com/workers/authorization/durable-objects/),
[API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/),
[container deployment behavior](https://developers.cloudflare.com/containers/guides/deploy/),
[GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[GitHub secret and action security](https://docs.github.com/en/actions/reference/security/secure-use).
Current Cloudflare documentation and Wrangler 4.148.0 expose API-token CI
authentication, not a supported GitHub OIDC exchange for this deployment.
