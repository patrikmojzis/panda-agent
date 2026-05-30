# Control session heartbeat writes

Control exposes a narrow write surface for session heartbeat configuration. It updates only future scheduled heartbeat wakes; it does not fire now, wake a runner immediately, or accept caller-supplied scheduling timestamps.

## API

All endpoints require an authenticated Control session:

- `GET /api/control/agents/:agentKey/sessions/:sessionId/heartbeat`
- `PATCH /api/control/agents/:agentKey/sessions/:sessionId/heartbeat` with JSON `{ "enabled": true, "everyMinutes": 30, "confirm": "update-heartbeat" }`

The response shape is `{ heartbeat }`, where `heartbeat` includes `agentKey`, `sessionId`, `enabled`, `everyMinutes`, `nextFireAt`, and `lastFireAt` when present.

## Authorization and safety

Heartbeat access is fail-closed. The operator must have:

1. a valid Control session;
2. an active Control grant for the target agent (`admin` or matching `scoped` grant);
3. an identity-agent pairing for the target agent;
4. a target session whose `agent_key` matches the `:agentKey` path segment.

There is intentionally no per-session ACL layer in this slice.

## CSRF, validation, and audit

`PATCH` requires the existing Control CSRF header (`x-control-csrf` or `x-csrf-token`). The body accepts only `enabled`, `everyMinutes`, and `confirm`; fields such as `nextFireAt` or `fireNow` are rejected.

Control enforces a stricter minimum cadence than the store: `everyMinutes` must be an integer of at least 15 minutes. Enabling, disabling, or reducing cadence requires `confirm: "update-heartbeat"`.

Successful `PATCH` calls the session store with the current server time as `asOf`, so the store owns `nextFireAt` semantics. Control audit metadata is redacted to old/new `enabled`, `everyMinutes`, `nextFireAt`, and `lastFireAt` only.

The Control UI includes a minimal Session heartbeat page under `/heartbeat`; enter an agent key and session id to view or edit the config.
