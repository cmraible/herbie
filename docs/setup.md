# Setup

Requires Docker with Compose. The stack builds your current checkout and runs
Herbie, Postgres, and a Cloudflare Tunnel. GitHub, Daytona, and OpenAI calls are real.

## Configure

Copy `.env.example` to `.env` and fill its settings. Use separate development
credentials:

- **GitHub:** Create an App and install it on a public or private test repository. Follow the
  [App permissions and callback settings](service.md#github-app).
  Put its credentials, webhook secret, and your numeric user ID in `.env`.
- **OpenAI and Daytona:** Supply a service OpenAI key and a Daytona API key. Store
  a separate OpenAI key as a Daytona organization secret; put the secret's **name**
  in `HERBIE_DAYTONA_OPENAI_SECRET`.
- **Cloudflare:** Create a [remotely managed tunnel](https://developers.cloudflare.com/tunnel/get-started/)
  routing your hostname to `http://herbie:8787`. Set `CLOUDFLARE_TUNNEL_TOKEN` and
  `HERBIE_PUBLIC_URL=https://YOUR-HOST`. Keep `/api/webhooks/github` accessible
  without an interactive Access login.
- **Credential encryption:** Generate `HERBIE_CREDENTIAL_KEY` using the command in
  `.env.example` and keep it stable. The database needs no manual setup.

## Run

```sh
docker compose up --build -d --wait
```

Open your HTTPS hostname and sign in with GitHub. To run projects, set
`HERBIE_EXECUTION_ENABLED=true` in `.env` and rerun the command. Projects consume
Daytona/OpenAI usage and can publish real PRs.

Rerun the same command after code or configuration changes. Pause projects and let
active attempts finish before rebuilding or stopping.

```sh
docker compose logs -f herbie tunnel  # View logs
docker compose down                  # Stop; retain database
```

See [service operations](service.md) for recovery and deployment details.

### Elasticsearch MCP in Codex

Set `ES_URL` and `ES_API_KEY`, then start Codex from the repo root. You'll need
Node.js 24+, Git, and npm. The first launch builds Elastic's pinned v0.3.1 server;
later launches use the cached build. No Docker needed.

The launcher uses the environment's proxy and CA settings. TLS verification stays
on, telemetry defaults to off, and `NO_PROXY` exclusions aren't supported.

To upgrade, update the commit in `scripts/elasticsearch-mcp.mjs`. Bump
`adapterVersion` if you change the proxy adapter.
