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
  Edge --> Router[Durable release router]
  Cron[One-minute Cron] --> Router
  Router --> Node[Active Node API + worker container]
  Router -. readiness checks .-> Candidate[Candidate release container]
  Candidate --> PG
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

The native `ctx.container` API uses a release-specific Durable Object and the
**durable_object** scheduling policy. Cloudflare does not replace these instances
when a Worker/image map is deployed. A separate router stores the active release
in Durable Object storage. It warms the candidate in the background and commits a
new route only after live API/database readiness, execution mode and both release
identities match. Requests continue using the previous route during startup or
startup failures. A deployment that never becomes ready retains the old route.

This scheduling policy is a Cloudflare public beta. It cannot be enabled on the
existing application in place, so the migration retains the original `basic`
application as a fallback and creates a new application/namespace. Before every
production deployment, the helper reads and pins the original application's
existing image digest; it refuses deployment if that image cannot be identified.
The old process is never destroyed because Worker variables changed.

New releases use `standard-1`: `basic` is unavailable with this policy. Expect a
higher steady instance cost plus overlap during deployment; reassess the existing
$20/month incremental hosting budget before rollout. There is one active API
instance, a candidate during startup, and retired instances during shutdown.
This is deployment availability, not host-failure replication or a per-user fleet.
Postgres remains the source of truth for all goals, leases and publication intent.

Candidate cleanup is recorded durably before preparation begins. Candidates that
never promote receive SIGTERM after 25 minutes and are forcefully retired after
another 15 minutes, including deletion of stored launch credentials. Restarted
Durable Objects restore the serving container inactivity timeout immediately.

After promotion, the old release remains untouched for one minute to allow
requests that already selected it to finish. A persistent alarm then sends SIGTERM,
which stops new claims and HTTP acceptance while active work drains. After another
15 minutes the alarm forcefully retires any remaining process and removes its
stored launch credentials. The candidate and old worker can briefly overlap;
transactional job claims (`FOR UPDATE ... SKIP LOCKED`) and lease fencing prevent
them from claiming the same job. Never revoke a retiring worker's credentials
before its active external work has settled.

The launch image digest and exact runtime environment are retained in encrypted
Durable Object storage so a restarted old release can still serve its own image
and settings. Launch credentials are deleted when that release is retired.
Do not roll back to the old singleton Worker: it bypasses the persisted active
route and may restart the legacy container. Roll back code by reverting a commit
and deploying it as a new, readiness-checked release through the same router.
Assets and Worker code activate before the API handoff, so API/schema changes
must support both adjacent versions. Destructive schema changes need a separate,
backwards-compatible migration plan.

## Lifecycle and the execution gate

`HERBIE_EXECUTION_ENABLED` defaults to `false` in live service configuration and
is checked into Wrangler as `false`. Both ingress and the authenticated Node API
reject new goals/resume. The hosted worker is not started in the new release, and execution adapters
cannot call Daytona or publish. GitHub sign-in, reads, pause/cancel, and review
webhooks remain available once their configuration exists. Daytona credentials
are not required while execution is disabled. There is no fallback to a public
demo or simulated live success.

The independent one-minute Cron keeps the active API warm regardless of the
execution flag and retries candidate startup. Execution stays gated independently.
A thirty-minute inactivity timeout allows retiring workers to finish shutdown.
A slow or failed candidate is logged without interrupting requests to the active
release. Failure of the active service fails the scheduled invocation; no success
response is fabricated.

Containers may still stop during host failures. Disk is ephemeral: it holds
only temporary bare Git publication files. SIGTERM stops new claims and HTTP
acceptance while the active bounded attempt finishes cleanup. The platform can
still terminate it before cleanup finishes. Expired leases preserve the existing
`needs_attention`/read-only publication reconciliation rules; they never imply a
paid attempt should be repeated automatically.

Container environment variables are a startup snapshot. Changing Worker secrets
or the execution flag does **not** update an already-running process. Before a
rotation/update: disable new work at ingress, pause all nonterminal goals,
including those awaiting review, and wait for active work/publication to settle.
For a configuration-only change, deploy through the GitHub workflow. Every
run/attempt already creates a unique image/release identity. The new process is
warmed beside the old one, and `/api/health` confirms the handoff. Deployment
success requires the new route to be ready, not merely a successful image upload.
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
   release router and container namespaces, the retained legacy application, a
   release-managed container application/images, and one Cron trigger. No custom
   DNS zone, Hyperdrive, D1, R2, Queue, or external VM is required for this slice.
