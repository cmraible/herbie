# First durable slice

HTTP JSON on the same origin as web. Contracts in @herbie/contracts (Zod, source exports). API accepts bearer session or HttpOnly same-site cookie. Mutations with cookie require exact trusted Origin. CLI always bearer. Errors `{error: string}` with 400/401/403/404/409/500. `/api/health` GET unauthenticated returns `{mode:'demo'|'live'}`. No actual credentials in client contracts.

- GET /api/session -> Session; GET /api/repositories -> Repository[]
- POST /api/auth/install/start (signed-in browser) -> GitHub App installation URL; GitHub returns to `/api/auth/installation/callback` with one-use state and an untrusted installation ID that the service verifies against the signed-in user's installations.
- GET /api/goals -> Goal[] (owned only)
- POST /api/goals (GoalInput, Idempotency-Key header UUID) -> Goal, 201 or 200 on replay
- GET /api/goals/:id -> Goal; GET /api/goals/:id/events?after=0 -> GoalEvent[]
- POST /api/goals/:id/:action (pause/resume/cancel) -> Goal. Repeat safe; incompatible transition 409.
- POST /api/auth/start {client:'web'|'cli'} -> {url,pollToken?,userCode?}; web navigate URL. CLI prints URL and terminal code, then polls GET /api/auth/poll?token= -> {status:'pending'|'complete'|'expired'|'rejected',token?}; bearer appears only after explicit approval and is delivered once. Store received bearer 0600. Web uses cookie.
- GET /api/auth/callback?code=&state= handles server exchange + web session cookie, or a pending browser-bound CLI approval cookie and redirect to /api/auth/cli. CLI callback alone creates no usable session or active GitHub credential.
- GET /api/auth/cli -> server-rendered approval form with account/service/expiry context. POST /api/auth/cli requires exact Origin, approval cookie, CSRF token and form decision approve/reject; approval also requires the matching terminal code. Wrong code consumes and rejects the request. Reject/expiry release no bearer. Codes are not included in the OAuth URL or displayed by the form.
- POST /api/auth/logout -> {ok:true}
- POST /api/webhooks/github validates signature then reconciles stored PRs; no credentials/user input trusted from payload.
- POST /api/demo/login -> Session + web cookie (loopback demo only). CLI sends {client:'cli'} returns {token,session}.
- POST /api/demo/goals/:id/merge|close -> Goal for clearly labelled deterministic demo PR.

Execution adapters expose repository authorization, repository listing, a bounded attempt, completed-artifact publication and read-only reconciliation. The live adapter reuses the Daytona runtime and trusted publisher. The deterministic demo is a separate implementation and never emits live verification evidence.

Worker: durable queued work; claim with lease; uncertain interrupted attempt -> needs_attention (no paid automatic retry); publication persisted and reconciled by unique attempt branch before any replay; saved-artifact publication retries use persisted exponential backoff with jitter, reauthorization, valid completion/cleanup evidence and absent-branch/base-ancestry checks; safety conflicts block writes, transient failures retry without another model run or attempt increment; no duplicate PRs. Existing captured artifact retained in Postgres. Pause is cooperative and holds saved publication. Cancel immediately marks any nonterminal goal cancelled, revokes all leases, and retains artifacts; it never requires remote reconciliation. Workers interrupt active sandboxes on lease revocation. The separate cleanupStatus field reports not_required/pending/complete/needs_attention; unresolved remote side effects cannot revive a cancelled goal. Only pause/resume wait for publication outcome (409). Multiple active goals may target one repository, including while paused, awaiting review, or needing attention. Publication preserves the original captured tree and base while the default branch advances within the same history. maxAttempts bounds merge->next cycles. Close unmerged cancels goal. JSON status/events survive clients and API restarts.

First live slice only public GitHub repositories (existing Daytona adapter clones without credentials). GitHub App login proves user identity and repository permission; installation tokens short-lived, server only, restricted to repository. No real registration/grants/provisioning/live use performed during implementation.

Goals accept a repository, prompt and bounded maxAttempts. There is no test-command
input or independent test run. The agent may run tests during its work; repository
CI and human review validate the draft PR. Publication requires matching patch,
repository, completion and cleanup evidence, without asserting tests passed.
