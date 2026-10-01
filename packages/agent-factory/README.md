# Herbie agent factory

A hosted-product foundation with a portable TypeScript coordinator and a locally tested end-to-end goal → PR → feedback repair → merge → next increment loop. The root Herbie controller remains unchanged. **Execution defaults to disabled. Nothing in the test suite needs real provider credentials.**

## Generated PR policy

Each generated PR solves **one small problem** or makes **one small improvement**. Aim for a couple of lines of code when practical, with no hard numeric line cap. Broad outcomes and checklists are context for choosing one small next step, not permission to bundle improvements. Use the smallest sufficient change with proportionate verification. Titles and summaries lead with the concrete problem solved, followed by brief change and verification details. The executor returns a validated structured summary which is checkpointed in D1 and used by the PR publisher; it does not dump the entire goal into the PR description.

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

`test:worker` builds a Worker bundle using `wrangler deploy --dry-run` and runs it in Miniflare with real local D1/SQLite and Durable Objects. `build` never deploys. `db:migrate` is explicitly local. No test provisions a Daytona VM or publishes a GitHub PR. The default UI is at localhost:8787; Magic-link login requires a configured sender and Better Auth secret. Secure cookies are used (localhost browser handling must support secure contexts; hosted setup requires HTTPS).

`pnpm types` inside this package regenerates binding types from Wrangler config. Secrets are named separately in `src/cloudflare/env.ts`. Tests exercise externally visible domain behavior, cryptographic verification, SQL CAS persistence, request isolation and settings permissions.

## Architecture and invariants

- `src/core`: plain TypeScript domain and coordinator, no provider imports. `GoalStore`, `Repository`, and `Execution` have both fake and production adapters. Goal mutations use revision compare-and-swap; a ten-minute durable lease fences short external-operation ticks (a crashed tick can wait up to that lease before recovery). Goals have one active operation at a time, which is stronger than serial work per PR.
- `src/adapters/d1.ts`: authoritative aggregate per goal, atomic revision updates and quota-checked creation. Pending creations count against capacity before external effects. Open PRs replace their reservation atomically. Lowering a target never closes PRs; already reserved work remains counted and can complete.
- `GoalCoordinator`: one Durable Object per goal, persisted wakeup and alarm scheduled before external effects. Alarms poll every 30 seconds; cron sweeps goals and durable webhook inbox every five minutes to repair lost wakeups. UI creation and edits schedule immediate alarms. Provider failures back off and pause after three failures. VM TTL bounds resource lifetime even if cleanup is temporarily unavailable.
- `Factory`: verifies PR state from GitHub (never trusts a webhook merge flag), reserves slots, runs/retries attempts, persists pushed commit checkpoints, cleans up the VM, then publishes/reconciles a draft PR. Closed-unmerged pauses the goal. Three failed/lost/timed-out attempts escalate. Five automatic repair runs per PR also escalate, so ineffective fixes cannot loop forever; a deliberate human resume resets that repair budget. Work paused by a human is terminated while its reservation and feedback are retained; resume creates a fresh VM attempt. Publishing checkpoints remain reserved until reconciliation. Prompt edits affect future reservations only.
- GitHub publication searches a deterministic branch, including closed/merged PRs, before creating anything. A response lost after publication recovers the existing PR. Repairs push to the existing branch and leave a marked progress reply. Delayed CI is accepted only for the actual current head; signed delivery IDs deduplicate feedback. Feedback arriving while an initial run is running or publishing stays in the durable inbox until reconciliation.
- `DaytonaExecution`: pins SDK 0.220.0, uses deterministic VM names per run/attempt, validates both snapshot and sandbox `linux-vm` class, and never resumes a stopped VM as if its processes were alive. Runner process starts use `flock` plus durable started/result markers. Missing/stopped VMs trigger bounded retry; retries clone the pushed branch. The Git commit contains the logical run ID and structured summary so a retry can recover a successful push even when its VM result was lost. A run times out after 30 minutes; VMs have a 45-minute TTL.
- `sandbox/runner.mjs`: Codex executes inside the dedicated VM. It runs Docker preflight, clones, checks out the run branch, executes Codex, commits, pushes and emits a commit checkpoint. Partial unpushed work can be lost with the VM; previous pushed work and coordinator state remain recoverable. No customer code runs on the coordinator.
- A scoped 35-minute run JWT authorizes only an active run/attempt. A Git smart-HTTP proxy enforces the assigned repository and one writable branch; a model proxy permits Responses inference for the configured model with a per-run 200-request ceiling and 16,384 output-token cap. Provider credentials never enter customer code. GitHub tokens are repository-scoped and minted by the coordinator. No ChatGPT subscription or OAuth session is used to fund hosted Codex.

## Login and company onboarding

Better Auth 1.7.7 uses its native D1 adapter, five-minute hashed magic links, atomic first-use redemption, database sessions and persistent auth rate limiting. The app uses the HTTP handler so the limiter is active. Secure HttpOnly SameSite=Lax cookies, explicit trusted origin and disabled cookie cache preserve current session checks. Google is no longer part of sign-in.

Only `ALLOWED_EMAIL_DOMAINS` can receive a link or access the app; empty admits nobody. Verifying an email proves mailbox control, not company ownership. Creating a company also requires a random DNS TXT proof tied to that identity; the new company domain starts disabled until its administrator enables employee autojoin. Existing tenants cannot be claimed. Stable namespaced Better Auth user IDs identify members. Legacy Google identities are not automatically linked by matching email.

