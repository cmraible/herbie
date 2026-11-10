# Operations and recovery

`GET /api/health` checks database connectivity. Application logs include run ID, stage, and a controlled error code; they deliberately omit SDK error objects, which may contain credentials. The run detail and `run_events` preserve the activity trail. Never paste tokens or raw provider responses into run events.

## Restarts

The API can restart independently. Accepted work is already in Postgres. Stop the worker gracefully before upgrades and wait for its active run to finish (Compose allows 30 minutes). Never start a replacement against the same run while the previous process may still be writing.

An expired lease becomes `needs_attention`. It is never re-executed automatically. Unknown cleanup blocks claiming new runs globally to avoid accumulating orphan sandboxes. New queued submissions remain durable while the operator investigates.

## Publication recovery

1. Stop the worker and confirm its process has exited. Inspect the run row and the GitHub branch `bot/run-RUN_ID` and any PR created from it. Do not delete or reset a branch to bypass a mismatch.
2. Recovery is eligible only when an artifact was saved and sandbox deletion was confirmed. It rechecks user/App authorization, recreates the same deterministic commit, and reconciles existing branch/PR state. It never calls the coding agent.
3. Run the operator command with the same environment:

```sh
node --env-file=.env packages/service/dist/main.js recover-publication RUN_ID
```

For Compose, stop the worker first and run `docker compose run --rm worker recover-publication RUN_ID`. A mismatch or uncertainty remains `needs_attention`. Restart the worker after inspection/recovery.

## Sandbox cleanup

Inspect `sandbox_id` in the run row. If launch acknowledgement was lost, find the sandbox by its deterministic name `prompt-to-pr-RUN_ID` or `runId` label in E2B. Delete it and confirm absence through the provider. The configured maximum lifetime is a fallback, not proof of deletion.

After confirming the original worker is stopped and the sandbox is absent, record `cleanup_complete=true` for that specific run through an operator database transaction. Keep `needs_attention` until publication is reconciled or the run is deliberately abandoned; do not change it to `queued`. If no artifact exists, submit a new run after cleanup and investigation. Never manually manufacture an artifact or a PR-success record.

## Known limitations

- Only one active run globally; up to five queued/active runs per user.
- A failed check can still produce a draft PR with the failure disclosed. PR creation does not mean checks passed.
- An interrupted coding session requires manual inspection; the MVP does not resume the agent.
- Changes larger than 8 MiB, workflow-file changes, and invalid artifacts fail before publication.
- GitHub App/user access is rechecked for every new execution and publication.
- Bounded, redacted command diagnostics are stored privately in `runs.failure_diagnostic`. Public run events show controlled messages only.
- Back up the database and auth secret together. Losing the auth secret requires users to reconnect GitHub.
