# Prompt to PR

A small, API-first coding bot: sign in with GitHub, choose a repository, submit a prompt, and review a draft PR. Web and CLI share the same API. Runs continue after either client closes.

## Development

Requires Node 22.18+ (deployment uses Node 24), pnpm 10.34.6, Git, and Docker for disposable Postgres tests.

```sh
cd prompt-to-pr
pnpm install
pnpm verify
```

Verification builds all four packages, checks types, and runs integration tests against a fresh Postgres container that is deleted afterward. Tests never run paid coding sessions or write to GitHub.

## Configure

Reuse the existing Herbie GitHub App and URL. The bot needs Contents and Pull requests read/write and Metadata read. Existing extra permissions and webhook subscriptions can remain, but this bot does not process PR/CI events. Workflow-file edits are intentionally rejected. The callback stays `PUBLIC_URL/api/auth/callback` and the installation setup callback stays `PUBLIC_URL/api/auth/installation/callback`. The setup redirect grants no authority; the API independently rediscovers authorized repositories. Use a separate database/schema for the rebuild and drain active Herbie work before routing the shared URL to it.

Install the App on the repositories to use. Repository discovery requires both App access and the signed-in user's push permission. Enter allowed numeric GitHub user IDs in `ALLOWED_GITHUB_IDS` for the private beta. This supports several separate users; there are no shared teams or workspaces.

Use the existing E2B API key, sandbox template, and managed OpenAI secret. Set `E2B_TEMPLATE` to a template with Node 24, Git, and Codex 0.159.2 installed. The worker uses the secret's name; the raw model key is not stored in this application's configuration. Each run uses the fixed existing sandbox template with a 30-minute maximum lifetime and a 20-minute coding deadline. GitHub write credentials never enter that sandbox.

Copy `.env.example` to `.env` and fill in the values. Keep this file out of Git. Use HTTPS for a remotely accessible service. Local GitHub callbacks can use `http://localhost:8787` when registered on the App. The database URL in the example is for Docker Compose; use a localhost database URL when running Node directly.

## Run

```sh
docker compose up --build -d
```

Open `PUBLIC_URL`. The API also serves the web client. One image supplies the migration, API, and worker roles. Compose binds the API only to localhost; use your HTTPS reverse proxy for remote access. Back up the Postgres volume together with `AUTH_SECRET`, which protects stored GitHub tokens.

For local Node processes, load the environment through Node's `--env-file=.env` option:

```sh
node --env-file=.env packages/service/dist/main.js migrate
node --env-file=.env packages/service/dist/main.js api
node --env-file=.env packages/service/dist/main.js worker
```

## CLI

```sh
pnpm cli --server http://localhost:8787 login
pnpm cli repos
pnpm cli run --repo owner/repository --prompt 'Fix the typo in the README' --wait
pnpm cli runs --json
pnpm cli run status RUN_ID
```

Login displays a URL and code. Sign in in the browser, enter the code from your terminal, and explicitly approve access. Credentials are stored per server in an owner-only file under `~/.config/prompt-to-pr`. Set `PROMPT_TO_PR_URL` to avoid repeating `--server` for a remote instance. The CLI prints an idempotency key before submission; reuse it with `--idempotency-key` if the response is lost.

## Scope

One prompt creates one run and at most one draft PR. No-change outcomes explain why no PR was warranted. Failed or uncertain work stops visibly. A PR is never automatically merged or marked ready. CI repairs, comment handling, and work after merge are deferred.

See [implementation plan](docs/implementation-plan.md) and [implementation status](docs/status.md) for architecture and verification evidence. The rebuild is deployed at [herbie.raible.dev](https://herbie.raible.dev). Real GitHub login, repository discovery, and prompt-to-draft-PR runs passed independently through both web and CLI, including retrieving results after closing each client.
