# Control session briefing writes

Control exposes a narrow write-capable slice for the fixed session brief prompt (`SESSION_BRIEF_PROMPT_SLUG`, currently `brief`). The endpoint name stays `/briefing`; it is not an arbitrary prompt editor.

## API

All endpoints require an authenticated Control session:

- `GET /api/control/agents/:agentKey/sessions/:sessionId/briefing`
- `PUT /api/control/agents/:agentKey/sessions/:sessionId/briefing` with JSON `{ "content": "..." }`
- `DELETE /api/control/agents/:agentKey/sessions/:sessionId/briefing` with JSON `{ "confirm": "clear-session-briefing" }`

The response shape is `{ briefing }`, where `briefing` includes `agentKey`, `sessionId`, `slug`, `content`, `wasSet`, and timestamps when a prompt exists.

## Authorization and safety

Briefing access is fail-closed. The operator must have:

1. a valid Control session;
2. an active Control grant for the target agent (`admin` or matching `scoped` grant);
3. an identity-agent pairing for the target agent;
4. a target session whose `agent_key` matches the `:agentKey` path segment.

There is intentionally no per-session ACL layer in this slice.

## CSRF, validation, and audit

`PUT` and `DELETE` require the existing Control CSRF header (`x-control-csrf` or `x-csrf-token`). Blank save content is rejected; clear the briefing instead. `DELETE` requires the explicit confirmation string above.

Successful `PUT` and `DELETE` write a generic Control audit event. Audit metadata is redacted: old/new `wasSet`, `length`, and SHA-256 hash only. Raw briefing text is never written to the Control audit table.

The Control UI includes a minimal Session briefing page under `/briefing`; enter an agent key and session id to open the edit/clear view.
