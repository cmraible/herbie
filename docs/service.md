# Service operations

For local installation, follow [setup](setup.md). For hosted deployment, see the
[deployment runbook](portable-deployment.md).

## GitHub App

Install the App on a **public or private repository** where you have push access. Configure:

- **Permissions:** Contents, Pull requests, and Workflows read/write; Actions, Checks, and
  Commit statuses read; Issues write; Metadata read. Existing installations must approve all
  updated permissions.
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

- `targetWip` sets the desired number of open PRs plus queued/running runs. Polling replenishes missing work;
  closing one without merging pauses the project. Projects have no total attempt or dollar cap.
- **Pause** lets an active attempt finish. Saved changes can resume publication
  without another model run.
- **Cancel** stops further work and requests sandbox cleanup. A GitHub write already
  in flight may finish; existing branches and PRs remain.
- Failed attempts stop for attention. CI repairs update the same PR, with at most
  three repair sessions per PR. Failed repairs stop further automatic repair.
- Passing CI can mark a draft PR ready for review and request review from the project owner; Herbie merges after the project owner approves the current head and CI passes. Review requests retry after failures without re-requesting users who are already requested or have reviewed.
  Missing checks or unsupported ruleset-required workflows leave it as a draft.

Human PR comments, inline comments, and submitted reviews trigger a feedback attempt
on the existing PR. The agent decides whether to ignore, reply, or update the code
and reply. Inline replies stay in their original thread. Bot comments provide
conversation context but never trigger attempts. Edits to feedback receive a new
decision; duplicate deliveries and line movements do not. Existing feedback on
tracked open PRs is considered on the first poll after upgrading.

Herbie adds an 👀 reaction when it starts processing a human conversation or inline
comment, before starting the agent. Submitted reviews do not support reactions.
Reaction failures are logged without blocking the response. Enable **Issues write**
permission and approve the installation update for conversation-comment reactions.

Code updates require successful local verification and confirmed sandbox deletion.
Feedback and CI repair sessions do not run concurrently on the same PR. Paused or
cancelled projects do not process feedback. Feedback failures or expired leases block
further feedback and CI repairs on that PR, with a `pr_feedback_failed` event for
inspection. A failed CI repair also blocks feedback until manually recovered.
Inspect `pr_feedback.artifact`, sandbox cleanup, and remote writes before
manual recovery; uncertain pushes or replies are never automatically replayed.
Completed decisions and replies are recorded in project events and saved artifacts.

Enable the new event subscriptions in the GitHub App settings. GitHub requires
Issues permission to subscribe to [Issue comment events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment);
existing installations must accept that permission update. Conversation-comment reactions
use Issues write; inline-comment reactions use the existing Pull requests write permission.

Signed pull request and pull request review webhooks immediately reconcile only the
affected PR. CI webhooks retain repository-scoped merge reconciliation. Neither waits
for the next poll. Webhooks are acknowledged without waiting
for GitHub API calls; approval, current head, and checks are re-read before merging.
Concurrent events for the same repository and PR are coalesced, retaining a follow-up
read for events received during reconciliation. Different PRs proceed independently;
CI events are coalesced separately by repository. The 30-second PR poll recovers missed events or restarts;
a separate ten-minute poll covers CI repair and feedback. Ensure the App subscribes to
Pull request review, Check run, Check suite, and Status events listed above.
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

## Project environment resources

Project creation and editing accept `resources: { cpu, memory, disk }` (whole CPU cores and GiB), or `null` to use environment defaults. Settings apply to future runs, including repairs and feedback work. The authenticated `/api/environment-limits` endpoint discovers Daytona bounds using the existing API key's `read:limits` permission and caches them for one minute. Custom resources require image-based creation; a configured `HERBIE_DAYTONA_SNAPSHOT` retains its own sizing and rejects overrides. Multiple eligible CPU regions require an explicit `DAYTONA_TARGET`.

Increasing resources changes Daytona consumption and does not extend the agent's execution deadline. The worker checks allocated CPU, memory, and disk before running repository code, and cleans up an environment whose allocation does not match the request.

E2B supports the same numeric project resource fields. Saving a new project or changing its resources builds any missing template through E2B's API before persisting the project or queueing work. The form waits with environment preparation progress; failures leave the draft or existing project unchanged. The shared API client polls preparation and retries the save with a matching ready receipt. Templates are reused for later projects and runs. CPU and memory must match; disk is a minimum capacity. An existing `HERBIE_E2B_TEMPLATE` is optional. See [automatic E2B templates](environments.md#automatic-e2b-templates).

## Run failure diagnostics

New unpublished-run failures save a bounded, redacted diagnostic in `jobs.failure_diagnostic`, in the same transaction as the failure state and activity reference. It includes the matching `errorId`, stage, nested causes, exit status, cleanup evidence, and terminal command output when available. Bootstrap failures add a fixed step label such as `node_installation` or `docker_startup`; stderr is captured alongside stdout. Output is redacted before truncation, retaining its tail so installation progress does not hide the final error.

The detailed record is private database information and is intentionally omitted from project/run API responses and activity. Query it using the run ID or the reference shown in activity:

```sql
SELECT id, failure_diagnostic
FROM herbie.jobs
WHERE id = 'RUN_UUID'
   OR failure_diagnostic->>'errorId' = 'ERROR_REFERENCE';
```

Existing failures remain null; this does not recover deleted environment output. Publication recovery, repair/feedback failure handling, and cancellation retain their existing behavior. A missing or unserializable diagnostic cannot skip failure handling; an unavailable record retains the reference. Runtime logs remain available as the other diagnostic source.