Admins can enable verified domains, manage member roles/suspension with last-admin protection, and connect GitHub. GitHub App OAuth uses PKCE and expiring one-use state bound to the exact active login session; it separately proves GitHub org-admin or personal-owner authority. Admins choose provider-verified repositories; grants start disabled. Install the app with Contents/Pull requests/Issues write, Checks/Actions/Metadata read and **Organization Members read**. Existing-tenant admin recovery and provider secrets remain operator-managed.

The email sender is an explicit adapter (`LoginEmail`); Mailgun is the selected sender. It requires a verified sender domain and Domain Sending Key. Delivery errors are handled without printing response bodies or links. Worker request logging is disabled because magic-link verification URLs carry credentials.

## GitHub Actions deployment

[DEPLOYMENT.md](DEPLOYMENT.md) lists exact Actions secrets/variables and the rollout sequence. `.github/workflows/agent-factory.yml` validates pull requests without provider secrets, and deploys trusted pushes to `work` or `main` through the `agent-factory-production` environment. Deployment serializes provisioning, resolves/creates D1, applies committed pending migrations, supplies secrets with a temporary protected file, deploys Workers/DO, and verifies execution remains disabled. No direct provider deployment is performed by this task. Missing configuration fails before resource creation.

The user has authorized commit/push and an execution-disabled private deployment. Paid capacity, provider smoke execution, purchases, merges and autonomous work on live repos remain separately gated. No account upgrade is performed. The first deployment needs no Daytona or OpenAI key.

## API surface

Better Auth: `POST /api/auth/sign-in/magic-link`, `GET /api/auth/magic-link/verify`, `POST /api/auth/sign-out`, `GET /api/auth/get-session`. Account/company: `/api/account`, `/api/onboarding/company`, `/api/onboarding/verify`, `/api/onboarding/join`.

Members share `GET/POST /api/workspaces/:workspace/goals`, `GET/PATCH .../goals/:id` and repository lists. Admin routes cover `/settings`, `/domains`, `/members`, `/audit`, `/github/start`, `/github/accept` and repository enablement. UI includes goals, activity, prompt versions, pause/resume, company DNS setup, member administration and GitHub selection. Secrets and billing administration stay outside member flows.

## Remaining live integration and product gaps

- **Not live-validated:** Daytona VM creation/SDK transport from Workers, Docker daemon startup inside the VM snapshot, the pinned Codex CLI custom-provider/Responses streaming path, Git smart-HTTP behavior against an actual private GitHub App installation, magic-link email delivery and browser sign-in, provider cleanup and alarms on deployed infrastructure. Local typecheck/bundle success is not evidence these live paths work. The required Docker preflight is implemented but has not been run in a real Daytona VM in this task.
- Self-service DNS proof, member administration and GitHub OAuth selection are locally tested; browser/DNS/provider smoke validation and existing-tenant administrator recovery remain. Payment collection, billing portal and metered invoices are not implemented. Billing status, workspace goal quota and per-run model request limits exist, but these are not a monetary spend guarantee. Production needs overall workspace/account spend and concurrency limits.
- CI webhook processing currently supplies failing check/workflow names and the matching commit. It asks Codex to reproduce locally; it does not download full CI logs or post inline review replies. Progress replies are PR conversation comments. Reconciliation scans up to 2,000 comments and escalates rather than posting duplicates beyond that bound. Missed review/CI webhooks not delivered to the inbox require GitHub redelivery; periodic reconciliation currently polls PR state, not all review/check history.
- Goal aggregates retain run/event history; split/compact archival storage before long-running high-volume tenants approach D1 row limits. Inbox retention, tenant audit export, broader rate limiting, distributed multi-region contention/load tests and production alerting remain hardening work.
- Failure exceptions are intentionally sanitized; activity records contain fixed status messages, not provider request headers or arbitrary sandbox logs. Sandbox logs are ephemeral. Operators need secure provider-side diagnostics for a failed live test.
- The model proxy is a scoped API relay, not complete content governance or a hard dollar budget. A job can use its allowed request budget; revocation blocks later requests but cannot cancel already accepted provider inference. It disallows hosted/background tools and stored response reuse. The assigned Git branch is writable; all enabled repository content is readable by its run.

## Verified official references (2026-10-01)

- [Daytona snapshots and nested Docker/Compose](https://www.daytona.io/docs/snapshots/)
- [Sandbox classes](https://www.daytona.io/docs/en/sandboxes/) and [pause/persistence lifecycle](https://www.daytona.io/docs/en/persistence/)
- [Daytona authentication/runtime key scope](https://www.daytona.io/docs/api-keys)
- [Daytona TypeScript SDK](https://www.daytona.io/docs/en/typescript-sdk/daytona/) and [process API](https://www.daytona.io/docs/en/typescript-sdk/process/); adapter signatures checked against installed 0.220.0 declarations
- [Better Auth magic links](https://better-auth.com/docs/plugins/magic-link), [native D1 and schema](https://better-auth.com/docs/concepts/database), [rate limiting](https://better-auth.com/docs/concepts/rate-limit)
- [Mailgun sending API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages)
- [Cloudflare Codex runner pattern](https://developers.cloudflare.com/sandbox/coding-agents/codex/) (runner reference only; Herbie executes in Daytona)
- [Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) and [Worker best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [GitHub webhook signature verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) and [installation tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [Codex provider configuration](https://developers.openai.com/codex/config-reference/) and [structured non-interactive output](https://developers.openai.com/codex/noninteractive/)
