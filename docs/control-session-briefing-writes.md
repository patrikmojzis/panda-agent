# Control session prompt writes

Control exposes write-capable session prompt endpoints for `brief`, `memory`, and `heartbeat`. The old `/briefing` endpoint stays as a compatibility alias for `brief`.

## API

All endpoints require an authenticated Control session:

- `GET /api/control/agents/:agentKey/sessions/:sessionId/briefing`
- `PUT /api/control/agents/:agentKey/sessions/:sessionId/briefing` with JSON `{ "content": "..." }`
- `DELETE /api/control/agents/:agentKey/sessions/:sessionId/briefing` with JSON `{ "confirm": "clear-session-briefing" }`
- `GET /api/control/agents/:agentKey/sessions/:sessionId/prompts`
- `GET /api/control/agents/:agentKey/sessions/:sessionId/prompts/:slug`
- `PUT /api/control/agents/:agentKey/sessions/:sessionId/prompts/:slug` with JSON `{ "content": "..." }`
- `DELETE /api/control/agents/:agentKey/sessions/:sessionId/prompts/:slug` with JSON `{ "confirm": "clear-session-prompt" }`

The `/briefing` response shape is `{ briefing }`; the generic single-prompt response is `{ prompt }`; the bundle response is `{ prompts }`. Prompt records include `agentKey`, `sessionId`, `slug`, `content`, `wasSet`, and timestamps when content exists.

## Authorization and safety

Prompt access is fail-closed. The operator must have:

1. a valid Control session;
2. an active Control grant for the target agent (`admin` or matching `scoped` grant);
3. an identity-agent pairing for the target agent;
4. a target session whose `agent_key` matches the `:agentKey` path segment.

There is intentionally no per-session ACL layer in this slice.

## CSRF, validation, and audit

`PUT` and `DELETE` require the existing Control CSRF header (`x-control-csrf` or `x-csrf-token`). Blank save content is rejected; clear the prompt instead. `DELETE` requires the explicit confirmation strings above.

Successful generic `PUT` and `DELETE` write `session_prompt_write`; `/briefing` writes keep using `session_briefing_write`. Audit metadata is redacted: old/new `wasSet`, `length`, and SHA-256 hash only. Raw prompt text is never written to the Control audit table.

The Control UI session Prompts tab edits all three prompt slots.
