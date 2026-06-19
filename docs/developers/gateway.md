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

### Private Health Auto Export JSON inbox

Health Auto Export JSON uses a dedicated private adapter, not generic Gateway
events. Enable it only with its own static bearer token:

```http
POST /v1/health/hae
Authorization: Bearer <GATEWAY_HAE_JSON_TOKEN>
Content-Type: application/json

<raw Health Auto Export JSON bytes>
```

The handler authenticates before reading the body, accepts JSON only, validates
syntax without health parsing, then writes the exact raw request bytes to the
configured inbox using a temp file followed by rename. It does not call
`/v1/events`, `/v2/events`, event storage, thread inputs, the Gateway worker, or
model-facing paths. The scheduled health importer can process the inbox later.

Response body is safe metadata only:

```json
{
  "ok": true,
  "accepted": true,
  "id": "<generated-id>",
  "filename": "20260616T184500Z-<generated-id>.json",
  "byteCount": 12345,
  "timestamp": "2026-06-16T18:45:00.000Z",
  "source": "health-auto-export"
}
```

Configuration:

- `GATEWAY_HAE_JSON_TOKEN` enables the route and is required for every request.
- `GATEWAY_HAE_JSON_INBOX_DIR` defaults to `/root/.panda/agents/clawd/health-auto-import-inbox`.
- `GATEWAY_HAE_JSON_MAX_BYTES` defaults to 26214400 (25 MiB).
- `GATEWAY_HAE_JSON_SOURCE` defaults to `health-auto-export` and is returned as metadata only.

Do not send HAE payloads through generic Gateway events or attachments. Do not
log, store, or expose raw health JSON outside the private inbox.

### Gateway device tokens and command mailbox

Gateway sources may register one or more devices, each with its own bearer token
and capability set. Device tokens are write-only (stored hashed) and can be
rotated/disabled independently without touching the source OAuth credentials.

Device tokens are accepted for:

- `POST /v2/attachments` (requires `upload_attachments`)
- `POST /v2/events` (requires `push_context`)
- `POST /v1/device/heartbeat`
- `POST /v1/device/commands/claim` and command lifecycle endpoints (requires `claim_commands` plus a command kind capability)

Register a device token with the CLI:

```bash
panda gateway device register work-prod macbook-pro --label "MacBook Pro"
# Optional: repeatable capability flags
panda gateway device register work-prod macbook-pro \
  --capability push_context \
  --capability upload_attachments \
  --capability claim_commands \
  --capability screenshot.capture
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
- `claim_commands`
- `screenshot.capture`

### Gateway Mac receiver setup

The macOS receiver is Gateway-only: heartbeat, explicit push-to-talk,
`Send Clipboard Text`, `Send Screenshot Now`, and opt-in interval screenshot
sends all use the Gateway HTTP device lane.

Create a source, allow the Mac event type, then register a device token with only
the capabilities this PR needs:

```bash
panda gateway source create mac-local --agent panda --identity patrik
panda gateway source allow-type mac-local mac.context.push --delivery wake
panda gateway device register mac-local home-mac \
  --label "Home Mac" \
  --capability push_context \
  --capability upload_attachments
```

Paste the printed one-time device token into the app settings or save it from the
CLI. The Mac keeps the token in Keychain; `config.json` stores the Gateway base
URL, agent key, device id, label, shortcuts, interval settings, and tunnel settings
but not the token.

```bash
swift build --package-path apps/panda-receiver-macos
apps/panda-receiver-macos/.build/arm64-apple-macosx/debug/panda-receiver-macos \
  --gateway http://127.0.0.1:8094 \
  --agent panda \
  --device-id home-mac \
  --token 'paste-device-token-here' \
  --label "Home Mac" \
  --save-config
```

Use `http://` or `https://` for `--gateway`; the receiver does not support WebSocket URLs.
If Gateway is private behind SSH, keep the Gateway URL as the remote endpoint and
add tunnel flags:

```bash
--ssh-host clankerino
--ssh-user patrik
--ssh-port 22
--tunnel-local-port 43190
```

The app forwards `127.0.0.1:<local-port>` to the Gateway host/port and sends HTTP
through that local port. The `--agent` value is retained for display and Keychain
account scoping; Gateway HTTP requests authenticate with the device bearer token
and do not send agent, source, session, or identity ids.

Operational notes:

- `mac.context.push` must stay allow-listed before testing; unexpected event
  types are rejected and can strike/suspend the source after repeated failures.
  Use `panda gateway source disallow-type mac-local mac.context.push` to revoke
  a type without deleting historical events.
