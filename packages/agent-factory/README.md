# Herbie agent factory

A hosted-product foundation with a portable TypeScript coordinator and a locally tested end-to-end goal → PR → feedback repair → merge → next increment loop. The root Herbie controller remains unchanged. **Execution defaults to disabled. Nothing in the test suite needs real provider credentials.**

## Local validation

Use Node 24+ and the repository's `pnpm@10.34.6` (`corepack pnpm` if necessary).

```sh
pnpm install --frozen-lockfile
pnpm --filter @herbie/agent-factory test
pnpm --filter @herbie/agent-factory typecheck
pnpm --filter @herbie/agent-factory test:worker
pnpm --filter @herbie/agent-factory db:migrate
pnpm --filter @herbie/agent-factory dev
```

`test:worker` builds a Worker bundle using `wrangler deploy --dry-run` and runs it in Miniflare with real local D1/SQLite and Durable Objects. `build` never deploys. `db:migrate` is explicitly local. No test provisions a Daytona VM or publishes a GitHub PR. The default UI is at localhost:8787; Google login requires a real configured OAuth client with that origin authorized. Secure cookies are used (localhost browser handling must support secure contexts; hosted setup requires HTTPS).

`pnpm types` inside this package regenerates binding types from Wrangler config. Secrets are named separately in `src/cloudflare/env.ts`. Tests exercise externally visible domain behavior, cryptographic verification, SQL CAS persistence, request isolation and settings permissions.

## Architecture and invariants

- `src/core`: plain TypeScript domain and coordinator, no provider imports. `GoalStore`, `Repository`, and `Execution` have both fake and production adapters. Goal mutations use revision compare-and-swap; a durable lease fences short external-operation ticks. Goals have one active operation at a time, which is stronger than serial work per PR.
- `src/adapters/d1.ts`: authoritative aggregate per goal, atomic revision updates and quota-checked creation. Pending creations count against capacity before external effects. Open PRs replace their reservation atomically. Lowering a target never closes PRs; already reserved work remains counted and can complete.
- `GoalCoordinator`: one Durable Object per goal, persisted wakeup and alarm scheduled before external effects. Alarms poll every 30 seconds; cron sweeps goals and durable webhook inbox every five minutes to repair lost wakeups. UI creation and edits schedule immediate alarms. Provider failures back off and pause after three failures. VM TTL bounds resource lifetime even if cleanup is temporarily unavailable.
- `Factory`: verifies PR state from GitHub (never trusts a webhook merge flag), reserves slots, runs/retries attempts, persists pushed commit checkpoints, cleans up the VM, then publishes/reconciles a draft PR. Closed-unmerged pauses the goal. Three failed/lost/timed-out attempts escalate. Work paused by a human is terminated before its slot is released. Prompt edits affect future reservations only.
- GitHub publication searches a deterministic branch, including closed/merged PRs, before creating anything. A response lost after publication recovers the existing PR. Repairs push to the existing branch and leave a marked progress reply. Delayed CI is accepted only for the actual current head; signed delivery IDs deduplicate feedback. Feedback arriving during PR publication stays in the durable inbox until reconciliation.
- `DaytonaExecution`: pins SDK 0.220.0, uses deterministic VM names per run/attempt, validates both snapshot and sandbox `linux-vm` class, and never resumes a stopped VM as if its processes were alive. Runner process starts use `flock` plus durable started/result markers. Missing/stopped VMs trigger bounded retry; retries clone the pushed branch. A run times out after 30 minutes; VMs have a 45-minute TTL.
- `sandbox/runner.mjs`: Codex executes inside the dedicated VM. It runs Docker preflight, clones, checks out the run branch, executes Codex, commits, pushes and emits a commit checkpoint. Partial unpushed work can be lost with the VM; previous pushed work and coordinator state remain recoverable. No customer code runs on the coordinator.
- A scoped 35-minute run JWT authorizes only an active run/attempt. A Git smart-HTTP proxy enforces the assigned repository and one writable branch; a model proxy permits Responses inference for the configured model with a per-run 200-request ceiling and 16,384 output-token cap. Provider credentials never enter customer code. GitHub tokens are repository-scoped and minted by the coordinator. No ChatGPT subscription or OAuth session is used to fund hosted Codex.

## Hosted setup (requires separate approval to execute)

