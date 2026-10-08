# GitHub Actions verification and deployment

Production deployment runs through `.github/workflows/ci-deploy.yml`. Desktop
Wrangler login is unnecessary. The workflow is inert for production until an
operator completes the setup below; merging this workflow alone deploys nothing.

## What runs and when

Every pull request and push to `main`, plus manual dispatch, runs **Verify** on a
fresh GitHub-hosted Ubuntu runner. It installs Node 24.19.0 and pnpm 10.34.6, uses
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

Production additionally requires the exact repository `cmraible/herbie`, current
`main`, and the `production` environment's approval/protection rules. PRs, forks,
tags and other branches cannot enter the deployment job. It uses a separate clean
runner, no PR artifacts or dependency caches, and a read-only `GITHUB_TOKEN`.
There is no `pull_request_target`, `workflow_run`, `id-token: write`, repository
write permission or model credential in the workflow.

Deployments share `herbie-production` concurrency with cancellation disabled.
Immediately before release, the helper checks GitHub's current `main` SHA and
rejects stale queued runs/reruns. Newer commits arriving during an existing
deployment wait; they do not cancel its rollout. The job runs full `wrangler
deploy`, including image push, assets, Worker, Durable Object and Cron setup.
Each run/attempt gives the image a distinct public revision, including secret-only
updates. Success requires `/api/health` to report that exact revision, working
Postgres, live mode and **execution disabled** within ten minutes.

## One-time operator setup

1. Confirm Workers Paid eligibility on account
   `3e763a0e4e26f85d5bc3e5ea698faf06`. The approved $20/month incremental hosting
   budget excludes AI/Daytona and is not a hard billing cap. A plan upgrade needs
   separate approval if the account is not already eligible.
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
   above. Initial creation requires **Workers Admin at Workers product scope**
   plus **Containers Edit** (API catalog: **Containers Write**). Once
   `herbie-service` exists, replace the bootstrap token with **Workers Editor
   scoped to that Worker**, retaining account-scoped Containers Edit. No DNS,
   Zone Workers Routes, R2, D1, KV, Pages or separate Images permission is needed.
   API permission sufficiency still needs verification during the approved first
   deployment. Never reuse a broad personal/global API key.
5. Enter the following values directly in the **production environment** settings.
   The user handles sensitive transfer; do not put values in chat, source, issues,
   workflow inputs or shell arguments. Use the existing Herbie Supabase project's
   password; creating this workflow does not reset it or create a GitHub App.

| Environment variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `3e763a0e4e26f85d5bc3e5ea698faf06` |
| `HERBIE_GITHUB_APP_ID` | Approved Herbie GitHub App numeric ID |
| `HERBIE_GITHUB_CLIENT_ID` | That App's OAuth client ID |

| Environment secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The scoped deployment token described above |
| `HERBIE_DATABASE_URL` | Exact **session** pooler URL for `bhzabpglsjrqvhinishw`, username `postgres.bhzabpglsjrqvhinishw`, port 5432, database `postgres`; URL-encode its password |
| `HERBIE_CREDENTIAL_KEY` | Stable 32-byte base64 encryption key, generated once through the approved secret-management process; keep with database backups |
| `HERBIE_GITHUB_CLIENT_SECRET` | App OAuth client secret |
| `HERBIE_GITHUB_PRIVATE_KEY` | App RSA private-key PEM, with actual newlines |
| `HERBIE_GITHUB_WEBHOOK_SECRET` | App webhook secret |
| `HERBIE_DATABASE_CA` | Optional Supabase public CA PEM; omit when system trust suffices |

GitHub App permissions, callback, webhook and repository installation are in
[service setup](service.md) and [the deployment runbook](cloudflare-deployment.md).
The app uses GitHub sign-in; Supabase publishable/service-role keys are unnecessary.
The workflow deliberately has no Daytona or OpenAI inputs.

## Runtime secret bundle and first release

GitHub stores sensitive values separately so its masking does not depend on a
single structured JSON secret. Only the deployment step receives them. The Node
helper validates required inputs before any Cloudflare write, constructs the
allowlisted `HERBIE_RUNTIME_SECRETS` JSON bundle, and writes Wrangler's secrets
file with mode **0600** in a private temporary directory outside the Docker context.
Runtime credentials are excluded from child-tool environments and build arguments.
The Cloudflare token reaches Wrangler only; transient registry credentials and
Wrangler logs use the same temporary directory. Files are removed on completion
or handled interruption; the disposable runner is the final cleanup boundary.
No production logs or secret files are uploaded as workflow artifacts. Child-tool
output is suppressed to avoid credential-bearing diagnostics.

After permissions, inputs and protections are ready, set the **repository** variable
`HERBIE_DEPLOY_MODE=manual`. Dispatch the workflow from current `main`, review its
Verify result, then approve the production environment job. The helper supplies
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
