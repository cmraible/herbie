# Service operations

For local installation, follow [setup](setup.md). For hosted deployment, see the
[deployment runbook](portable-deployment.md).

## GitHub App

Install the App on a **public repository** where you have push access. Configure:

- **Permissions:** Contents, Pull requests, and Workflows read/write; Checks, Commit statuses,
  Actions, Issues, and Metadata read. Existing installations must approve all updated permissions.
- **Events:** Pull request, Pull request review, Pull request review comment, Issue comment,
  Check run, Check suite, and Status.
- **Redirect on update:** Enabled. Accept permission changes on existing installations.

Use the hostname from `HERBIE_PUBLIC_URL`:

| Setting      | URL                                                |
| ------------ | -------------------------------------------------- |
| Callback URL | `https://YOUR-HOST/api/auth/callback`              |
| Setup URL    | `https://YOUR-HOST/api/auth/installation/callback` |
| Webhook URL  | `https://YOUR-HOST/api/webhooks/github`            |

Copy the App ID, client ID, client secret, private key, and webhook secret into
`.env`. The webhook secret must match GitHub's setting.

## Project behavior

Postgres preserves jobs and results across restarts. Coding runs in disposable
Daytona sandboxes; GitHub write credentials stay on the Herbie host.

- `maxWip` limits open PRs plus queued/running attempts. Merging a PR frees capacity;
  closing one without merging pauses the project. Projects have no total attempt or dollar cap.
- **Pause** lets an active attempt finish. Saved changes can resume publication
  without another model run.
- **Cancel** stops further work and requests sandbox cleanup. A GitHub write already
  in flight may finish; existing branches and PRs remain.
- Failed attempts stop for attention. CI repairs update the same PR, with at most
  three repair sessions per PR. Failed repairs stop further automatic repair.
- Passing CI can mark a draft PR ready for review and request review from the project owner; Herbie does not merge it. Review requests retry after failures without re-requesting users who are already requested or have reviewed.
  Missing checks or unsupported ruleset-required workflows leave it as a draft.

Human PR comments, inline comments, and submitted reviews trigger a feedback attempt
on the existing PR. The agent decides whether to ignore, reply, or update the code
and reply. Inline replies stay in their original thread. Bot comments provide
conversation context but never trigger attempts. Edits to feedback receive a new
decision; duplicate deliveries and line movements do not. Existing feedback on
tracked open PRs is considered on the first poll after upgrading.

Code updates require successful local verification and confirmed sandbox deletion.
Feedback and CI repair sessions do not run concurrently on the same PR. Paused or
cancelled projects do not process feedback. Feedback failures or expired leases block
further feedback and CI repairs on that PR, with a `pr_feedback_failed` event for
inspection. A failed CI repair also blocks feedback until manually recovered.
Inspect `pr_feedback.artifact`, sandbox cleanup, and remote writes before
manual recovery; uncertain pushes or replies are never automatically replayed.
Completed decisions and replies are recorded in project events and saved artifacts.

Enable the new event subscriptions in the GitHub App settings. GitHub requires
Issues read permission to subscribe to [Issue comment events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment);
existing installations must accept that permission update. PR comment API writes
use the existing Pull requests write permission.

Signed webhooks trigger PR/CI/feedback reconciliation; a ten-minute server poll covers missed events.
The browser receives project, PR, and run-event updates over `/api/stream` WebSockets
without polling. Reverse proxies must forward WebSocket upgrades. Each API process
uses one PostgreSQL LISTEN connection from its pool, requiring a direct or session-pooled
database connection. After a disconnect, the browser reconnects with backoff and
receives a fresh snapshot plus event history.
GitHub-only sign-in uses Better Auth. Browser and CLI sessions expire after eight
hours; provider tokens refresh when a refresh token is available. For CLI login,
approve only the code shown in your own terminal.

When upgrading from custom auth, drain old processes and sign in again on web and
CLI. Existing callbacks, App permissions, and `HERBIE_CREDENTIAL_KEY` remain valid;
startup migrates the auth tables without changing project ownership.

## Recovery

Check the project's events and `docker compose logs herbie` first.

- **Publication failure:** Herbie retries saved changes with backoff, without rerunning
  the model. Fix credentials or connectivity and let recovery proceed. After resolving
  a blocking conflict, `pnpm cli retry-publication PROJECT_ID` requests another checked
  publication attempt; it does not retry sandbox execution.
- **CI repair failure:** The project shows **Retry repair** when environment cleanup
  was confirmed and publication never started. This queues a fresh repair on the
  existing PR and preserves the failed repair's history. Duplicate requests queue
  only one retry. Herbie rechecks the PR and checks before running; changed heads
  pause the project, and passing checks discard the queued repair. Paused projects
  must be resumed first. Failures with unknown cleanup or a possible push require
  operator inspection. Repairs are not automatically retried.
- **`needs_attention`:** Inspect the GitHub branch/PR and verify Daytona cleanup using
  the recorded sandbox ID. Uncertain execution or cleanup is not retried automatically.
  Cancellation does not prove cleanup succeeded or undo remote writes.

Pause projects and let active attempts finish before restarting. Keep the database and
`HERBIE_CREDENTIAL_KEY` together in backups. Stop the service before manual database repair.

## Verification

Run `pnpm verify`. It provisions disposable databases and test services without paid
model or Daytona calls. See [CI verification](github-actions.md) for requirements
and logs; live integrations still need a separate smoke test.
