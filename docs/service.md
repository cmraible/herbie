# Durable service operations

The shared `@herbie/contracts` package contains browser-safe schemas and the API
client. `@herbie/service` owns Postgres, authentication, the HTTP API and worker.
`@herbie/cli` and `@herbie/web` depend only on contracts. Repository commands run
inside disposable Daytona sandboxes. The host publisher uses a bare Git index,
never a checkout, and never runs generated code or repository hooks.

## Behavior and recovery

Goals have a user-editable name (1–120 characters), separate from the execution
prompt. Set it when creating a goal or rename any goal in the web UI or with
`rename GOAL_ID --name TEXT` in the CLI. In live mode, omitted or blank names are
summarized into a few words by an AI model. Live startup requires `OPENAI_API_KEY`
on the service, even when execution is disabled (separate from the Daytona
organization secret). `HERBIE_GOAL_NAME_MODEL` defaults to `gpt-6-luna`.
Naming uses the [OpenAI Responses API](https://developers.openai.com/api/docs/guides/text)
with a 10-second timeout. Provider failures or invalid names fail the create request;
no goal, request record, or job is committed. Resolve the error and retry with the
same idempotency key. Naming runs without holding a database connection. Concurrent retries may each
request a name, but the final transaction rechecks idempotency and commits only
one named goal and one job. Explicit names bypass the model call.
Demo mode generates names deterministically from the brief without calling a model.
Existing goals keep their names. Renaming preserves the original create request
for safe retries and does not change the prompt or start work.

Multiple active goals may target the same repository.
Goals execute independently and may have multiple PRs open at once. Publication
preserves each artifact's captured tree and original base commit when the default
branch advances. That base must remain in the default branch's history. Repository
CI and PR review validate the changes and their integration with the current base.
An attempt that creates a PR waits for review; merging it queues the next attempt.
There is no total attempt limit. Pause or cancel a goal to stop continued work;
closing a PR without merging pauses it so it can be resumed. Failed attempts still stop for attention
rather than retrying automatically. The service does not infer that the entire
open-ended prompt is solved. Previously completed goals remain stopped after upgrade.

The API and worker run independently. Start one or more worker processes against
the same database. Transactional claims use row locks, ownership leases and fenced
writes. The worker renews ownership during work and checks it again immediately
before starting an attempt or publication, after awaited authorization/reconciliation
reads, and again before Git push and GitHub PR creation. Known lease loss
prevents new external calls and stale database writes;
it cannot undo an external call already in flight.

- Queued jobs survive client, API and worker restarts.
- Pause during an attempt lets its bounded work finish and retains the artifact.
- Cancel immediately marks any nonterminal goal cancelled and revokes worker leases,
  without GitHub access or publication reconciliation. Repeat cancellation is safe.
  The active worker observes revocation on its next heartbeat (normally within five
  seconds) and requests sandbox deletion, including during a model command.
  Artifacts and audit history are retained. `cleanupStatus` independently reports
  `not_required`, `pending`, `complete`, or `needs_attention`; missing confirmation
  becomes `needs_attention` after five minutes while the coordinator is running.
  Failed deletion never resumes work. Inspect remaining remote resources manually.
- Paused saved artifacts resume at publication without another model run.
- Once publication begins, pause waits for its outcome; cancellation does not.
  A remote write already in flight may still finish. Its outcome requires attention,
  and any returned PR is recorded without reviving the goal. Existing branches and
  PRs are not deleted or closed by cancellation. No subsequent publication or paid
  attempt is queued for the cancelled goal.
- An expired lease during sandbox execution becomes `needs_attention`. Herbie
  cannot prove that the remote work or cleanup finished, so it never repeats it.
- Publication intent and its unique branch are durable before external writes.
  Following a lost response or crash, the worker looks up the existing PR first.
  A found PR is adopted once. If no PR or attempt branch exists, the worker checks
  saved verification/cleanup evidence, current owner authorization, and original-base
  ancestry before retrying publication of the same artifact. It never reruns the
  model or increments the paid attempt count for publication recovery.
- Publication failures persist a retry counter and deadline in PostgreSQL. Equal
  jitter starts at 30–60 seconds, doubles, and caps at 7.5–15 minutes. Worker restarts
  preserve this schedule. The goal error and events show the reason and next retry
  time. Existing stuck publication jobs enter this path without database edits.
- An existing attempt branch without a confirmed PR, rewritten base history, or
  invalid saved evidence blocks automatic writes with an explicit reason. The
  branch is never overwritten. Transient network/authentication failures keep
  backing off so fixing credentials can recover the saved work automatically.
- Signed GitHub webhooks request reconciliation and CI review for Herbie's tracked
  open PRs. A ten-minute worker poll covers missed deliveries. GitHub rate-limit responses pause requests until the indicated reset (at least one minute). Trusted GitHub API reads
  determine merge/close state and current CI failures; webhook bodies never supply
  agent instructions. Read-only merge/close reconciliation uses the App installation
  even after the initiating user's login expires.
- CI repairs run in a new Daytona agent session at the PR head. Context includes the
  original goal, PR URL, failed checks/statuses, check output, annotations, and failed
  GitHub Actions steps, including checks on GitHub's current test merge commit.
  Repairs wait while checks are pending. The agent reproduces the failure and writes
  verification commands; the sandbox runner executes them after the agent exits and
  rejects missing commands, any nonzero result, or changes to repository files during
  verification. A verified artifact waits durably if CI is rerunning and is resumed
  without a second agent session when the rerun fails. Verification has a ten-minute
  deadline; repair execution allows 32 minutes and uses a 45-minute sandbox TTL.
- After verification and confirmed sandbox deletion, the host saves the patch and
  pushes a child commit to the same PR branch, with an exact-head Git lease. A changed
  head, closed PR, stopped goal, lost worker lease, or unavailable owner authorization
  prevents publication. The agent never receives GitHub write credentials.
- Once current CI passes, the worker marks the tracked draft PR ready for review,
  including PRs that never needed a repair. It rechecks CI, the PR head, owner access,
  and the active goal before the GitHub write. Pending, cancelled, unknown, or absent
  checks or unfinished active check suites leave the PR as draft. Required checks from branch protection and rulesets must appear, including their configured app identity. Merge checks take precedence when present; otherwise head checks are used. Empty suites created for unused apps do not block readiness. Repositories with ruleset-required `workflows` stay draft for manual readiness verification; this release supports named required status checks, not workflow-identity rules. At least one check/status must succeed, with other
  checks successful, neutral, or skipped. Already-ready PRs are left alone.
  Readiness intent is saved before the mutation; retries reconcile an already-ready
  PR and record the confirmation once if the response or event write was lost.
  Intent recovery runs independently of CI eligibility, including closed PRs and
  stopped goals. This
  transition uses the existing Pull requests write permission and launches no model
  session. GitHub's [ready-for-review mutation](https://docs.github.com/en/graphql/reference/pulls#markpullrequestreadyforreview)
  has no atomic expected-head condition; a concurrent external push after the final
  read remains a race. The event feed records confirmed transitions.
- CI polling prioritizes the least recently reviewed PR. Failed reads wait for the
  next periodic poll, so expired credentials cannot monopolize the queue.
- PostgreSQL deduplicates repairs by PR job and head SHA and allows at most three
  sessions per PR. Saved artifacts from expired leases can resume until publication starts. A failed repair or a lease expired during execution/publication stops further automatic repairs for that
  PR; ambiguous pushes are not replayed. A definitive stale-head rejection discards
  the repair without blocking a later head. The goal event feed records repair outcomes,
  and `ci_repairs.artifact` retains captured work. Repairs do not consume another WIP
  slot or create a PR. Pause/cancel stops repair work through its heartbeat. Demo and
  execution-disabled mode do not run repairs. No live model/sandbox validation is
  included in the routine local tests.

For `needs_attention`, inspect the recorded attempt events and GitHub branch,
then verify Daytona cleanup by its recorded sandbox name/ID. There is deliberately
no automatic retry or force-resume control for an uncertain attempt. Stop the
worker before manual database repair. Operator recovery tooling and recovering a
pushed branch that has no PR are follow-up work. Do not use cancellation to imply
that an uncertain external publication was undone.

Automatic recovery is the normal path for an unpublished saved artifact. For
operator-directed recovery after resolving a safety conflict, the authenticated CLI supports
`retry-publication GOAL_ID`. The server checks verification evidence, ownership,
the exact attempt PR and branch, and the original base commit's ancestry before queuing
publication without another model run. An existing branch or rewritten base history returns
a conflict; inspect `logs GOAL_ID` and the remote state before further recovery.
This command does not retry sandbox execution or bypass publication checks.

Demo rows and sessions are separate from live work by mode. Prefer a separate
Postgres database for production; the sample password and fixed demo encryption
key are only for local demo. Keep the database and encryption key together in
backups. HTTP bodies are bounded; goal prompts are limited to 8,000 characters.
Goals have no total attempt limit. Existing Daytona deadlines and
cancellation protections remain in force. Herbie does not impose a dollar spending cap.

The agent owns setup and testing in its coding checkout. Herbie captures the patch,
confirms sandbox deletion, and opens a draft PR for repository CI and review; it
runs no separate test command. Artifact downloads are bounded before parsing and
patches are capped at 8 MiB. New artifacts carry version 3 completion and cleanup
evidence, without claiming tests passed. Saved version 2 artifacts remain usable;
artifacts without supported evidence remain ineligible for publication. The old
`test_command` database column is retained as nullable for existing rows, but new
goals no longer use it. The API field `testCommand` and CLI option `--test` have
been removed. Retries of pre-upgrade requests compare the saved goal using the
current input fields, preserving the original request ID. Already-published PRs
reconcile normally.

## Live setup (operator approval required)

Implementation includes these flows but has not registered an App, created
credentials, installed it, granted OAuth access, deployed a public service, or run
an integrated paid attempt. Before using live mode:

1. Supply an operator-managed Postgres database and a stable 32-byte base64
   `HERBIE_CREDENTIAL_KEY`. Serve the API/web through HTTPS, set the exact origin
   in `HERBIE_PUBLIC_URL`, and configure host/port for the trusted reverse proxy.
   Do not log authorization headers, cookies, callback codes, poll-token queries,
   encrypted credentials, or Git child environments.
2. Register/configure a GitHub App with **Contents: read/write**, **Pull requests:
   read/write**, **Checks: read**, **Commit statuses: read**, **Actions: read**,
   and **Metadata: read**, plus account **Email addresses: read-only** for
   Better Auth GitHub sign-in. Use callback
   `https://YOUR-HOST/api/identity/callback/github`, webhook
   `https://YOUR-HOST/api/webhooks/github`, and subscribe to **Pull request**,
   **Check run**, **Check suite**, and **Status** events. Existing installations must
   accept the added read permissions. These are App-wide subscriptions; Herbie
   filters deliveries to its own saved PRs. See the [GitHub webhook reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
   and [Checks API](https://docs.github.com/en/rest/checks/runs).
   Set the App's **Setup URL** to
   `https://YOUR-HOST/api/auth/installation/callback`. The authenticated web UI
   derives the App slug from GitHub's `/app` metadata and starts installation
   with a short-lived state value. The setup callback checks that the returned
   installation is accessible to the same signed-in GitHub user and has the
   required write permissions. This setup URL is needed for the Connect
   repositories return flow; no additional Herbie secret or app ID setting is
   required. Enable **Redirect on update** so repeat installations and
   permission updates return to Herbie through the same route.
   Set `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   `GITHUB_PRIVATE_KEY_FILE` (or inline `GITHUB_PRIVATE_KEY`), and
   `GITHUB_WEBHOOK_SECRET` on the trusted service.
3. Install the App only on intended repositories. User sign-in separately uses
   the App's OAuth web flow (state, PKCE and browser binding). A user must have
   push permission AND access to an installation with the required permissions.
   The current runner supports **public repositories only**. The repo list hides
   private or inaccessible repositories.
4. Supply the existing `DAYTONA_API_KEY`, optional `DAYTONA_API_URL`, and
   `HERBIE_DAYTONA_OPENAI_SECRET` (an existing organization Secret **name**, never
   the underlying OpenAI secret). Optional `HERBIE_DAYTONA_SNAPSHOT` uses an
   existing approved Ubuntu-compatible snapshot. The Daytona adapter's runtime
   and external provider/network prerequisites are described in the root README.
5. Set `HERBIE_MODE=live`, build, and start the API and worker under a process
   supervisor. Live execution defaults to disabled; login and read operations
   remain available. Daytona configuration is only required once execution is
   enabled. Sign in through the web UI or `pnpm cli login --url https://YOUR-HOST`.
   Independently approve a small live test and its spend, then explicitly set
   `HERBIE_EXECUTION_ENABLED=true` and restart the service before starting it.

For the Node container and private Supabase deployment, follow
[the portable deployment runbook](portable-deployment.md), including draining and
rollout instructions for changes to environment variables.

Live sign-in and sessions use Better Auth with GitHub as the only provider.
Passwords, email registration, and account linking are disabled. Browser and CLI
sessions expire after eight hours without sliding renewal. GitHub access and
refresh tokens are encrypted in Postgres; Better Auth session tokens are stored
in its private database tables. Provider tokens are available only to the server;
Better Auth account and token endpoints are not exposed over HTTP. Better Auth
refreshes GitHub App access tokens when needed and a refresh token is available.
Repository permissions are still checked before execution and publication.
Installation tokens stay server-side and repository-scoped; the coding sandbox
receives no GitHub write credential.

CLI login uses Better Auth device authorization. The CLI prints a service URL
and a terminal code; signing in with GitHub creates a browser session but does
not authorize the CLI. Enter the code from your own terminal and choose
**Approve this CLI** or **Reject request**. Both decisions require a signed-in
owner, exact Origin, browser CSRF cookie/token, and the terminal code. Requests
expire ten minutes after creation. Approval releases a separate CLI session once;
rejection and expiry release none. Codes are never prefilled from a URL. An
invalid code cannot authorize a request; the form can be retried with the correct
code. Do not approve unexpected requests or codes sent by someone else.

When upgrading from custom auth, update the GitHub App callback URL above and
add its email-read permission before switching traffic. Startup migrates the
version-pinned Better Auth tables inside the private `herbie` schema, under an
advisory lock and the existing schema protection. `HERBIE_CREDENTIAL_KEY` derives
a separate Better Auth secret, so no additional secret is required. Existing
custom sessions and pending CLI grants are not accepted: sign in again on web
and CLI. Goals retain their original numeric GitHub owner IDs. Old auth tables
remain for local demo/legacy compatibility; live authentication does not read
those sessions or credentials. Drain old processes before rollout to avoid
mixing authentication versions.

GitHub documentation: [App user access tokens and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[user-accessible installation repositories](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-user-access-token).

## Verification

```sh
pnpm build
pnpm typecheck
HERBIE_TEST_DATABASE_URL=postgresql://herbie:herbie-local-only@127.0.0.1:55432/herbie pnpm test
# With demo API and worker running, in a dedicated disposable demo DB:
pnpm --filter @herbie/web exec playwright install chromium
HERBIE_E2E_URL=http://127.0.0.1:8787 pnpm --filter @herbie/cli test:e2e
HERBIE_TEST_DATABASE_URL=postgresql://herbie:herbie-local-only@127.0.0.1:55432/herbie HERBIE_E2E_URL=http://127.0.0.1:8787 pnpm test:web
```

The database integration suites create isolated schemas and remove them afterward.
Loop tests use local fixture repositories and a fake Codex process, without
Daytona or model calls.
Without `HERBIE_TEST_DATABASE_URL`, database tests explicitly skip; that is not a
full verification run. Browser E2E uses a dedicated demo service, cancels active
demo goals to isolate scenarios, and saves screenshots in the web test-results
folder. CLI consent browser scenarios additionally use an isolated Postgres schema
and local fake GitHub endpoints; these check real HTTP/browser behavior, not a
live OAuth grant. The suite must not target a live or shared demo instance. These
tests do not call paid services. The older `pnpm test:e2e` and `pnpm test:daytona` are separate opt-in
live smokes; do not run them as part of routine checks.

Next increments: approved live integrated validation; operator recovery for
ambiguous external outcomes; automatic OAuth refresh; same-PR review repair;
private-repository read transport; deployment supervision, retention, rate limits
and health/queue observability. The current webhook handler reconciles all pending
review PRs, appropriate for a small first deployment; narrow it by repository as
volume grows.

Publication recovery keeps the latest retry count, next deadline, and failure reference in goal status. The event feed records the first five failures as backoff increases, changed failure causes, safety blocks, and recovery success. Identical failures after backoff reaches its cap do not add more feed entries; every thrown failure remains in server diagnostics. Historical events are retained.
