# Private rollout through GitHub Actions

All deployment runs in `.github/workflows/agent-factory.yml`. Do not deploy from a developer session. Trusted pushes to `work` and `main` run validation and then the `agent-factory-production` environment job; pull requests run validation without provider secrets. `workflow_dispatch` on those branches supports retry after configuration. Protect the deployment branches and restrict that environment to them. Never use `pull_request_target` to execute PR code with these secrets.

The deploy job serializes updates, resolves or creates the named D1 database, applies pending committed migrations, deploys the Worker and SQLite Durable Object migration, and checks `/health`. Every deployment **forces `FACTORY_ENABLED=false`**, disables preview URLs and admits only explicitly listed email domains. Missing configuration fails before resource creation. No plan upgrade, Daytona VM allocation or inference occurs. Automatic invocation logs and traces are disabled to avoid storing magic-link query tokens. Fixed DNS/verification error categories are persisted without DNS answers, tokens, headers or request bodies.

## Required GitHub Actions configuration

Set these in the `agent-factory-production` environment (repository secrets/variables also work). GitHub does not allow custom names beginning `GITHUB_`, so App settings use the `HERBIE_` prefix and the workflow maps them to Worker bindings.

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Account-scoped deployment token |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Exact intended 32-character account ID |
| Secret | `BETTER_AUTH_SECRET` | Stable random secret, at least 32 characters; provide securely, never in source |
| Secret | `MAILGUN_API_KEY` | Domain Sending Key restricted to the verified Mailgun domain |
| Variable | `MAILGUN_DOMAIN` | Verified sending domain in Mailgun, e.g. `mail.example.com` |
| Variable | `MAILGUN_REGION` | `us` or `eu`, matching the domain’s Mailgun region |
| Variable | `EMAIL_FROM` | Verified sender address, e.g. `Herbie <login@example.com>` |
| Variable | `ALLOWED_EMAIL_DOMAINS` | Comma-separated explicit pilot company domains; no wildcard |

For this workers.dev/D1 deployment, the minimal Cloudflare token permissions are **Account → Workers Scripts → Edit** and **Account → D1 → Edit**, restricted to the intended account. The explicit account ID avoids account-discovery permissions. Workers Scripts covers Worker/DO upload, cron and workers.dev access; D1 covers provisioning and migrations. No zone/DNS, billing, Access, KV or R2 grants are needed. The account must already have a workers.dev subdomain configured; the script resolves the final origin automatically. It does not register/change the account subdomain. See official [Worker upload permissions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/), [workers.dev lookup permissions](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/), and [D1 creation permissions](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/).

`APP_ORIGIN` is generated as `https://herbie-agent-factory.<account-subdomain>.workers.dev`. No Google client, Google secret or Google origin setup is required.

## Email sender setup

Mailgun is the selected sender behind the `LoginEmail` boundary; switching provider only changes that adapter and deployment configuration. Verify the sender domain using the provider's DNS records before sending to pilot users, configure SPF/DKIM and DMARC as appropriate, and **disable click tracking** so bearer links are not rewritten/tracked. The adapter also explicitly sends `o:tracking=no`, `o:tracking-clicks=no`, `o:tracking-opens=no` and requires TLS on each message. US routes to `api.mailgun.net`; EU routes to `api.eu.mailgun.net`. Use the domain-scoped Domain Sending Key, not an account-wide private API key. The sender domain can differ from the pilot company domain. A Mailgun sandbox domain can send only to authorized test recipients; use a verified sending domain for the pilot. Confirm account quotas/recipient eligibility; no paid plan is automatically selected. [Mailgun sending API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages) and [API authentication](https://documentation.mailgun.com/docs/mailgun/api-reference/mg-auth).

The app sends a generic request response, stores a hashed five-minute token and redeems it once. Email verification proves mailbox control. A separate DNS TXT proof establishes company control; its admin must explicitly enable employee autojoin. Existing domains cannot be reclaimed. Legacy Google users are not linked automatically by matching email; administrator recovery remains a verified operator process.

## Optional GitHub connection configuration

Set all four together to enable connection:

- Variables: `HERBIE_GITHUB_APP_ID`, `HERBIE_GITHUB_APP_SLUG`, `HERBIE_GITHUB_CLIENT_ID`.
- Secret: `HERBIE_GITHUB_CLIENT_SECRET`.

Configure App callback `<APP_ORIGIN>/auth/github/callback`. Required permissions: Contents/Pull requests/Issues write, Checks/Actions/Metadata read and Organization Members read. The connecting user must administer the GitHub organization or own the personal account. Connection selection is authenticated, session-bound, expiring and single-use; selected repositories start disabled. All workspace members can manage goals, but only admins can connect/enable repositories.

## Later execution configuration — separate approval

Secrets: `HERBIE_GITHUB_APP_PRIVATE_KEY` (PKCS#8), `HERBIE_GITHUB_WEBHOOK_SECRET`, `DAYTONA_API_KEY`, `OPENAI_API_KEY`, `RUN_TOKEN_SECRET` (32+ random characters). Optional variables: `DAYTONA_SNAPSHOT`, `CODEX_MODEL`. The workflow passes supplied secrets to Worker secret bindings without printing them. It does **not** enable execution or build/allocate a Daytona snapshot. No provider master key enters customer code.

Before enabling real runs in a separately reviewed workflow change, approve a disposable repo and budget; build/validate the Linux VM snapshot using `sandbox/Dockerfile` through a controlled Actions workflow. Prove actual Docker image build, container run and Compose with `docker-preflight.sh`, private clone/push, streamed Codex inference, tiny draft PR, review/CI repair, human merge, next increment and VM cleanup. This path is implemented but not live-validated. Hosted Codex uses an OpenAI API key and API billing, not a ChatGPT subscription.

## Migration and recovery policy

`0001` creates factory storage; `0002` adds company onboarding; `0003` is generated for pinned Better Auth 1.7.7 and its actual configured plugin/rate-limit schema. `scripts/generate-auth-schema.ts` generates against empty local D1 only. Review future migration diffs; never regenerate a previously deployed migration in place. D1 tracks applied migration files, and deployment stops on failure before Worker upload. Keep changes backward compatible so an application rollback does not require dropping data. Use D1 Time Travel/operator recovery for a failed data change; the job never deletes or recreates an existing database. [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

## First deployment acceptance

After configuring secrets/variables, push or rerun the Actions workflow. Verify its summary URL, `/health` shows execution disabled, the magic-link arrives, sign-in/expiry/replay/logout work, DNS setup and explicit domain enablement work, colleague autojoin respects suspension, and a second company is isolated. Do not infer successful delivery/deployment from local tests. Missing secrets or inaccessible GitHub push remain explicit blockers.

Cloudflare Free supports SQLite Durable Objects and D1 within quotas; confirm the chosen account. Current dry-run bundle is under the Free compressed-size limit. Workers Paid starts at $5/month if the owner chooses it, but is not automatically required/purchased here. Daytona and OpenAI costs start only with separately approved live execution. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/).
