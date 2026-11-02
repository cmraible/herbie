# Herbie ChatGPT demo

A minimal local web app: sign in with ChatGPT, choose an available model, send a prompt, and watch the response stream. Eligible requests use your ChatGPT plan or available credits. No API key or client secret is needed.

## Run

Requires Node.js 24+ and pnpm. Run these commands from the workspace root.

```sh
pnpm install
pnpm demo
```

Open **http://127.0.0.1:3210**, choose **Continue with ChatGPT**, and approve plan usage. You need an eligible ChatGPT account and access to OpenAI's Sign in with ChatGPT preview. Availability and model choices depend on your account.

Use `127.0.0.1`, not `localhost`: the OAuth loopback callback must use that exact host. To change the port, run `PORT=3211 pnpm demo`.

Each prompt is independent; the demo does not send earlier prompts as conversation history. **Stop** cancels the request, and **Manage usage** opens ChatGPT's usage controls. To switch accounts, choose a saved account (or add one) and continue through sign-in.

## Local data

OAuth credentials stay on the Node server, in `.herbie/credentials.json` at the workspace root, excluded from Git. On Unix, the directory is owner-only and the credential file has mode `0600`; credentials are not encrypted at rest. Set `HERBIE_DATA_DIR` to use another private directory outside source control. Preserve this directory to retain the installation's host ID and account registrations.

The app binds only to `127.0.0.1`, checks the Host and Origin headers, and uses an HttpOnly browser session cookie. Only one process may use a data directory, preventing concurrent refresh-token rotation. After an unclean shutdown, confirm Herbie is stopped and remove the empty `.herbie/running.lock` directory before restarting.

Sign out attempts to revoke the active account's renewable session and clears its tokens locally. If revocation cannot be confirmed, the app tells you to disconnect it in ChatGPT settings. Other saved accounts remain separate. Prompts and responses are not saved by Herbie; API requests use `store: false`.

This is a local demo, not a hosted service. Hosted or paid distribution requires the applicable OpenAI access approval.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
node packages/demo/dist/index.js
```

Keep the demo package’s `public/` alongside its `dist/` when running the compiled server. Tests use simulated OAuth and streaming responses and do not consume your plan. Live sign-in and generation require manual verification with an eligible account.

## Integration references

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

The OAuth flow uses PKCE, state, nonce, signature/issuer/audience/expiry validation, and an explicit check for the plan-usage scope. `jose` is the only runtime dependency; the server and UI otherwise use platform APIs.
