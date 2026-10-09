# GitHub Actions verification and deployment

Production deployment runs through `.github/workflows/ci-deploy.yml`. Desktop
Wrangler login is unnecessary. The workflow is inert for production until an
operator completes the setup below; merging this workflow alone deploys nothing.

## What runs and when

Every pull request runs **Verify** on a fresh GitHub-hosted Ubuntu runner. Pushes
to `main` do not run Verify: after a PR passes the required check and is merged,
the push runs **Deployment configuration preflight** and deployment as separate
jobs. Verify
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

| Value | Deployment behavior |
| --- | --- |
| Missing or invalid | PRs still verify; pushes to `main` skip deployment |
| `disabled` | PRs verify; pushes to `main` skip deployment |
| `automatic` | Pushes to `main` run preflight and deploy; PRs run Verify only |

There is no manual dispatch. This keeps Verify scoped to the proposed PR commit
and avoids rerunning it on the merge commit. Set the variable to `automatic` to
deploy every protected push to `main`; `disabled` pauses deployments while PR
verification continues.

For a deployment-intended push, preflight runs before dependency installation
or image building. It checks out the exact run SHA
and uses Node 24's native TypeScript support to run
`node packages/cloudflare/scripts/preflight.ts`, with no dependency installation.
Missing or empty required inputs and malformed known-format inputs fail the job;
diagnostics contain field names and sanitized reasons only. A failed preflight
prevents deployment. PRs skip preflight and retain ordinary Verify checks without
production secrets.

Preflight uses the protected `production` environment, so its approval must happen
before GitHub releases environment secrets. The later deployment job may require
its own approval. Event-triggered workflows cannot declare environment secrets
as required inputs; preflight provides that runtime check. It validates shape,
template configuration and internal consistency only. Opaque tokens receive
nonempty, single-line format checks, not authentication. Preflight makes no
provider authentication or connectivity check and proves no provider access. It
also checks GitHub's current main SHA using a read-only request before deployment;
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
   pushes/deletion and administrator bypass. This ensures only PRs with passing
   verification can reach `main`, which then triggers deployment when mode is
   `automatic`. Arrange human review of deployment workflows, helpers, Dockerfile,
   dependency pins and runtime changes. These settings are operator actions;
   checking in this workflow does not configure GitHub protections.
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
| `HERBIE_ALLOWED_GITHUB_USER_ID` | Required immutable numeric GitHub ID of the sole permitted owner; verify with the authenticated GitHub profile |
| `HERBIE_DATABASE_CA` | Optional explicit database CA PEM; overrides the bundled Supabase CA fallback |

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
`HERBIE_DEPLOY_MODE=automatic`. Merge a PR after **Verify** passes, then approve
the preflight environment access and deployment environment job when requested.
The helper supplies
the bundle through pinned Wrangler's `deploy --secrets-file` support, so the first
release does not need a separate desktop secret-upload command.

Check login, repository access, disabled start/resume, actual Supabase TLS and
security advisors before enabling automatic deployment. Automatic mode
still observes configured environment approvals. Every release keeps execution
off; enabling paid work requires a separately reviewed change and explicit run
approval. Do not add execution credentials to bypass that gate.

## Failure and rotation

A failed deployment subprocess now reports a fixed diagnostic stage/category,
its exit code or signal, and recognized Cloudflare error codes from a small
allowlist (`10000`, `10021`, `100146`). These are observations, not a guarantee of
the root cause. Unknown errors remain `unclassified`; unfamiliar codes are omitted.
The helper retains at most 64 KiB from each of stdout and stderr, and reads at
most the final 64 KiB of its private Wrangler log after failure. It classifies
known markers into fixed labels, rather than printing redacted raw messages.
No captured text, response bodies, URLs, paths or identifying values are printed
or uploaded. The private temporary log and secrets are removed after classification
by the existing cleanup path. Missing/truncated logs may reduce diagnostic detail.

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


### Database certificate trust

Herbie includes Supabase's public production CA for verified TLS connections to
`db.<project>.supabase.co` and `<region>.pooler.supabase.com` database hosts.
The additional CA is scoped to these database connections; Node's default trust
is retained, and global TLS trust is unchanged. Other hosts keep default trust.
Certificate-chain and hostname verification remain mandatory.

`HERBIE_DATABASE_CA` (or `HERBIE_DATABASE_CA_FILE` outside Actions) explicitly
replaces the automatic CA selection. An incorrect override fails closed; it is
not silently ignored. The bundled certificate is public vendor material, not a
credential or a project identifier. Its official source and SHA-256 fingerprint
are recorded in `packages/service/src/supabase-ca.ts`; it expires April 26, 2031.
When Supabase rotates this CA, verify the replacement against the official
[dashboard download](https://supabase.com/docs/guides/platform/ssl-enforcement)
before updating the certificate and fingerprint test.


### Owner-only access

Set the private production environment secret `HERBIE_ALLOWED_GITHUB_USER_ID`
before deploying this version. Obtain the immutable numeric ID from the owner's
authenticated GitHub profile; do not use a login name or publish the ID in code,
documentation, logs, or fixtures. No additional GitHub permission is needed.
Preflight and live startup fail closed if this setting is missing or malformed.

Only that account can complete browser OAuth or CLI consent, retrieve a completed
CLI login token, use an existing cookie/bearer session, or release a stored GitHub
credential to a worker. The account ID is checked on every authenticated request,
so existing sessions belonging to another account stop working once the new
service revision is active. A GitHub login rename does not change access. Old
session/credential records are not deleted. Demo authentication remains local and
unchanged; public assets, health, and signed GitHub webhooks retain their existing
access rules. Deployment readiness must confirm the new container revision before
considering the restriction active.
