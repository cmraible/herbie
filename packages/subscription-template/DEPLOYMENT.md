# Hosting setup and remaining gates

The package build is always a dry run. Hosting is implemented but has not been exercised against live template resources. No Supabase project/branch, credentials or paid capacity was created in this task. KaizenKit and agent-factory must remain untouched.

## Provisioning prerequisites

1. Approve the Supabase organization, isolated template project(s), branch pricing and capacity. The connected organization is Chris Raible; the organization/cost confirmation is still pending. Use a dedicated production template project and a separate empty preview-parent project. Never point these workflows at an existing unrelated project.
2. Supply server-side credentials through protected GitHub environments. Provider apps can inspect accounts but do not automatically supply runtime application credentials. Configure least-privilege Cloudflare and scoped Supabase management tokens; keep preview credentials separate from production.
3. Configure a verified email sender. Preview uses a separate restricted email credential and test identities; do not put a general production email key in the preview environment.
4. Set up Google/GitHub OAuth callback URLs `/api/auth/callback/google` and `/api/auth/callback/github`. ChatGPT needs an approved registration and `/api/auth/callback/chatgpt`; leave absent otherwise. No preview OAuth credentials are copied automatically.
5. In Stripe test mode, supply a recurring price, restricted key with the needed Customer/Checkout/Subscription/Portal permissions, and a webhook signing secret. Configure Portal and subscribe `/api/billing/webhook` to `customer.subscription.*`, `checkout.session.completed`, `invoice.paid`, and `invoice.payment_failed`. Match the pinned API version `2026-09-30.endive`. Real Checkout/Portal, webhook delivery and payment-method scenarios still require a sandbox smoke test.

## GitHub environment settings

Set repository variables `SUBSCRIPTION_PREVIEW_ENABLED=true` and/or `SUBSCRIPTION_PRODUCTION_ENABLED=true` only after approving the associated provisioning and credentials. They are absent by default. Create protected environments `subscription-template-preview` and `subscription-template-production`; require reviewer approval and restrict deployment branches to trusted main before enabling them.

Both environments need `CLOUDFLARE_API_TOKEN`, `BETTER_AUTH_SECRET` (at least 32 characters), `EMAIL_API_KEY` secrets and `CLOUDFLARE_ACCOUNT_ID`, `EMAIL_FROM` variables. Optional `EMAIL_API_URL` must use HTTPS. Preview needs a distinct session seed and email key, plus `SUPABASE_ACCESS_TOKEN` and distinct `SUPABASE_PREVIEW_PROJECT_REF`/`SUPABASE_PRODUCTION_PROJECT_REF` variables. Production needs `SUPABASE_PRODUCTION_PROJECT_REF` and a Postgres `DATABASE_URL` with exactly `sslmode=verify-full`. The deployment validates either `db.<project-ref>.supabase.co` or a Supabase pooler whose database username ends in that project reference; unrelated destinations, TLS downgrades and override parameters are rejected. Production also needs OAuth credentials and Stripe settings when enabling those capabilities. GitHub OAuth environment names are `OAUTH_GITHUB_CLIENT_ID` and `OAUTH_GITHUB_CLIENT_SECRET` to avoid reserved GitHub variable names.

Preview resources use `herbie-subscription-pr-<number>`. Each review gets a Supabase branch created with `with_data:false` and an isolated Worker. Its DB credentials and a per-PR derived session secret go only to that Worker. Cloudflare/Supabase master tokens remain in the trusted deployment job. Preview does not receive Stripe or OAuth credentials. Supabase branch configuration must return usable database credentials; otherwise the deployment stops without resetting passwords.

## Delivery and cleanup

- `subscription-template.yml`: PR tests run without provider secrets, including PostgreSQL 17, Chromium, strict checks, OpenAPI drift and build. Successful runs upload static assets, the Worker bundle and SQL migrations.
- `subscription-template-hosting.yml`: trusted `workflow_run` checks successful run provenance, same-repository PR ownership, current head and open state. Its control-plane scripts/dependencies come from `main`. It deploys the artifact with `--no-bundle`; it never executes a PR package manifest or deployment script. SQL is applied only to the selected isolated DB. Production runs only after a successful current `main` push and explicit environment enablement.
- `subscription-template-cleanup.yml`: trusted PR-close handling reads scripts from `main`, deletes only the exact review Worker and non-default Supabase branch, and shares concurrency control with review deployment. Disabling new previews does not disable cleanup. Both jobs use `queue: max` so a later queued deploy cannot replace pending cleanup; GitHub caps the queue at 100, so monitor canceled/failed jobs and rerun cleanup if the queue saturates. Rerun failed cleanup jobs; monitor for abandoned branches and their cost. No provider lifecycle call was live-tested here.

These privileged workflows must first exist on trusted `main` before GitHub can run them. This draft targets `work` to keep prior agent-factory changes out of the review; nothing is merged automatically. The initial live rollout remains blocked by resource/cost approval and supplied credentials, even though local validation can proceed.

## Live smoke checklist

After authorized provisioning: apply migrations, deploy the isolated template, verify DB connectivity and HTTPS/session cookies, deliver a real verification email, complete signup/team invitation, exercise physical-device passkey and TOTP recovery, complete each configured OAuth provider, and run Stripe sandbox Checkout/Portal plus webhook redelivery/cancellation. Close a disposable PR and verify both review resources are deleted. Do not enable live Stripe payments until those results and live credentials are explicitly approved.

Provider API shapes were checked against current Supabase docs and generated `supabase-management-js@2.0.2` declarations (`POST /v1/projects/{ref}/branches`, `GET/DELETE /v1/branches/{ref}`); Cloudflare deployment uses installed Wrangler 4.145.0. Typechecking is not evidence of remote provisioning success.

## Migration compatibility and failed rollout

Migration files are immutable once applied. The runner stores SHA-256 checksums, verifies all previously applied files before executing new SQL, rejects removed/edited history and backdated additions, and applies the pending batch transactionally under a PostgreSQL advisory lock. Fix errors by appending a forward migration. Legacy ledgers without checksums stop for operator verification; never populate checksums blindly from an unverified working tree. For disposable review databases, delete/recreate the isolated branch instead of adopting uncertain history.

Database migration commits before the Worker upload. A failed upload therefore does **not** mean the database reverted. Before enabling a rollout, review each new migration for compatibility with both the currently deployed and candidate Worker. Use expand/contract changes: add nullable columns/tables first, deploy compatible code, backfill separately, and remove old schema only in a later independently reviewed release. Do not combine a required rename/drop with the first code release that stops using the old schema.

If deployment fails after migrations: keep the old Worker serving only when that compatibility check passed; inspect the Cloudflare deployment result and run `GET /ready` against the deployed version. Correct the code/configuration and rerun the same artifact when appropriate—the migration ledger verifies and skips unchanged files. If data/schema repair is needed, append a corrective migration and roll forward. Do not delete ledger rows, edit applied SQL, or automatically run destructive down migrations. An emergency restoration requires an approved backup/restore plan outside this pipeline.

The post-deploy `/ready` probe checks connection access and the required auth, billing and migration-ledger relations without returning customer data. Failures return a generic 503. `/health` remains a process liveness check. Hosted deployment and compatibility with future migrations remain operator gates; local migration tests do not establish remote provisioning success.
