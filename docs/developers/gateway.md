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
