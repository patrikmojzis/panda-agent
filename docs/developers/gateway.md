# Gateway

Panda Gateway is the public server-to-server ingress for external apps.

Production deployments must terminate TLS before the gateway. Public binds require `GATEWAY_IP_ALLOWLIST`
unless `GATEWAY_ALLOW_PUBLIC_WITHOUT_IP_ALLOWLIST=true` is set explicitly.

It is deliberately separate from Panda core:

- gateway accepts public HTTP
- gateway auth resolves one source to one agent route
- gateway stores events first
- gateway worker guards, applies policy, then writes Panda thread input
- Panda core does not expose this public HTTP surface

## Public API

Token:

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=...&client_secret=...
```

Event:

```http
POST /v1/events
Authorization: Bearer <access_token>
Idempotency-Key: <stable-event-key>
Content-Type: application/json
```

```json
{
  "type": "meeting.transcript",
  "delivery": "queue",
  "occurredAt": "2026-04-28T10:00:00Z",
  "text": "..."
}
```

`delivery` is only `queue` or `wake`. Event type policy may downgrade `wake` to `queue`.

## Safety Rules

- Clients never send `agentKey`, `identityId`, `sessionId`, or `sourceId`.
- OAuth client credentials resolve to a registered gateway source.
- Event types must be explicitly allowed per source.
- Unknown event types are rejected and strike the source.
- `riskScore >= 0.85` quarantines the event, skips delivery, and strikes the source.
- Panda receives the raw text wrapped as untrusted external data.
- Gateway event text is scrubbed after delivery or quarantine. The event keeps hash, byte count, and metadata.
- Files are not v1. Text first.

## Network Controls

`GATEWAY_IP_ALLOWLIST` accepts comma-separated IPs or CIDRs. If the gateway runs behind a reverse proxy, set `GATEWAY_TRUSTED_PROXY_IPS` to the proxy IP/CIDR and configure the proxy to strip incoming `X-Forwarded-For` before setting its own value. The gateway ignores `X-Forwarded-For` unless the direct peer is trusted.

Budgets are stored in Postgres, not local process memory:

- `GATEWAY_RATE_LIMIT_PER_MINUTE`
- `GATEWAY_TEXT_BYTES_PER_HOUR`
- `GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE`

`GATEWAY_GUARD_MODEL` is required. The gateway guard defaults to a high timeout. Override with `GATEWAY_GUARD_TIMEOUT_MS` once the model/provider path is stable.

## CLI

```bash
panda gateway source create work-prod --agent panda --identity patrik
panda gateway source allow-type work-prod meeting.transcript --delivery queue
panda gateway run
```

Useful operations:

```bash
panda gateway source list
panda gateway source rotate-secret work-prod
panda gateway source suspend work-prod --reason "compromised"
panda gateway source resume work-prod # also rotates and prints a new client secret
panda gateway event-list --source work-prod
```

## Docker Stack

The stack runs gateway as its own process:

- `panda-gateway` handles `/oauth/token`, `/v1/events`, and `/health`
- Caddy terminates TLS on the public URL
- `panda-gateway` and Caddy share `gateway_edge_net`
- `panda-gateway` never joins `runner_net`

Minimal `.env` shape:

```bash
PANDA_GATEWAY_BASE_URL=https://gateway.example.com
PANDA_GATEWAY_PUBLIC_HOST=gateway.example.com
PANDA_GATEWAY_EDGE_SUBNET=172.31.94.0/24

GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=8094
GATEWAY_IP_ALLOWLIST=203.0.113.10/32
GATEWAY_GUARD_MODEL=openai-codex/gpt-5.5
```

`docker-stack.sh` sets `GATEWAY_TRUSTED_PROXY_IPS` to `PANDA_GATEWAY_EDGE_SUBNET` when it is not explicit. Keep the allowlist on the real client IPs; Caddy replaces `X-Forwarded-For` with `{remote_host}` before proxying.

Run:

```bash
./scripts/docker-stack.sh up --build
./scripts/docker-stack.sh logs gateway
```
