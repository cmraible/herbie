# First durable slice

HTTP JSON on the same origin as web. Contracts in @herbie/contracts (Zod, source exports). API accepts bearer session or HttpOnly same-site cookie. Mutations with cookie require exact trusted Origin. CLI always bearer. Errors `{error: string}` with 400/401/403/404/409/500. `/api/health` GET unauthenticated returns `{mode:'demo'|'live'}`. No actual credentials in client contracts.

- GET /api/session -> Session; GET /api/repositories -> Repository[]
- GET /api/goals -> Goal[] (owned only)
- POST /api/goals (GoalInput, Idempotency-Key header UUID) -> Goal, 201 or 200 on replay
- GET /api/goals/:id -> Goal; GET /api/goals/:id/events?after=0 -> GoalEvent[]
- POST /api/goals/:id/:action (pause/resume/cancel) -> Goal. Repeat safe; incompatible transition 409.
- POST /api/auth/start {client:'web'|'cli'} -> {url,pollToken?}; web navigate URL. CLI print URL, poll GET /api/auth/poll?token= -> {status,token?}; store received bearer 0600. Web uses cookie.
- GET /api/auth/callback?code=&state= handles server exchange + cookie or browser confirmation for CLI.
- POST /api/auth/logout -> {ok:true}
- POST /api/webhooks/github validates signature then reconciles stored PRs; no credentials/user input trusted from payload.
- POST /api/demo/login -> Session + web cookie (loopback demo only). CLI sends {client:'cli'} returns {token,session}.
- POST /api/demo/goals/:id/merge|close -> Goal for clearly labelled deterministic demo PR.

Execution adapters expose repository authorization, repository listing, a bounded attempt, tested-artifact publication and read-only reconciliation. The live adapter reuses the Daytona runtime and trusted publisher. The deterministic demo is a separate implementation and never emits live verification evidence.

Worker: durable queued work; claim with lease; uncertain interrupted attempt -> needs_attention (no paid automatic retry); publication persisted and reconciled by unique attempt branch before any replay; no duplicate PRs. Existing tested artifact retained in Postgres. Pause/cancel are cooperative: in-flight bounded attempt finishes/cleans sandbox; publication held on pause and discarded on cancel. Once publication starts, controls wait for outcome (409). One active goal per repository globally including paused/review/attention. maxAttempts bounds merge->next cycles. Close unmerged cancels goal. JSON status/events survive clients and API restarts.

First live slice only public GitHub repositories (existing Daytona adapter clones without credentials). GitHub App login proves user identity and repository permission; installation tokens short-lived, server only, restricted to repository. No real registration/grants/provisioning/live use performed during implementation.
