# First durable slice

HTTP JSON on the same origin as web. Contracts in @herbie/contracts (Zod, source exports). API accepts bearer session or HttpOnly same-site cookie. Mutations with cookie require exact trusted Origin. CLI always bearer. Errors `{error: string}` with 400/401/403/404/409/500. `/api/health` GET unauthenticated returns `{mode:'live'}`. No actual credentials in client contracts.

Project routes and event names replace the former goal vocabulary. Update CLI and service together; older CLI releases still call `/api/goals` and cannot use the renamed service routes.

- GET /api/session -> Session; GET /api/repositories -> Repository[]
- POST /api/auth/install/start (signed-in browser) -> GitHub App installation URL; GitHub returns to `/api/auth/installation/callback` with one-use state and an untrusted installation ID that the service verifies against the signed-in user's installations.
- WebSocket /api/stream?project=<uuid> authenticates the browser session cookie and exact Origin. Pushes `{type:"projects",projects:Project[]}` snapshots (version 2, owned only) and `{type:"events",projectId,events:ProjectEvent[]}` batches for an optional owned project. Connections replay the current snapshot and all event pages; clients deduplicate event IDs after reconnect. PostgreSQL commit notifications carry changes between API and worker processes. Session checks, ping/pong heartbeats, and bounded output queues close expired or unhealthy connections.
- GET /api/projects -> Project[] (owned only)
- POST /api/projects (ProjectInput, Idempotency-Key header UUID) -> Project, 201 or 200 on replay
- GET /api/projects/:id -> Project; GET /api/projects/:id/events?after=0 -> ProjectEvent[]
- POST /api/projects/:id/:action (pause/resume/cancel) -> Project. Repeat safe; incompatible transition 409.
- POST /api/auth/start {client:'web'|'cli'} -> {url,pollToken?,userCode?}; web navigate URL. CLI prints URL and terminal code, then polls GET /api/auth/poll?token= -> {status:'pending'|'complete'|'expired'|'rejected',token?}; bearer appears only after explicit approval and is delivered once. Store received bearer 0600. Web uses cookie.
- GET /api/auth/callback?code=&state= dispatches to the Better Auth GitHub OAuth callback while preserving the registered App callback URL. Web login completes at /api/identity/complete and sets the Herbie session cookie. CLI login returns to /api/auth/cli with a browser session; no CLI bearer is issued yet.
- GET /api/auth/cli -> sign in if needed, then server-rendered approval form with account/service/expiry context. POST /api/auth/cli requires an owner browser session, exact Origin, CSRF cookie/token, form decision approve/reject, and terminal code. Invalid codes authorize nothing. Reject/expiry release no bearer. Codes are not included in the OAuth URL or displayed by the form.
- POST /api/auth/logout -> {ok:true}
- POST /api/webhooks/github validates signature then reconciles stored PRs; no credentials/user input trusted from payload.

Execution adapters expose repository authorization, repository listing, a bounded attempt, completed-artifact publication and read-only reconciliation. The live adapter reuses the Daytona runtime and trusted publisher. Tests inject adapters and never emit live verification evidence.

Worker: durable queued work; claim with lease; uncertain interrupted attempt -> needs_attention (no paid automatic retry); publication persisted and reconciled by unique attempt branch before any replay; saved-artifact publication retries use persisted exponential backoff with jitter, reauthorization, valid completion/cleanup evidence and absent-branch/base-ancestry checks; safety conflicts block writes, transient failures retry without another model run or attempt increment; no duplicate PRs. Existing captured artifact retained in Postgres. Pause is cooperative and holds saved publication. Cancel immediately marks any nonterminal project cancelled, revokes all leases, and retains artifacts; it never requires remote reconciliation. Workers interrupt active sandboxes on lease revocation. The separate cleanupStatus field reports not_required/pending/complete/needs_attention; unresolved remote side effects cannot revive a cancelled project. Only pause/resume wait for publication outcome (409). Multiple active projects may target one repository, including while paused, awaiting review, or needing attention. Publication preserves the original captured tree and base while the default branch advances within the same history. maxWip (default 1) bounds open PRs plus queued/running/unpublished work per project. Attempts run sequentially and fill available capacity after publication and merge, under a project lock, without a total attempt limit. Each job stores its own PR; Project.pullRequests exposes the history, while Project.pullRequest retains the most recently published PR for compatibility. Close unmerged requests a cooperative pause so the project can be resumed; already cancelled, failed, or needs-attention projects retain their state. Published PRs continue read-only reconciliation after cancellation without restarting work. Known remote merge/close outcomes are persisted atomically before scheduling more work. JSON status/events survive clients and API restarts.

First live slice only public GitHub repositories (existing Daytona adapter clones without credentials). GitHub App login proves user identity and repository permission; installation tokens short-lived, server only, restricted to repository. No real registration/grants/provisioning/live use performed during implementation.

Projects accept a repository and prompt, with an optional name and positive integer maxWip (default 1). There is no test-command
input or independent test run. The agent may run tests during its work; repository
CI and human review validate the draft PR. Publication requires matching patch,
repository, completion and cleanup evidence, without asserting tests passed.

Project responses use the legacy shape unless the client sends `X-Herbie-Project-Version: 2`. Version 2 includes `maxWip` and `pullRequests` on every project response (list, status, creation, and controls). The shared web/CLI client sends this header; older servers ignore it, and new clients accept their legacy responses.

`POST /api/projects/:id/retry` recovers failed or interrupted projects from the web Retry
button. Failed/unpublished attempts queue a fresh job with a unique branch under
the project lock, retaining history and respecting maxWip. Concurrent requests while
work is queued or running do not create extra jobs. Expired workers remain fenced.
Saved publication uses the existing `/retry-publication` checks and reuses its
artifact without a new model attempt; publication conflicts never fall back to a
fresh attempt. Retry requires ownership, cookie CSRF protection, enabled execution,
and repository authorization for a fresh attempt. Cancelled/completed/paused projects
cannot be restarted through Retry. Uncertain attempts are not automatically repeated.
