# Panda Control PR1B UI

PR1B adds a read-only React operator shell for the PR1A Control API. It does not add broad write endpoints; the only write flow is login/logout through the existing session and CSRF contract.

## Run the UI in development

1. Start Panda Control on loopback:

```bash
PANDA_CONTROL_ENABLED=true panda run
```

2. Create a one-time login token from an existing identity:

```bash
panda control grant --identity identity-patrik --role admin
# or scoped to one paired agent
panda control grant --identity identity-patrik --role scoped --agent panda
```

3. Start the Vite app. It proxies `/api/control/*` to `http://127.0.0.1:4767`:

```bash
pnpm control:dev
```

Open the Vite URL and paste the one-time token at `/login`.

## Build and serve from the Control server

```bash
pnpm control:build
PANDA_CONTROL_ENABLED=true panda run
```

By default the Control server serves static files from `apps/control-ui/dist` when that directory exists. To serve another build directory:

```bash
PANDA_CONTROL_ENABLED=true PANDA_CONTROL_UI_DIR=/absolute/path/to/control-ui/dist panda run
```

API paths under `/api/control/*` never fall through to the SPA. Unknown API routes return JSON 404.

## Security notes

- Keep the default `PANDA_CONTROL_HOST=127.0.0.1` unless you intentionally place Control behind TLS and an operator-only network boundary.
- Login tokens are one-time bootstrap secrets and expire quickly. Do not paste them into logs or shared chat.
- Logout sends the CSRF token received at login. Refreshing the UI loses in-memory CSRF state, so a refreshed session may need to expire or be replaced before logout can complete.
- The Credentials page shows metadata/presence only: `agentKey`, `envKey`, timestamps, and `present`. It never renders secret values, ciphertext, IVs, or tags.