3. A trusted PostgreSQL owner connection using the actual Supavisor **session**
   endpoint on port 5432, with URL-encoded password and verified TLS. Recognized
   Supabase database hosts use the bundled public Supabase CA unless an explicit
   CA override is supplied. The runtime pool is bounded to five.
4. A private `HERBIE_ALLOWED_GITHUB_USER_ID` setting containing the verified
   immutable numeric ID of the sole permitted GitHub owner. Live startup fails
   closed without it; nonowner OAuth, CLI grants and existing sessions are denied.
5. Approved GitHub App ID, client ID, client secret, private key and webhook
   secret. Callback: `<HERBIE_PUBLIC_URL>/api/auth/callback`.
   Webhook: `<HERBIE_PUBLIC_URL>/api/webhooks/github`. Replace the origin placeholder
   with the exact private `HERBIE_PUBLIC_URL` value.
   Installation scope/permissions are described in [service operations](service.md).
6. A stable 32-byte base64 credential-encryption key. Store it and the database
   backup together in the operator's secret/backup system.
7. Only before enabling execution: approved Daytona API key, the existing
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
omit the optional CA field to use automatic certificate trust (including the
scoped Supabase CA fallback). An explicit CA replaces that selection. PEM newlines
must be JSON escaped. The one Worker secret `HERBIE_RUNTIME_SECRETS` carries this bundle.
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

Hosted startup now reports fixed phases separately: configuration, database connection,
private-schema protection, application migrations, authentication migrations, schema
verification, authentication setup, adapter setup and HTTP listen. Each transition and
failure includes monotonic elapsed times. A code-less database driver failure is still
identified as a database connection failure by its phase. Only allowlisted SQLSTATE,
network, TLS and local guard codes from up to four causes are printed; messages, stack
traces, hostnames and connection values remain private. Cleanup errors cannot replace
the first startup error.

The hosted process has a separate 60-second startup watchdog, with a pending-phase
summary every ten seconds. If startup or failed-start cleanup stalls, it reports the
pending phase and exits nonzero, closing database sockets so uncommitted transactions
can roll back. This does not replace or extend the deployment script's shared 180-second
deadline. The watchdog is removed once the HTTP service is ready.

### Restricted runtime failure details

Service failures emit a structured `herbie_failure` record to container stderr.
In the Cloudflare dashboard, use the application's container/runtime logs (Workers
Observability, `containers` dataset) and search for the reference UUID shown in the
goal error or `diagnostic_reference` event. The record correlates component, goal,
job, and stage with the original error stack, nested causes, aggregate failures,
and available command output, exit code, signal, or HTTP status. These records are
not returned by the API or written to deployment/GitHub Actions logs by the service.
Local development writes the same records to its service terminal. Both uploaded
sandbox runners share this redactor and send a bounded failure record through the
command result to the host logger, preserving nested causes even when SDK stderr
is unavailable. Sandbox environment credentials (including OPENAI_API_KEY) and
the supplied goal text are redacted before transport; the host redacts again.
Completed test failures retain both stdout and stderr in restricted diagnostics.

Known configured credentials and encountered GitHub tokens are redacted, along
with authorization/cookie fields, PEM material, credential assignments, token
patterns, URL credentials and URL queries. Full environment, request, configuration,
and header objects are omitted. Logs have bounded depth, item counts, field lengths,
and a 32 KiB record limit. Treat retained logs as restricted operational data: they
can still contain repository paths and redacted command output. Existing provider
access controls and retention apply; this change configures neither export nor a
new retention period. Do not paste production records into public issues or CI logs.

Attempt stages are persisted before sandbox setup, uploads, cloning, model execution,
testing, downloads, and deletion. Stage reporting has a five-second ceiling; a
reporting failure aborts further attempt work but cannot bypass deletion. The safe
goal error identifies the failed stage, fixed error category, optional numeric
HTTP/exit status, cleanup confirmation, and log reference. Original sandbox/model
operation deadlines and no-retry behavior remain unchanged. Historical failures
whose causes were discarded cannot be reconstructed by these new diagnostics.

The catch-boundary audit covers worker/heartbeat/reconciliation/publication failures,
HTTP and health errors, startup/pool/shutdown errors, and discarded rollback/cleanup
errors. Publication aggregate causes already retain Git stderr and signal metadata;
the worker now logs them through the same redactor. Expected control flow (invalid
client JSON, missing GitHub branches, and aborted polling delays) remains distinct
from an unexpected service failure.
