# Authentication

Web sign-in: `POST /api/auth/sign-in/social` with `{ "provider": "github", "callbackURL": "PUBLIC_URL/" }`, then navigate to the returned `url`. The GitHub App's registered callback remains `PUBLIC_URL/api/auth/callback`; the service routes it to Better Auth internally. Existing installation callbacks at `/api/auth/installation/callback` redirect authenticated users home; repository authorization is independently checked afterward.

Browser sessions use Better Auth's signed HttpOnly cookie, Secure on HTTPS. Mutations carrying cookies must include an exact `Origin: PUBLIC_URL`. `POST /api/auth/sign-out` signs out the current session. User profiles, account linking, signup, and provider-token APIs are not publicly mounted.

CLI login uses the first-party device flow:

1. `POST /api/auth/device/code` with `{ "client_id": "prompt-to-pr-cli" }` returns device/user codes, verification URL, polling interval, and expiry.
2. The user opens `/device`, signs in with GitHub, and types the terminal code. `POST /api/auth/device/approve` or `/api/auth/device/deny` accepts `{ "userCode": "..." }`. The service first claims the code for the authenticated user, then applies the explicit decision.
3. Poll `POST /api/auth/device/token` with `client_id`, `device_code`, and `grant_type: "urn:ietf:params:oauth:grant-type:device_code"`. Respect `authorization_pending`, `slow_down`, rejection, and expiry. Success returns the first-party `access_token`.
4. Send `Authorization: Bearer ACCESS_TOKEN` on the documented API requests. These are application sessions, not GitHub PATs. Sessions expire after eight hours.

GitHub identity is restricted to configured numeric IDs during the private beta. Repository eligibility requires the user's push permission and the App installation's Contents/PR write permissions. The service rechecks this before execution and publication; a previously listed repository does not permanently grant access.
