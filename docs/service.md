# Durable service operations

The shared `@herbie/contracts` package contains browser-safe schemas and the API
client. `@herbie/service` owns Postgres, authentication, the HTTP API and worker.
`@herbie/cli` and `@herbie/web` depend only on contracts. Repository commands run
inside disposable Daytona sandboxes. The host publisher uses a bare Git index,
never a checkout, and never runs generated code or repository hooks.

## Behavior and recovery

One active goal per repository is enforced globally by a database unique index.
Each goal allows 1–5 attempts. An attempt that creates a PR waits for review;
merging it queues the next attempt up to the limit. Closing it without merging
stops the goal. The final merge completes the goal. The service does not infer
that the entire open-ended prompt is solved: the limit is an explicit work budget.

The API and worker run independently. Start one or more worker processes against
the same database. Transactional claims use row locks, ownership leases and fenced
writes. The worker renews ownership during work. A lost lease cannot authorize a
second attempt or overwrite another worker's decision.

- Queued jobs survive client, API and worker restarts.
- Pause/cancel during a running attempt records a visible request. The bounded
  sandbox attempt finishes and performs cleanup; pause retains the verified
  artifact, cancel discards it. Cancellation is not immediate sandbox termination.
- Paused saved artifacts resume at publication without another model run.
- Once publication begins, pause/cancel returns a conflict until its outcome is
  known. Canceling a goal with a known open PR stops future work; it does not close
  or delete that PR on GitHub.
- An expired lease during sandbox execution becomes `needs_attention`. Herbie
  cannot prove that the remote work or cleanup finished, so it never repeats it.
- Publication intent and its unique branch are durable before external writes.
  Following a lost response or crash, the worker only looks up the existing PR.
  It never blindly repeats publication. A found PR is adopted once; an uncertain
  branch without a PR stays `needs_attention` and is checked again every minute.
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

Demo rows and sessions are separate from live work by mode. Prefer a separate
Postgres database for production; the sample password and fixed demo encryption
key are only for local demo. Keep the database and encryption key together in
backups. HTTP bodies are bounded; goal prompts are limited to 8,000 characters,
commands to 30 arguments and attempts to five. Existing Daytona deadlines and
observed token-cost cutoff remain in force; the cutoff is not a hard spending cap.

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
   Set `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   `GITHUB_PRIVATE_KEY_FILE`, and `GITHUB_WEBHOOK_SECRET` on the trusted service.
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
   supervisor. Sign in through the web UI or `pnpm cli login --url https://YOUR-HOST`.
   Independently approve a small live test and its spend before starting it.

GitHub OAuth access tokens are encrypted in Postgres; session tokens are hashed.
Sessions and user authorization expire within eight hours in this slice; login
again before new work. Automatic OAuth refresh is follow-up work. A job that
cannot reauthorize enters attention rather than performing writes. Reconciliation
of existing PRs remains independent of client sessions. Git write/API tokens are
minted per publication, limited to one repository, and kept server-side in child
process environment only. No global Git credential helper or identity is changed.
The coding sandbox receives no GitHub write credential.

GitHub documentation: [App user access tokens and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[user-accessible installation repositories](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-user-access-token).

## Verification

```sh
pnpm build
pnpm typecheck
HERBIE_TEST_DATABASE_URL=postgresql://herbie:herbie-local-only@127.0.0.1:55432/herbie pnpm test
# With demo API and worker running, in a dedicated disposable demo DB:
pnpm --filter @herbie/web exec playwright install chromium
HERBIE_E2E_URL=http://127.0.0.1:8787 pnpm test:web
```

The database integration suites create isolated schemas and remove them afterward.
Without `HERBIE_TEST_DATABASE_URL`, database tests explicitly skip; that is not a
full verification run. Browser E2E uses a dedicated demo service, cancels active
demo goals to isolate scenarios, and saves screenshots in the web test-results
folder. It must not target a live or shared demo instance. These tests do not call
paid services. The older `pnpm test:e2e` and `pnpm test:daytona` are separate opt-in
live smokes; do not run them as part of routine checks.

Next increments: approved live integrated validation; operator recovery for
ambiguous external outcomes; automatic OAuth refresh; same-PR review repair;
private-repository read transport; deployment supervision, retention, rate limits
and health/queue observability. The current webhook handler reconciles all pending
review PRs, appropriate for a small first deployment; narrow it by repository as
volume grows.