1. Create a Cloudflare D1 database and replace the placeholder database ID in `wrangler.jsonc`. Set the public HTTPS `APP_ORIGIN`, Google web client ID, GitHub App ID, supported Codex model and Daytona VM snapshot name. Leave `FACTORY_ENABLED=false` until live smoke validation is explicitly approved.
2. Apply the D1 migration to the intended environment. Provision each company via an operator-reviewed transaction: create workspace, independently verify domain control, insert an enabled `company_domains` row with verification time, and assign the designated administrator using their verified Google **sub**. There is deliberately no public claim-domain or become-admin endpoint. New employees with the verified Google `hd` automatically join as `member`. Email suffix alone never grants membership. Existing membership can be revoked by deleting its row; authorization checks current membership on every request.
3. Install a GitHub App for approved repositories with Contents and Pull requests write, Issues write (progress replies), Checks and Actions read, and Metadata read. Configure the signed `/webhooks/github` endpoint for pull_request, pull_request_review, pull_request_review_comment, issue_comment, check_run and workflow_run events. The operator must verify installation ownership and insert the workspace/repo/installation grant; an admin can then enable it in Settings. Installation IDs cannot be supplied through a public connection endpoint. A repository installation grant belongs to exactly one workspace.
4. Configure coordinator secret bindings: `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM, convert locally if the App supplies PKCS#1), `GITHUB_WEBHOOK_SECRET`, `DAYTONA_API_KEY`, `OPENAI_API_KEY`, `RUN_TOKEN_SECRET` (at least 32 random characters). `.dev.vars.example` names them without actual credentials. Never put these in vars, logs, source control, snapshots or sandbox env. Store a service OpenAI API key with a budget; customer ChatGPT sign-in is unrelated to execution authentication.
5. Build `sandbox/Dockerfile` as a Daytona snapshot with **sandboxClass `linux-vm`**, at least 2 CPUs/4 GiB memory and enough disk for actual image builds. Snapshot creation is operator work, never automatic in customer jobs. The image supplies Docker Engine, Compose, Node and pinned Codex. It has no mounted host Docker socket. The job starts a daemon inside its isolated VM if needed.
6. In an approved disposable live test, verify the VM class, run `docker-preflight.sh` (builds an image, runs it, starts a Redis Compose stack, verifies PONG), and exercise private-repo clone, branch-limited push, streamed Codex inference, review/CI repair, merge/close behavior, VM deletion and recovery. Verify the snapshot OS user can run Docker. Pin the snapshot artifact/digest after this test.
7. Only with approval, deploy to an isolated environment, enable the factory and create a goal on an explicitly approved test repo. Initial work starts via immediate alarm; publication is a **draft PR**. Human review and merging remain external.

Company provisioning example (placeholders only; run only after verification):

```sql
BEGIN TRANSACTION;
INSERT INTO workspaces(id,name) VALUES('workspace-id','Company name');
INSERT INTO company_domains(domain,workspace,verified_at,enabled)
VALUES('verified.example','workspace-id',1234567890000,1);
INSERT INTO members(workspace,sub,role) VALUES('workspace-id','verified-google-sub','admin');
INSERT INTO repositories(workspace,repo,installation,enabled)
VALUES('workspace-id','approved-owner/repo',12345,0);
COMMIT;
```

## API surface

Google challenge/sign-in/logout: `/auth/challenge`, `/auth/google`, `/auth/logout`. The Google JWT checks signature, issuer, audience, expiry, nonce, verified email, hosted domain and stable sub. Same-origin JSON mutations and Secure/HttpOnly/SameSite cookies protect browser sessions.

`GET /api/workspaces`; member `GET/POST /api/workspaces/:workspace/goals`, `GET/PATCH .../goals/:id`; member `GET .../repositories`; admin `PATCH .../repositories` and `GET .../settings`. The UI exposes goal prompt, target, pause/resume, PRs, prompt versions, runs and activity. Domain verification, role assignment and provider credentials remain operator-managed. Billing settings show service-managed status and goal quota; members cannot change them.

## Remaining live integration and product gaps

- **Not live-validated:** Daytona VM creation/SDK transport from Workers, Docker daemon startup inside the VM snapshot, the pinned Codex CLI custom-provider/Responses streaming path, Git smart-HTTP behavior against an actual private GitHub App installation, Google browser sign-in, provider cleanup and alarms on deployed infrastructure. Local typecheck/bundle success is not evidence these live paths work. The required Docker preflight is implemented but has not been run in a real Daytona VM in this task.
- Operator-assisted domain/installation verification is deliberate product groundwork; self-service proof, invitation/admin recovery and installation OAuth flows are not implemented. Payment collection, billing portal and metered invoices are not implemented. Billing status, workspace goal quota and per-run model request limits exist, but these are not a monetary spend guarantee. Production needs overall workspace/account spend and concurrency limits.
- CI webhook processing currently supplies failing check/workflow names and the matching commit. It asks Codex to reproduce locally; it does not download full CI logs or post inline review replies. Progress replies are PR conversation comments. Missed review/CI webhooks not delivered to the inbox require GitHub redelivery; periodic reconciliation currently polls PR state, not all review/check history.
- Goal aggregates retain run/event history; split/compact archival storage before long-running high-volume tenants approach D1 row limits. Inbox retention, tenant audit export, broader rate limiting, distributed multi-region contention/load tests and production alerting remain hardening work.
- Failure exceptions are intentionally sanitized; activity records contain fixed status messages, not provider request headers or arbitrary sandbox logs. Sandbox logs are ephemeral. Operators need secure provider-side diagnostics for a failed live test.
- The model proxy is a scoped API relay, not complete content governance or a hard dollar budget. A job can use its allowed request budget; revocation blocks later requests but cannot cancel already accepted provider inference. It disallows hosted/background tools and stored response reuse. The assigned Git branch is writable; all enabled repository content is readable by its run.

## Verified official references (2026-10-01)

- [Daytona snapshots and nested Docker/Compose](https://www.daytona.io/docs/snapshots/)
- [Sandbox classes](https://www.daytona.io/docs/en/sandboxes/) and [pause/persistence lifecycle](https://www.daytona.io/docs/en/persistence/)
- [Daytona authentication/runtime key scope](https://www.daytona.io/docs/api-keys)
- [Daytona TypeScript SDK](https://www.daytona.io/docs/en/typescript-sdk/daytona/) and [process API](https://www.daytona.io/docs/en/typescript-sdk/process/); adapter signatures checked against installed 0.220.0 declarations
- [Google server-side ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Cloudflare Codex runner pattern](https://developers.cloudflare.com/sandbox/coding-agents/codex/) (runner reference only; Herbie executes in Daytona)
- [Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) and [Worker best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [GitHub webhook signature verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) and [installation tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [Codex provider configuration](https://developers.openai.com/codex/config-reference/)
