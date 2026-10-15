# Setup

Requires Docker with Compose. The stack builds your current checkout and runs
Herbie, Postgres, and a Cloudflare Tunnel. GitHub, Daytona, and OpenAI calls are real.

## Configure

Copy `.env.example` to `.env` and fill its settings. Use separate development
credentials:

- **GitHub:** Create an App and install it on a public test repository. Follow the
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

Open your HTTPS hostname and sign in with GitHub. To run goals, set
`HERBIE_EXECUTION_ENABLED=true` in `.env` and rerun the command. Goals consume
Daytona/OpenAI usage and can publish real PRs.

Rerun the same command after code or configuration changes. Pause goals and let
active attempts finish before rebuilding or stopping.

```sh
docker compose logs -f herbie tunnel  # View logs
docker compose down                  # Stop; retain database
```

See [service operations](service.md) for recovery and deployment details.
