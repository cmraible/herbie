# Durable service operations

The shared `@herbie/contracts` package contains browser-safe schemas and the API
client. `@herbie/service` owns Postgres, authentication, the HTTP API and worker.
`@herbie/cli` and `@herbie/web` depend only on contracts. Repository commands run
inside disposable Daytona sandboxes. The host publisher uses a bare Git index,
never a checkout, and never runs generated code or repository hooks.

## Behavior and recovery

Multiple active goals may target the same repository.
Goals execute independently and may have multiple PRs open at once. Publication
preserves each artifact's captured tree and original base commit when the default
branch advances. That base must remain in the default branch's history. Repository
CI and PR review validate the changes and their integration with the current base.
Each goal allows 1–5 attempts. An attempt that creates a PR waits for review;
merging it queues the next attempt up to the limit. Closing it without merging
stops the goal. The final merge completes the goal. The service does not infer
that the entire open-ended prompt is solved: the limit is an explicit work budget.

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
  saved verification/cleanup evidence, current owner authorization, and tested-base
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
- Signed GitHub webhooks trigger read-only reconciliation; a 30-second worker poll
  handles missing, duplicate or out-of-order deliveries. Trusted GitHub API reads
  determine merge/close state. Read-only reconciliation uses the App installation
  even after the initiating user's login expires.

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
backups. HTTP bodies are bounded; goal prompts are limited to 8,000 characters,
attempts to five. Existing Daytona deadlines and
cancellation protections remain in force. Herbie does not impose a dollar spending cap.

The agent owns setup and testing in its coding checkout. Herbie captures the patch,
confirms sandbox deletion, and opens a draft PR for repository CI and review; it
runs no separate test command. Artifact downloads are bounded before parsing and
patches are capped at 8 MiB. New artifacts carry version 3 completion and cleanup
evidence, without claiming tests passed. Saved version 2 artifacts remain usable;
artifacts without supported evidence remain ineligible for publication. The old
`test_command` database column is retained as nullable for existing rows, but new
goals no longer use it. The API field `testCommand` and CLI option `--test` have
been removed. Already-published PRs reconcile normally.

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
   read/write**, and **Metadata: read**. Use callback
   `https://YOUR-HOST/api/auth/callback`, webhook
   `https://YOUR-HOST/api/webhooks/github`, and subscribe to Pull request events.
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

GitHub OAuth access tokens are encrypted in Postgres; session tokens are hashed.
Sessions and user authorization expire within eight hours in this slice; login
again before new work. Automatic OAuth refresh is follow-up work. A job that
cannot reauthorize enters attention rather than performing writes. Reconciliation
of existing PRs remains independent of client sessions. Git write/API tokens are
minted per publication, limited to one repository, and kept server-side in child
process environment only. No global Git credential helper or identity is changed.
The coding sandbox receives no GitHub write credential.

CLI login prints a service URL and a one-time terminal code. The GitHub callback
only opens a pending approval page: it does not release a CLI bearer or activate
the pending GitHub credential. The browser shows the account, service, expiry,
and access being granted. Enter the code from your own terminal and choose
**Approve this CLI**, or choose **Reject request**. Approval requires the original
browser cookie, CSRF token, and matching terminal code; wrong codes consume and
reject the request. Pending requests expire after ten minutes and approval/poll
delivery are single use. Do not approve unexpected requests or codes sent by
someone else. This intent check does not prevent a user from being socially
engineered into approving an attacker's terminal.

On upgrade, pending CLI flows created before this consent gate fail closed; start
login again. Already-issued sessions are not automatically revoked by migration.

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