- Push-to-talk uploads `audio/m4a` plus an optional `image/jpeg` screenshot via
  `/v2/attachments`, then posts `/v2/events` with attachment refs.
- `Send Clipboard Text` posts text only. `Send Screenshot Now` uploads one
  explicit screenshot and posts the same `mac.context.push` event type.
- The menu kill switch pauses health checks and local explicit sends. There is no
  hidden screenshot auto-start in this PR.

The command mailbox is durable Postgres polling, not WebSocket/SSE. It is the
Gateway device command path and stays separate from manual/interval pushes.

Admin enqueue/list/cancel/timeout sweep stays local CLI-backed DB access:

```bash
panda gateway device command enqueue work-prod macbook-pro screenshot.capture --payload-json '{"display":"main"}'
panda gateway device command list work-prod --device macbook-pro --status queued
panda gateway device command cancel work-prod macbook-pro <commandId> --reason "obsolete"
panda gateway device command timeout-sweep --source work-prod --stale-ms 300000 --limit 100
```

Device heartbeat:

```http
POST /v1/device/heartbeat
Authorization: Bearer <device_token>
Content-Type: application/json

{}
```

Claim/long-poll:

```http
POST /v1/device/commands/claim
Authorization: Bearer <device_token>
Content-Type: application/json

{"waitMs":30000,"kinds":["screenshot.capture"]}
```

Empty response after waiting:

```json
{"ok":true,"claimed":false}
```

Claimed response:

```json
{
  "ok": true,
  "claimed": true,
  "command": {
    "id": "<commandId>",
    "kind": "screenshot.capture",
    "payload": {},
    "claimId": "<claimId>",
    "createdAt": "2026-04-28T10:00:00.000Z"
  }
}
```

Long-poll loop sketch:

```text
while running:
  POST /v1/device/heartbeat
  POST /v1/device/commands/claim {waitMs: 30000}
  if claimed:
    do work
    optionally POST /v2/attachments with result bytes
    POST /v1/device/commands/<id>/complete {claimId, result, resultAttachmentId}
  else:
    continue
```

Lifecycle endpoints:

```http
POST /v1/device/commands/<commandId>/heartbeat
{"claimId":"<claimId>"}

POST /v1/device/commands/<commandId>/complete
{"claimId":"<claimId>","result":{},"resultAttachmentId":"<attachmentId>"}

POST /v1/device/commands/<commandId>/fail
{"claimId":"<claimId>","status":"failed","error":"..."}
```

Only admins can cancel queued commands. Claimed commands finish by heartbeat plus
complete/fail/reject, or become `timed_out` only when an admin runs the stale
claim sweep. Device-uploaded result attachments must be from the same source,
same device connector key, still `uploaded`, and unexpired; completion marks them
`delivered` and extends retention.

## Safety Rules

- Clients never send `agentKey`, `identityId`, `sessionId`, or `sourceId`.
- OAuth client credentials resolve to a registered gateway source.
- Token, event, and attachment bodies must declare a supported `Content-Type`.
- Attachment uploads use bounded raw bodies only: no multipart, resumable uploads, base64 JSON, or public download URLs.
- Health Auto Export JSON uses only `/v1/health/hae` and a dedicated static token; it writes raw JSON bytes to the private inbox and never creates Gateway events, thread inputs, or model-facing content.
- Uploaded bytes are stored under the target agent media root as untrusted local media descriptors.
- Device-uploaded events and attachments remain `external_untrusted` even after device pairing.
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
- `GATEWAY_DEVICE_COMMAND_MAX_WAIT_MS` (default/cap for device command long-polling)

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
panda gateway source allow-type work-prod mac.context.push --delivery wake
panda gateway source disallow-type work-prod old.event.type # idempotent; keeps historical events
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

- `panda-gateway` handles `/oauth/token`, `/v1/events`, `/v2/attachments`, `/v2/events`, optional `/v1/health/hae`, and `/health`
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

# Optional private Health Auto Export JSON inbox
GATEWAY_HAE_JSON_TOKEN=<dedicated-random-token>
GATEWAY_HAE_JSON_INBOX_DIR=/root/.panda/agents/clawd/health-auto-import-inbox
GATEWAY_HAE_JSON_SOURCE=health-auto-export
```

`docker-stack.sh` sets `GATEWAY_TRUSTED_PROXY_IPS` to `PANDA_GATEWAY_EDGE_SUBNET` when it is not explicit. Keep the allowlist on the real client IPs; Caddy replaces `X-Forwarded-For` with `{remote_host}` before proxying.

Run:

```bash
./scripts/docker-stack.sh up --build
./scripts/docker-stack.sh logs gateway
```
