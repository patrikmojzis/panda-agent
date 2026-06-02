# Panda Control PR1B UI

PR1B adds a React operator shell for the Control API. Control is still an explicit opt-in operator surface: enable it, grant an existing identity, then open the private URL and paste the one-time login token.

## Local development quick start

1. Start Panda Control on loopback:

```bash
PANDA_CONTROL_ENABLED=true panda run
```

2. Find the identity handle/id to grant:

```bash
panda identity list
```

3. Create a one-time login token. `--identity` accepts either the exact identity id or the handle shown by `panda identity list`:

```bash
panda control grant --identity patrik --role admin
# or scoped to one paired agent
panda control grant --identity patrik --role scoped --agent clawd
```

4. Start the Vite app. It proxies `/api/control/*` to `http://127.0.0.1:4767`:

```bash
pnpm control:dev
```

Open the Vite URL and paste the one-time token at `/login`.

For local-only development, you can skip the one-time token flow with the dev sign-in panel:

```bash
PANDA_CONTROL_ENABLED=true PANDA_CONTROL_DEV_LOGIN_ENABLED=true panda run
pnpm control:dev
```

The dev endpoint is disabled unless `PANDA_CONTROL_DEV_LOGIN_ENABLED` is truthy, refuses `NODE_ENV=production`, and accepts loopback requests only unless `PANDA_CONTROL_DEV_LOGIN_ALLOW_REMOTE=true` is also set. It uses `PANDA_CONTROL_DEV_LOGIN_IDENTITY`, the submitted identity handle/id, or the single active identity if there is exactly one.

## Operator grants

Control access is separate from identity-agent pairing.

```bash
# Discover handles/ids
./scripts/docker-stack.sh panda identity list

# Operator/admin access across Control-visible agents
./scripts/docker-stack.sh panda control grant --identity patrik --role admin

# Pair Patrik with Clawd, then grant owner-ish scoped Control access
./scripts/docker-stack.sh panda agent pair clawd patrik
./scripts/docker-stack.sh panda control grant --identity patrik --role scoped --agent clawd
```

Scoped grants still require the identity to be paired with the agent. Admin grants can inspect agent sessions without an identity-agent pairing.

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

When Control is enabled, `docker-stack.sh` wires `panda-core` like this:

- `PANDA_CONTROL_HOST=0.0.0.0` inside the container so Docker can publish the port.
- `PANDA_CONTROL_PORT=${PANDA_CONTROL_PORT:-4767}` inside the container.
- `PANDA_CONTROL_PUBLISH_HOST=${PANDA_CONTROL_PUBLISH_HOST:-127.0.0.1}` on the Docker host.
- `PANDA_CONTROL_PUBLISH_PORT=${PANDA_CONTROL_PUBLISH_PORT:-${PANDA_CONTROL_PORT:-4767}}` on the Docker host.

The safe default publishes Control on host loopback only (`127.0.0.1:4767`). Keep that default when you will expose it through Tailscale Serve on the host:

```bash
PANDA_CONTROL_ENABLED=true ./scripts/docker-stack.sh up --build
tailscale serve http://127.0.0.1:4767
```

If you prefer a direct host bind on the Tailscale interface, bind the host side to the Tailscale IP instead of public internet:

```bash
PANDA_CONTROL_ENABLED=true \
PANDA_CONTROL_PUBLISH_HOST=<tailscale-ip> \
PANDA_CONTROL_PORT=4767 \
PANDA_CONTROL_PUBLISH_PORT=4767 \
./scripts/docker-stack.sh up --build
```

Do not set `PANDA_CONTROL_PUBLISH_HOST=0.0.0.0` unless another protection layer (firewall, VPN-only interface, or equivalent) prevents public access. Control is an operator surface, not a public Caddy edge route in this deployment slice.

## Quick smokes

After the stack is up, verify the private bind before sending a login token anywhere:

```bash
curl -I http://127.0.0.1:4767/
curl -fsS http://127.0.0.1:4767/api/control/bootstrap
./scripts/docker-stack.sh logs core
```

Expected smoke shape: the UI route returns HTML/static content, `/api/control/bootstrap` returns JSON, and `logs core` has no Control startup errors.

## Security notes

- For bare `panda run`, keep the default `PANDA_CONTROL_HOST=127.0.0.1` unless you intentionally place Control behind TLS and an operator-only network boundary.
- For Docker stack, keep the default host publish on `127.0.0.1` or bind to a Tailscale IP; avoid `0.0.0.0` for this operator UI.
- Login tokens are one-time bootstrap secrets and expire quickly. Do not paste them into logs or shared chat.
- The readable CSRF cookie is scoped to `/` so the React app can recover write/logout CSRF state after a refresh. The session cookie remains `HttpOnly` and scoped to `/api/control`.
- The Credentials page shows metadata/presence only: `agentKey`, `envKey`, timestamps, and `present`. It never renders secret values, ciphertext, IVs, or tags.
