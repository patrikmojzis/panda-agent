# Discord Voice Codex Backend Plan

## Outcome

Make Panda establish `gpt-live-1-codex` sessions without running `codex
app-server` or shipping a Codex binary in the Discord worker.

Panda will create the WebRTC call through the ChatGPT Codex backend and retain
its existing direct GPT-Live sideband and Discord media bridge:

```text
Discord <-> Panda WebRTC/media
                |
                +-- POST https://chatgpt.com/backend-api/codex/realtime/calls
                |        ?intent=quicksilver&architecture=avas
                |
                +-- WSS  wss://api.openai.com/v1/live/{callId}
```

The query value is `avas`, not `ava`.

## Verified Contract

A local probe using Panda's current Werift peer and Codex OAuth, with no
`codex app-server` process involved, produced:

- HTTP `201` from ChatGPT call creation
- an accepted SDP answer and connected WebRTC media
- an opened direct GPT-Live sideband WebSocket

The call request uses:

- `POST /backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`
- JSON body `{ "sdp": <offer>, "session": <frameless-session> }`
- `Authorization: Bearer <Codex OAuth access token>`
- `ChatGPT-Account-ID: <account id>`
- `OpenAI-Alpha: quicksilver=v2`
- bounded session/thread correlation headers and the Codex originator header

The session is created with `gpt-live-1-codex`, voice `cove`, and client-managed
delegation. The sideband does not send another `session.update`; the session was
already supplied during call creation.

## Scope

### 1. Switch call creation to the ChatGPT backend

Update `src/integrations/providers/openai-live/wire.ts`:

- replace the direct `https://api.openai.com/v1/live` call URL with the verified
  ChatGPT backend URL
- replace the multipart encoder with a bounded JSON body containing `sdp` and
  `session`
- keep SDP response and `Location` call-id parsing bounded
- accept both `200` and `201` success through normal `Response.ok` handling
- retain `wss://api.openai.com/v1/live/{callId}` for the sideband
- do not fall back to direct `/v1/live`; its `403` is ambiguous and fallback
  would hide contract drift

Keep the private URL, headers, body shape, and call-id parsing inside this
provider adapter.

### 2. Align the frameless session

In the same provider module:

- set the default voice to `cove`
- use the Codex V3 voice set rather than silently replacing `cove` with a legacy
  GPT-Live voice
- keep the model fixed to `gpt-live-1-codex`
- retain `delegation: { type: "client" }`
- keep the existing concise Panda voice instructions and result chunk bounds

Reject an unsupported configured voice during startup instead of silently
changing it. A bad voice can otherwise look like an account-level `403`.

### 3. Correct bridge readiness

Update `src/integrations/providers/openai-live/bridge.ts`:

- define successful startup as both WebRTC media connected and sideband
  WebSocket opened
- do not require an immediate `session.started` event for a sideband joining an
  already-created frameless WebRTC call
- start the 30-minute local expiry timer when startup completes; tighten it if a
  later provider event supplies an earlier expiry
- continue treating startup error events, socket closure, and media failure as
  rollback conditions
- preserve barge-in, delegation correlation, stale-result suppression, and
  complete teardown

### 4. Keep authentication deliberately read-only

Keep `src/integrations/providers/openai-live/auth.ts` responsible for resolving
fresh auth for each join:

- read `OPENAI_OAUTH_TOKEN` or `CODEX_HOME/auth.json`
- derive and validate `chatgpt_account_id`
- reject expired tokens as `auth_unavailable`
- never log or persist the bearer

The Discord worker continues to mount Codex auth read-only. Automatic refresh is
the next tracked item in `docs/developers/discord-voice-todo.md`, not part of
this change.

### 5. Tests

Update the focused provider tests:

- `tests/openai-live-wire.test.ts`
  - exact ChatGPT URL and `avas` query
  - JSON body rather than multipart
  - Codex OAuth/account/alpha/correlation headers
  - `cove` and client delegation session shape
  - `201`, missing call id, oversized response, and secret-safe failures
- `tests/openai-live-bridge.test.ts`
  - startup succeeds after media connection plus sideband open without a
    `session.started` event
  - an early error or close still fails startup and closes partial resources
  - a later expiry event can shorten the local TTL
  - delegation, result append, barge-in, and cleanup remain intact

Retain the fake Discord end-to-end flow. Add an opt-in live probe for manual
verification; never call the private endpoint from ordinary CI.

## Acceptance

- `panda discord voice join` reaches `connected` while `codex app-server` is not
  running and no Codex binary exists in the Discord container.
- A spoken casual turn produces audio.
- A substantive turn creates one durable Panda delegation and speaks its fresh
  result.
- `status`, barge-in, and `leave` behave as before.
- Expired or rejected OAuth reports `auth_unavailable` without exposing secrets.
- No request uses direct call creation at `api.openai.com/v1/live`.
- Partial startup and worker shutdown leave no voice, peer, socket, or session
  ownership behind.

## Verification

Run:

```bash
pnpm exec vitest run tests/openai-live-wire.test.ts tests/openai-live-bridge.test.ts tests/discord-voice-manager.test.ts
pnpm typecheck
pnpm architecture:import-law:ratchet
pnpm agent-command-shim:check
pnpm ci:prompt-contracts
```

Run the opt-in secret-safe live transport probe with `codex app-server` stopped:

```bash
PANDA_DISCORD_VOICE_LIVE_TEST=true pnpm exec vitest run --config vitest.live.config.ts tests/live/openai-live-backend.live.test.ts
```

Then perform a real Discord join, casual exchange, delegation, barge-in, and
leave. Run disposable-database `pnpm smoke` if the final diff reaches runtime,
command, or durable handoff code beyond the provider adapter.

## Non-goals

- automatic OAuth refresh or writable auth storage
- API-key or public Realtime fallback
- automatic voice rejoin after restart or expiry
- moving Discord media or Panda delegation into Codex
- compatibility guarantees for the undocumented backend contract
