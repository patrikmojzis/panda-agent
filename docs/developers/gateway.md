# Gateway

Panda Gateway is the public server-to-server ingress for external apps.

Production deployments must terminate TLS before the gateway. Public binds require `GATEWAY_IP_ALLOWLIST`
unless `GATEWAY_ALLOW_PUBLIC_WITHOUT_IP_ALLOWLIST=true` is set explicitly.

It is deliberately separate from Panda core:

- gateway accepts public HTTP
- gateway auth resolves one source to one agent route
- gateway stores events and uploaded attachment metadata first
- gateway worker guards text plus attachment metadata, applies policy, then writes Panda thread input
- gateway worker uses the shared drain-loop pattern; do not reintroduce a
  bespoke timer/poke/close loop in this public ingress path
- gateway network controls live in `src/integrations/gateway/network-controls.ts`
  so IP allowlist and trusted-proxy policy stay pure and directly testable
- gateway HTTP body parsing lives in `src/integrations/gateway/http-body.ts`;
  route dispatch should not inline byte-limit, JSON, or token-body parsing
- Panda core does not expose this public HTTP surface

## Public API

### OAuth source tokens

Token:


```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=...&client_secret=...
```

Text-only event:

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

Attachment upload:

```http
POST /v2/attachments
Authorization: Bearer <access_token>
Idempotency-Key: <stable-upload-key>
Content-Type: image/png
X-Filename: screenshot.png
X-Content-Sha256: <optional 64-hex digest>

<raw bytes>
```

Attachment-aware event:

```http
POST /v2/events
Authorization: Bearer <access_token>
Idempotency-Key: <stable-event-key>
Content-Type: application/json
```

```json
{
  "type": "meeting.transcript",
  "delivery": "queue",
  "occurredAt": "2026-04-28T10:00:00Z",
  "text": "Short summary or instructions from the external app.",
  "attachments": [
    {"id": "<attachmentId>", "sha256": "<optional 64-hex digest>"}
  ]
}
```

`delivery` is only `queue` or `wake`. Event type policy may downgrade `wake` to `queue`.
Token requests must use `application/x-www-form-urlencoded` or `application/json`.
Event requests must use `application/json`; the gateway rejects ambiguous public
bodies before parsing. `/v1/events` is intentionally text-only and rejects an
`attachments` key; use `/v2/attachments` plus `/v2/events` when files are needed.

### Gateway device tokens (PR1 registry)

Gateway sources may register one or more devices, each with its own bearer token
and capability set. Device tokens are write-only (stored hashed) and can be
rotated/disabled independently without touching the source OAuth credentials.

Device tokens are currently accepted for:

- `POST /v2/attachments` (requires `upload_attachments`)
- `POST /v2/events` (requires `push_context`)

Register a device token with the CLI:

```bash
panda gateway device register work-prod macbook-pro --label "MacBook Pro"
# Optional: repeatable capability flags
panda gateway device register work-prod macbook-pro --capability push_context --capability upload_attachments
```

List/enable/disable/rotate:

```bash
panda gateway device list work-prod
panda gateway device disable work-prod macbook-pro
panda gateway device enable work-prod macbook-pro
panda gateway device rotate-token work-prod macbook-pro
```

Capabilities are a small allowlist (unknown strings are rejected):

- `push_context`
- `upload_attachments`
- `claim_commands` (reserved for PR2)
- `screenshot.capture` (reserved for PR2)

## Safety Rules

- Clients never send `agentKey`, `identityId`, `sessionId`, or `sourceId`.
- OAuth client credentials resolve to a registered gateway source.
- Token, event, and attachment bodies must declare a supported `Content-Type`.
- Attachment uploads use bounded raw bodies only: no multipart, resumable uploads, base64 JSON, or public download URLs.
- Uploaded bytes are stored under the target agent media root as untrusted local media descriptors.
- Event attachment refs must belong to the same source, be unexpired, unbound, and digest-matched when a digest is supplied.
- Event types must be explicitly allowed per source.
- Unknown event types are rejected and strike the source.
- `riskScore >= 0.85` quarantines the event, skips delivery, and strikes the source.
- Panda receives the raw text wrapped as untrusted external data plus local attachment descriptors/paths.
- Gateway event text is scrubbed after delivery or quarantine. The event keeps hash, byte count, and metadata.
- Attachment bytes have separate upload, retention, quarantine, and scrub status; `panda gateway attachment-scrub-expired` deletes expired bytes while keeping metadata.
- Gateway Postgres table creation lives in `src/domain/gateway/postgres-schema.ts`; keep public-ingress behavior in `PostgresGatewayStore` and HTTP/worker adapters.
- Files are not v1. Text-only clients stay on `/v1/events`.

## Network Controls

`GATEWAY_IP_ALLOWLIST` accepts comma-separated IPs or CIDRs. If the gateway runs behind a reverse proxy, set `GATEWAY_TRUSTED_PROXY_IPS` to the proxy IP/CIDR and configure the proxy to strip incoming `X-Forwarded-For` before setting its own value. The gateway ignores `X-Forwarded-For` unless the direct peer is trusted.

Budgets are stored in Postgres, not local process memory:

- `GATEWAY_RATE_LIMIT_PER_MINUTE`
- `GATEWAY_TEXT_BYTES_PER_HOUR`
- `GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE`
- `GATEWAY_ATTACHMENT_BYTES_PER_HOUR`
- `GATEWAY_MAX_PENDING_ATTACHMENTS_PER_SOURCE`

Attachment defaults:

- `GATEWAY_MAX_ATTACHMENT_BYTES=10485760` (10 MiB per file)
- `GATEWAY_MAX_ATTACHMENTS_PER_EVENT=5`
- `GATEWAY_MAX_EVENT_ATTACHMENT_BYTES=26214400` (25 MiB per event)
- `GATEWAY_ATTACHMENT_UPLOAD_TTL_MS=3600000`
- `GATEWAY_ATTACHMENT_RETENTION_MS=604800000`
- `GATEWAY_ATTACHMENT_QUARANTINE_TTL_MS=86400000`
- `GATEWAY_ATTACHMENT_ALLOWED_MIME_TYPES` defaults to plain text, JSON, PDF, common images, and common audio MIME types.

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
panda gateway attachment-scrub-expired --limit 100
```

## Docker Stack

The stack runs gateway as its own process:

- `panda-gateway` handles `/oauth/token`, `/v1/events`, `/v2/attachments`, `/v2/events`, and `/health`
- Caddy terminates TLS on the public URL
- `panda-gateway` and Caddy share `gateway_edge_net`
- `panda-gateway` never joins `runner_net`
- `panda-gateway` runs with `DATA_DIR=/root/.panda` and mounts `${HOME}/.panda/agents:/root/.panda/agents` read-write so attachment paths match Panda core and runners

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
