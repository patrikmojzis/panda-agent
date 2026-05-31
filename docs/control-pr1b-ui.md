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

## Docker stack / Tailscale deployment

The app Docker image builds the Control UI and serves it from `/app/control-ui` (`PANDA_CONTROL_UI_DIR=/app/control-ui`). To run Control with the stack:

```bash
PANDA_CONTROL_ENABLED=true ./scripts/docker-stack.sh up --build
```

When Control is enabled, `panda-core` listens inside the container on all interfaces so Docker can publish it safely:

- `PANDA_CONTROL_HOST=0.0.0.0` inside the container.
- `PANDA_CONTROL_PORT=${PANDA_CONTROL_PORT:-4767}` inside the container.
- `PANDA_CONTROL_PUBLISH_HOST=${PANDA_CONTROL_PUBLISH_HOST:-127.0.0.1}` on the Docker host.
- `PANDA_CONTROL_PUBLISH_PORT=${PANDA_CONTROL_PUBLISH_PORT:-${PANDA_CONTROL_PORT:-4767}}` on the Docker host.

For a VPS behind Tailscale, bind the host side to the Tailscale address instead of public internet:

```bash
PANDA_CONTROL_ENABLED=true \
PANDA_CONTROL_PUBLISH_HOST=<tailscale-ip> \
PANDA_CONTROL_PORT=4767 \
PANDA_CONTROL_PUBLISH_PORT=4767 \
./scripts/docker-stack.sh up --build
```

Do not set `PANDA_CONTROL_PUBLISH_HOST=0.0.0.0` unless another protection layer (firewall, VPN-only interface, or equivalent) prevents public access. Control is an operator surface, not a public Caddy edge route in this deployment slice.

After the stack is up, create grants as usual:

```bash
panda control grant --identity identity-patrik --role admin
panda control grant --identity identity-patrik --role scoped --agent panda
```

Scoped grants still require the identity to be paired with the agent. Admin grants can inspect agent sessions without an identity-agent pairing.

## Security notes

- Keep the default `PANDA_CONTROL_HOST=127.0.0.1` unless you intentionally place Control behind TLS and an operator-only network boundary.
- Login tokens are one-time bootstrap secrets and expire quickly. Do not paste them into logs or shared chat.
- The readable CSRF cookie is scoped to `/` so the React app can recover write/logout CSRF state after a refresh. The session cookie remains `HttpOnly` and scoped to `/api/control`.
- The Credentials page shows metadata/presence only: `agentKey`, `envKey`, timestamps, and `present`. It never renders secret values, ciphertext, IVs, or tags.
