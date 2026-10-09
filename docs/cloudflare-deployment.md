# Cloudflare and Supabase deployment

The deployment uses a Worker named `herbie-service` in an operator-selected
Cloudflare account and a separate Supabase project. Supply account, application
origin, repository, project and GitHub App identifiers through private GitHub
`production` environment secrets, as described in [GitHub Actions](github-actions.md).
Examples in these runbooks use synthetic placeholders that must be replaced
privately before deployment.

```mermaid
flowchart LR
  Clients[Web and CLI] --> Edge[Cloudflare Worker / React assets]
  Edge --> DO[Named Durable Object]
  Cron[One-minute Cron] --> DO
  DO --> Node[One trusted Node API + worker container]
  Node --> PG[Private Supabase Postgres schema]
  Node --> GH[GitHub App API / native Git publication]
  Node --> Daytona[Disposable Daytona coding sandbox]
```

The Worker handles ingress and static assets. The API and worker remain ordinary
Node processes in a Linux container with native Git. Workers' Node compatibility
does not provide a general host process environment for the existing publisher.
The trusted API and publisher share one container; neither executes generated
code. GitHub write tokens stay there, outside Daytona. Repository tests still run
only in disposable Daytona sandboxes.

The container uses the current native `ctx.container` API with the **default**
scheduling policy, one `basic` instance, and a fixed `herbie` Durable Object name.
There is no per-user container fleet or second durable job queue. All goals,
leases, sessions, artifacts and publication intent remain in Postgres.

## Lifecycle and the execution gate

`HERBIE_EXECUTION_ENABLED` defaults to `false` in live service configuration and
is checked into Wrangler as `false`. Both ingress and the authenticated Node API
reject new goals/resume. The hosted worker is not started, and execution adapters
cannot call Daytona or publish. GitHub sign-in, reads, pause/cancel, and review
webhooks remain available once their configuration exists. Daytona credentials
are not required while execution is disabled. There is no fallback to a public
demo or simulated live success.

When enabled, the independent one-minute Cron calls `ensureRunning` on the same
Durable Object, starts a stopped container, and waits for API/database readiness.
A ten-minute inactivity timeout is set after start and restored when the Durable
Object restarts. Database polling alone is not assumed to keep the container
alive. Closing every browser/CLI does not stop supervision. Startup/readiness
failures fail the scheduled invocation with sanitized logs; the next Cron retries.
When disabled, Cron is a no-op, so an unused container can sleep.

Containers may stop during host failures or rollouts. Disk is ephemeral: it holds
only temporary bare Git publication files. SIGTERM stops new claims and HTTP
acceptance while the active bounded attempt finishes cleanup. The platform can
still terminate it before cleanup finishes. Expired leases preserve the existing
`needs_attention`/read-only publication reconciliation rules; they never imply a
paid attempt should be repeated automatically.

Container environment variables are a startup snapshot. Changing Worker secrets
or the execution flag does **not** update an already-running process. Before a
rotation/update: disable new work at ingress, pause all nonterminal goals,
including those awaiting review, and wait for active work/publication to settle.
For a configuration-only change, increment the non-secret `HERBIE_RUNTIME_REVISION`
in Wrangler's `image_vars`; its Docker image label forces a changed image rather
than a no-op deployment. Deploy with `--containers-rollout=immediate`, wait for
replacement to finish, then verify `/api/health` reports the intended execution
state before resuming goals. Deployment success only means the rollout started.
Do not treat a flag
change as cancellation of an attempt already in flight. Keep the credential
encryption key stable unless performing a separately planned data migration.

## Required resources and approved handoff

1. A separate Herbie Supabase project in an operator-selected organization, with a
   suitable region, connection allowance, backup and availability policy. Follow
   [private database setup](supabase.md). Keep `herbie` out of exposed schemas;
   disable the Data API if nothing else uses it. No browser Supabase key is needed.
2. Workers Paid eligibility and budget approval in the selected Cloudflare
   account. Resources are one Worker/assets deployment, its Durable Object
   namespace, one container application/image, and one Cron trigger. No custom
   DNS zone, Hyperdrive, D1, R2, Queue, or external VM is required for this slice.
3. A trusted PostgreSQL owner connection using the actual Supavisor **session**
   endpoint on port 5432, with URL-encoded password and verified TLS. Supply the
   downloaded CA certificate if required. The runtime pool is bounded to five.
4. Approved GitHub App ID, client ID, client secret, private key and webhook
   secret. Callback: `<HERBIE_PUBLIC_URL>/api/auth/callback`.
   Webhook: `<HERBIE_PUBLIC_URL>/api/webhooks/github`. Replace the origin placeholder
   with the exact private `HERBIE_PUBLIC_URL` value.
   Installation scope/permissions are described in [service operations](service.md).
5. A stable 32-byte base64 credential-encryption key. Store it and the database
   backup together in the operator's secret/backup system.
6. Only before enabling execution: approved Daytona API key, the existing
   organization OpenAI secret **name**, optional approved API URL/snapshot, and
   a separately approved bounded live run. No raw OpenAI key goes into this bundle.

Cloudflare deployment access needs Workers script/secret deployment, Durable
Object and Container application/image management, and the account's Workers
subdomain. Supabase setup needs project creation/configuration plus the trusted
database owner connection; advisors and exposed-schema settings need verification
on that project. GitHub App registration, installation and OAuth grants are
separate user actions. This repository does not create any of those credentials.

## Configure and deploy after review and approvals

