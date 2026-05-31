# Panda Control PR1A

Panda Control is a separate operator HTTP surface from Gateway and micro-apps. PR1A exposes only the backend seam, cookie auth, explicit Control grants, and minimal read APIs under `/api/control/*`.

## Enable the server

Control is disabled by default. Enable it on the daemon with:

```bash
PANDA_CONTROL_ENABLED=true panda run
```

Defaults when enabled:

- Host: `127.0.0.1` (loopback only)
- Port: `4767`

A public bind is never implied. To bind publicly, set it explicitly. PR1A does not terminate TLS; put public binds behind a TLS reverse proxy and review Secure-cookie deployment settings before exposing it beyond loopback:

```bash
PANDA_CONTROL_ENABLED=true PANDA_CONTROL_HOST=0.0.0.0 PANDA_CONTROL_PORT=4767 panda run
```

## Grant bootstrap

Existing Panda identities do not automatically have Control access. List identities first, then create an explicit grant with either the identity handle or exact id:

```bash
panda identity list
panda control grant --identity patrik --role admin
panda control grant --identity patrik --role scoped --agent clawd
```

The command prints a one-time `loginToken` that expires after 15 minutes. Treat it as a secret operator bootstrap token. The HTTP login endpoint consumes it and exchanges it for a Control session cookie and CSRF token; token reuse fails.

## PR1A endpoints

- `GET /api/control/health`
- `GET /api/control/bootstrap` — reports whether any active Control grant exists.
- `POST /api/control/login` — body `{ "token": "..." }`.
- `GET /api/control/me`
- `POST /api/control/logout` — requires `x-control-csrf`.
- `GET /api/control/overview`
- `GET /api/control/agents`
- `GET /api/control/credentials`

Credentials are presence metadata only (`agentKey`, `envKey`, timestamps, `present`). Secret values, ciphertext, IVs, tags, and decrypted values are not returned.
