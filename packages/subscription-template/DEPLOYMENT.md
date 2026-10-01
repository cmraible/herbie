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

Both environments need `CLOUDFLARE_API_TOKEN`, `BETTER_AUTH_SECRET` (at least 32 characters), `EMAIL_API_KEY` secrets and `CLOUDFLARE_ACCOUNT_ID`, `EMAIL_FROM` variables. Optional `EMAIL_API_URL` must use HTTPS. Preview needs a distinct session seed and email key, plus `SUPABASE_ACCESS_TOKEN` and distinct `SUPABASE_PREVIEW_PROJECT_REF`/`SUPABASE_PRODUCTION_PROJECT_REF` variables. Production needs a TLS-verified Postgres `DATABASE_URL`, OAuth credentials and Stripe settings when enabling those capabilities. GitHub OAuth environment names are `OAUTH_GITHUB_CLIENT_ID` and `OAUTH_GITHUB_CLIENT_SECRET` to avoid reserved GitHub variable names.

Preview resources use `herbie-subscription-pr-<number>`. Each review gets a Supabase branch created with `with_data:false` and an isolated Worker. Its DB credentials and a per-PR derived session secret go only to that Worker. Cloudflare/Supabase master tokens remain in the trusted deployment job. Preview does not receive Stripe or OAuth credentials. Supabase branch configuration must return usable database credentials; otherwise the deployment stops without resetting passwords.

## Delivery and cleanup

- `subscription-template.yml`: PR tests run without provider secrets, including PostgreSQL 17, Chromium, strict checks, OpenAPI drift and build. Successful runs upload static assets, the Worker bundle and SQL migrations.
- `subscription-template-hosting.yml`: trusted `workflow_run` checks successful run provenance, same-repository PR ownership, current head and open state. Its control-plane scripts/dependencies come from `main`. It deploys the artifact with `--no-bundle`; it never executes a PR package manifest or deployment script. SQL is applied only to the selected isolated DB. Production runs only after a successful current `main` push and explicit environment enablement.
- `subscription-template-cleanup.yml`: trusted PR-close handling reads scripts from `main`, deletes only the exact review Worker and non-default Supabase branch, and shares concurrency control with review deployment. Rerun failed cleanup jobs; monitor for abandoned branches and their cost. No provider lifecycle call was live-tested here.

These privileged workflows must first exist on trusted `main` before GitHub can run them. This draft targets `work` to keep prior agent-factory changes out of the review; nothing is merged automatically. The initial live rollout remains blocked by resource/cost approval and supplied credentials, even though local validation can proceed.

## Live smoke checklist

After authorized provisioning: apply migrations, deploy the isolated template, verify DB connectivity and HTTPS/session cookies, deliver a real verification email, complete signup/team invitation, exercise physical-device passkey and TOTP recovery, complete each configured OAuth provider, and run Stripe sandbox Checkout/Portal plus webhook redelivery/cancellation. Close a disposable PR and verify both review resources are deleted. Do not enable live Stripe payments until those results and live credentials are explicitly approved.

Provider API shapes were checked against current Supabase docs and generated `supabase-management-js@2.0.2` declarations (`POST /v1/projects/{ref}/branches`, `GET/DELETE /v1/branches/{ref}`); Cloudflare deployment uses installed Wrangler 4.145.0. Typechecking is not evidence of remote provisioning success.