Production deployment uses [GitHub Actions](github-actions.md). That runbook
supersedes desktop login or manual secret-upload steps and describes the protected
environment, scoped token, runtime inputs and initially manual release gate.

Use Node 24, Docker and the pinned workspace pnpm/Wrangler versions. Build/test
before deployment:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
HERBIE_TEST_DATABASE_URL=postgresql://herbie:herbie-local-only@127.0.0.1:55432/herbie pnpm test
pnpm --filter @herbie/cloudflare check:deploy
```

The dry run also builds the local container image. It does not upload the image
or deploy resources. The Docker context is an allowlist; `.env`, private files,
Git metadata, tests, and unrelated workspaces are excluded. The final image runs
as user `node`, contains native Git and production dependencies, and has no
Wrangler, Vite, TypeScript compiler or Playwright.

Prepare an operator-owned JSON file outside the repository using
[the example shape](deployment-runtime.example.json). Replace every placeholder;
remove the CA field if system trust is sufficient. PEM newlines must be JSON
escaped. The one Worker secret `HERBIE_RUNTIME_SECRETS` carries this bundle.
Only an explicit allowlist is forwarded to the container. Never print its value,
pass it in arguments, or use Docker build arguments for secrets. The image revision
is a public rollout marker and must never contain secret material.

After the exact account, resource creation, credential transfer and deployment
are approved, supply the individual GitHub `production` environment secrets and
dispatch the workflow from `main`. Identifying fields belong in secrets even when
they are not authentication credentials. The nonidentifying repository variable
`HERBIE_DEPLOY_MODE` controls the release mode. The deployment helper constructs
this bundle privately and passes a secrets file to Wrangler during the full
deployment. No desktop authentication is required.

Keep execution disabled for the first deployment. Complete GitHub App setup and
verify login, account/repository permissions, private database access, advisor
results, and disabled start/resume responses. A missing secret/configuration
returns a service-unavailable response; serving the static UI alone is not a
successful functional deployment.

Before enabling, add `DAYTONA_API_KEY` and `HERBIE_DAYTONA_OPENAI_SECRET` to the
secret bundle (optional `DAYTONA_API_URL` and `HERBIE_DAYTONA_SNAPSHOT`), update
the operator flag to `true`, and perform the controlled restart described above.
Verify health, Cron supervision and the approved bounded attempt. Use
`wrangler deploy` for Containers; `wrangler versions upload` is not the rollout
path for this fixed-image configuration.

## Logs, costs and verification limits

Invocation logs and traces are disabled because OAuth callback/polling URLs can
contain sensitive values. Application logs contain only sanitized lifecycle and
availability messages, not raw errors, request URLs, headers or environments.
Review other account-level logging/export products separately. Removing identifiers
from the current repository tree does not erase Git history, prior logs, workflow
artifacts or previously published copies. Historical cleanup is a separate operator
decision.

At the published October 2026 prices, one continuously running `basic` instance
(1 GiB RAM, 4 GB disk) uses approximately **$11.93 per 30-day month**, including
the $5 Workers Paid plan and available memory/disk allowances. CPU, egress,
other Workers/DO/log usage, Supabase, Daytona and model costs are additional.
This estimate is not a spending cap. Initial disabled execution lets idle
containers sleep; enabled supervision intentionally favors reliable job progress
over idle scale-to-zero. Billing eligibility and spending approval must be checked
before deployment.

Local tests cover real PostgreSQL privilege isolation, gated execution, hosted
shutdown/restart, Docker API/worker behavior, and real workerd routing/disabled
Cron behavior. Local Docker/workerd checks do not prove remote Cloudflare startup,
Supabase TLS connectivity, live GitHub OAuth or paid Daytona execution. Those are
explicit post-provisioning acceptance checks.

Sources checked: [Container API](https://developers.cloudflare.com/containers/api/durable-object-container/),
[scheduling policy](https://developers.cloudflare.com/containers/configuration/scheduling-policy/),
[runtime environment](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/),
[deployments](https://developers.cloudflare.com/containers/guides/deploy/),
[pricing](https://developers.cloudflare.com/containers/platform/pricing/),
[Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/),
[invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
[trace attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/).

### Deployment progress and deadline

The deployment script has one 180-second monotonic deadline covering its current-main
lookup, Wrangler build/upload/rollout, and health verification together. On timeout
it terminates the subprocess group, with up to two additional seconds to force-stop
children that ignore termination. The workflow step has a four-minute outer safeguard;
setup and the full Verify job are separate and are not promised to finish in three minutes.

Public output reports fixed observed build, upload, registry, and container provisioning
stages, plus a command heartbeat every 30 seconds. Tool markers are observations, not
proof that provisioning completed. Health polling reports its first result, then at most
once every 30 seconds, and a final success or failure summary: elapsed time, attempt count,
HTTP status or a fixed error category, and readiness booleans. Success still requires live
mode, execution disabled, and both Worker and image revisions matching the requested release.
URLs, provider identifiers, response bodies, secrets, and raw tool errors remain private;
temporary diagnostics are removed when the script exits. A timeout does not roll back any
provider changes already accepted, and it must not be treated as permission to retry blindly.

Hosted startup failures also emit one fixed diagnostic category: configuration,
database authentication, TLS, connection timeout, or unknown. Categories use trusted
startup phases and recognized structured error codes, never message matching. Errors
without a recognized type/code remain unknown; these labels are evidence, not proof
that a particular credential or infrastructure setting is wrong.
