# WhatsApp Live Voice Calling

**Status:** Implemented for inbound user-initiated calls; outbound dialling remains deferred

**Date:** 31 August 2026

**Scope:** Architecture and implementation plan

**Decision:** Use Meta's official WhatsApp Business Calling interface; do not extend Baileys into a private calling stack.

## Abstract

Panda should add WhatsApp calls as a transport adapter around the existing channel-neutral live-voice runtime. Meta's official WhatsApp Business Calling signalling and WebRTC media path will terminate inside the WhatsApp worker, while `LiveVoiceCall` will continue to own turn arbitration, barge-in, GPT-Live interaction, durable Panda delegation and recovery. A shared call-start module will resolve the agent's live-voice preference, render transport-aware provider instructions, persist the immutable call snapshot and construct the provider session. Baileys remains the linked-device messaging transport because its public surface does not provide a supported bidirectional calling implementation (WhiskeySockets, 2026a; WhiskeySockets, 2023).

The first release should support inbound, user-initiated calls on a dedicated Meta test number. Outbound dialling should be deferred until the inbound path is reliable and the account's regional, permission and pricing constraints are confirmed. This plan adopts the per-agent voice, session snapshot and environment hard-cut decisions from the companion live-voice configuration plan (Panda Agent, 2026c). WhatsApp must not introduce another voice selector, provider flag or provider-specific prompt path.

## 1. Background and problem statement

Panda already has most of the difficult conversational machinery: generic live-voice sessions and turns, a provider seam, durable delegation to the owning Panda session, playback interruption, recovery and diagnostics. The current developer contract explicitly requires a future WhatsApp adapter to supply decoded 24 kHz mono PCM, implement `LiveVoiceOutput`, use the generic session and turn stores, and preserve transport-native lifecycle controls (Panda Agent, 2026a).

Three gaps remain. First, Panda has no WhatsApp WebRTC signalling or media transport. Second, one GPT-Live instruction currently names Discord directly, which prevents the provider adapter from being truly channel-neutral (Panda Agent, 2026b). Third, provider and feature configuration is currently read inside Discord-specific modules even though WhatsApp will run in a separate worker process. The second real transport now justifies one deeper call-start module, but not a universal transport interface.

## 2. Aim and objectives

The aim is to support reliable inbound WhatsApp voice calls while preserving Panda's existing session, identity and delegation model.

The implementation will:

1. accept user-initiated WhatsApp Business calls through Meta's official calling flow;
2. authorise the exact caller and require an existing Panda conversation binding;
3. bridge negotiated Opus media to the existing `LiveVoiceCall` boundary;
4. preserve `/reset` semantics by resolving `session.current_thread_id` only when durable work is delegated;
5. use the agent's durable live-voice preference and preserve it as an immutable call snapshot;
6. expose explicit call status, speech and hang-up commands to the owning Panda session;
7. retain no raw audio, SDP, access tokens or telephone numbers in durable turns or logs;
8. use one deployment kill switch and one OpenAI Live configuration contract across voice-capable processes; and
9. produce transport-specific diagnostics without contaminating the reusable live-voice core.

## 3. Architectural decision

### 3.1 Selected approach

Use a WhatsApp Cloud Calling connector mode backed by Meta Graph signalling and WebRTC. Meta's documented user-initiated flow uses webhook-delivered call events and explicit `pre_accept` and `accept` operations (Meta Platforms, 2026a; Meta Platforms, 2026b). The WhatsApp worker will own that protocol because connector workers are the correct boundary for channel-specific authentication, parsing, media and delivery policy.

The end-to-end path will be:

```text
WhatsApp caller
  -> signed Meta webhook and SDP offer
  -> WhatsAppCallManager
       verify signature and bound body size
       authorise the exact caller
       resolve conversation to Panda session
       establish the Meta WebRTC peer
  -> LiveVoiceCallStarter
       load and validate agent.liveVoice
       render WhatsApp-aware provider instructions
       persist provider, model and voice snapshot
       start GPT-Live and LiveVoiceCall
  -> decoded 24 kHz mono PCM
  -> LiveVoiceCall
       low-latency casual speech
       provider-authoritative barge-in and recovery
       durable Panda delegation
  -> session.current_thread_id, resolved at delegation time
  -> Panda tools and memory
  -> WhatsApp call output or hang-up control
```

### 3.2 Rejected approach

Do not add calling to Baileys. Panda currently uses Baileys for linked-device messaging, but Baileys exposes call events rather than a supported end-to-end media implementation, and upstream closed its general calls-support request as not planned (WhiskeySockets, 2023). Implementing the private consumer WhatsApp VoIP stack would be brittle, security-sensitive and operationally unjustified.

If the existing linked-device number cannot use Meta Cloud Calling, the first release will use a separate test number. Existing Baileys messaging behaviour must remain unchanged.

### 3.3 Configuration ownership

Configuration follows the module that owns the decision:

| Concern | Owner |
|---|---|
| Agent's selected synthesised voice | `runtime.agents.live_voice` |
| Effective provider, model and voice | Immutable `runtime.live_voice_sessions` snapshot |
| Deployment emergency disable | `PANDA_LIVE_VOICE_ENABLED` |
| OpenAI Live wire tuning | `PANDA_OPENAI_LIVE_*` process configuration |
| Codex OAuth location | `CODEX_HOME` and its read-only host mount |
| Meta account identifiers and calling mode | WhatsApp connector-account config |
| Meta access token and webhook secrets | Encrypted connector credentials |
| Webhook bind, media budgets and database pool | `PANDA_WHATSAPP_*` process configuration |

Environment variables must not represent agent preferences, connector identity or Meta secrets. Connector config must not contain OpenAI provider tuning. The live session snapshot is the observable record of what a particular call actually used.

## 4. Proposed implementation

### 4.1 Deepen call-start and provider session creation

Add a shared call-start module under `src/integrations/voice`. Its narrow interface accepts the transport identity, owning agent and Panda session, `LiveVoiceOutput`, provider definition and semantic prompt context. Behind that interface it:

1. loads the active agent through a narrow agent-store seam;
2. validates `agent.liveVoice` through the selected provider definition;
3. renders transport-aware instructions through an editable module under `src/prompts`;
4. persists the connecting live session with provider, model and voice;
5. creates the provider session with immutable voice and instructions; and
6. constructs `LiveVoiceCall`.

Evolve the provider-definition seam once so Discord and WhatsApp do not perform parallel provider construction:

```ts
provider.createSession(
  {voice: effectiveVoice, instructions: renderedInstructions},
  callbacks,
);
```

The current hard-coded Discord instruction must leave the OpenAI wire implementation (Panda Agent, 2026b). Transports supply semantic facts such as source and leave capability; they do not own raw provider prompts. OpenAI call creation, authentication, voice catalogue validation, sideband parsing and wire shapes remain private to the OpenAI Live adapter.

Discord must migrate to this module before WhatsApp is added. With two transports, the seam now has real leverage: agent lookup, voice validation, snapshot persistence and provider creation stay local instead of being copied into both managers.

### 4.2 Apply the environment and OAuth hard cut

Adopt the channel-neutral variables from the per-agent configuration plan (Panda Agent, 2026c):

```text
PANDA_LIVE_VOICE_ENABLED=false
PANDA_OPENAI_LIVE_DELEGATION_ACK_FILLER=
PANDA_OPENAI_LIVE_SIDEBAND_PING_MS=0
CODEX_HOME=/root/.codex
```

Delete all readers and deployment entries for:

```text
PANDA_DISCORD_VOICE_VOICE
PANDA_DISCORD_VOICE_EXPERIMENTAL
PANDA_DISCORD_VOICE_DELEGATION_ACK_FILLER
PANDA_DISCORD_VOICE_SIDEBAND_PING_MS
```

`PANDA_LIVE_VOICE_ENABLED` is a fail-closed infrastructure gate, not the product source of truth. Parse it through one shared, pure configuration module once per process. The same deployment value must be injected into `panda-core` for command availability, `panda-discord` for Discord worker startup and `panda-whatsapp` for call acceptance. Status and startup logs should expose the effective boolean so process drift is visible.

Only voice-capable channel workers need `PANDA_OPENAI_LIVE_*` and Codex OAuth. Add `CODEX_HOME=/root/.codex` and the read-only `${CODEX_HOST_HOME:-${HOME}/.codex}:/root/.codex:ro` mount to `panda-whatsapp`, matching Discord. `OPENAI_OAUTH_TOKEN` remains a bounded testing override rather than the recommended deployment path.

Automatic OAuth refresh is outside this implementation. When added, it must coordinate across all voice-capable worker processes, reload `auth.json` after acquiring a cross-process lock and replace rotated credentials atomically. Per-worker locking alone is insufficient once Discord and WhatsApp share the auth file.

Do not add `PANDA_WHATSAPP_VOICE_ENABLED` or any WhatsApp-prefixed provider option. WhatsApp-prefixed environment variables remain appropriate only for native listener settings, media budgets, health ports and database pools.

### 4.3 Add a Meta Cloud connector mode

Extend the WhatsApp connector definition with an explicit connection mode and calling configuration:

```json
{
  "mode": "meta_cloud",
  "calling": {
    "enabled": true,
    "phoneNumberId": "...",
    "wabaId": "...",
    "graphVersion": "v..."
  }
}
```

Store `meta_access_token`, `meta_app_secret` and `meta_verify_token` as encrypted connector credentials. When `mode` is absent, preserve the existing Baileys linked-device behaviour. `meta_cloud` names the connector implementation without pretending the account can only ever carry calls. Initial rollout should still use a separate connector account so calling cannot destabilise established messaging.

Prerequisites are:

- a WhatsApp Business Cloud API number with Calling enabled;
- a Meta application secret, webhook verification token and suitable system-user access token;
- the relevant WhatsApp Business Account and phone-number identifiers; and
- a public HTTPS webhook subscribed to call events.

### 4.4 Add the WhatsApp calls transport

Create a cohesive transport module:

```text
src/integrations/channels/whatsapp/calls/
  webhook.ts
  meta-client.ts
  peer.ts
  capture.ts
  output.ts
  manager.ts
  controls.ts
  postgres.ts
  health.ts
  types.ts
```

The responsibilities are deliberately narrow:

- `webhook.ts`: bounded request bodies, verification challenges, timing-safe HMAC validation and duplicate-event handling;
- `meta-client.ts`: `pre_accept`, `accept`, `reject` and `terminate` Graph operations;
- `peer.ts`: Werift SDP, ICE, DTLS-SRTP, RTP and Opus negotiation;
- `capture.ts`: conservative caller speech segmentation and PCM delivery;
- `output.ts`: the WhatsApp implementation of `LiveVoiceOutput`;
- `manager.ts`: active-call ownership, startup ordering, failure rollback and teardown;
- `controls.ts` and `postgres.ts`: durable command handoff to the owning worker; and
- `health.ts`: signalling, peer and media diagnostics.

The public webhook listener should run inside `panda-whatsapp`, not the generic gateway. This keeps Meta protocol and credentials local and avoids weakening the gateway's existing network policy. The listener starts when at least one enabled `meta_cloud` connector has calling configured. When the deployment gate is disabled, it may still serve webhook verification and health but must reject call offers before provider or media startup.

### 4.5 Bridge media through the existing live-voice seam

Inbound media will:

1. accept the negotiated Opus payload type;
2. reorder RTP within a bounded window and apply packet-loss concealment where available;
3. decode to mono PCM and resample to 24 kHz; and
4. drive the existing capture begin, push and end boundary.

Outbound media will:

1. accept 24 kHz mono PCM from `LiveVoiceOutput`;
2. resample to the negotiated codec rate;
3. encode 20 ms Opus frames;
4. emit correct sequence numbers, timestamps, SSRC and negotiated dynamic payload type; and
5. use a bounded playout queue with observable starvation and overflow counters.

Local voice activity detection may delimit captured utterances, but it must not clear provider output. Only a GPT-Live output-clear or explicit call teardown should interrupt playback. This preserves the provider-authoritative turn-state behaviour already adopted for Discord.

Shared RTP or Opus primitives should be extracted only when the WhatsApp implementation demonstrates genuine duplication with Discord. The call-start module is justified by two callers; a broad `CallTransport` interface remains premature because Meta and Discord signalling lifecycles are materially different.

### 4.6 Secure routing, concurrency and durable delegation

The worker must reuse the existing WhatsApp actor authoriser, require an existing conversation binding and reject unpaired or unbound callers. A live call will map into generic persistence as follows:

| Generic field | WhatsApp value |
|---|---|
| `source` | `whatsapp` |
| `connectorKey` | Cloud Calling connector key |
| `scopeKey` | WhatsApp call ID |
| `roomKey` | WhatsApp call ID |
| `externalActorId` | Omitted so the caller phone never enters a durable turn |
| `identityId` | Authorised Panda identity |
| `transportAuthorization` | Non-PII identity, agent, actor-binding and grant-version snapshot |

The generic active-scope uniqueness rule includes `scopeKey`; using the phone-number ID would accidentally limit a connector to one active call. The opaque call ID therefore owns call lifecycle uniqueness. Store the Meta phone-number ID only in bounded `transportContext` and transport diagnostics. Concurrency limits belong to the WhatsApp manager and provider capacity rather than an incidental database collision.

Durable delegation will target the stored Panda session, then resolve its current thread at the last responsible moment. It must not retain a thread ID across a call, provider wait or database claim. Before delivery, the daemon must revalidate the non-PII authority snapshot against the active connector account, actor binding, pairing, agent, conversation binding and session. The call-start module reads the agent voice only once; provider recovery reuses the persisted snapshot and never rereads the agent. Raw PCM, SDP, tokens and telephone numbers must never enter runtime turns, prompts or routine logs.

### 4.7 Add Panda call controls

Expose the following commands through the existing WhatsApp human-communication command group:

```text
panda whatsapp call status [--connector <key>]
panda whatsapp call send --text <message> [--mode progress|final] [--turn <id>]
panda whatsapp call hangup [--call <id>] [--turn <id>] [--connector <key>]
```

Their capabilities will be:

- `whatsapp.call.status`;
- `whatsapp.call.send`; and
- `whatsapp.call.hangup`.

Inbound calls do not need a `join` command. Outbound `dial` is deliberately deferred. `send` must preserve exactly-once progress/final semantics so retries cannot produce duplicated spoken responses.

### 4.8 Persistence and diagnostics

Reuse `runtime.live_voice_sessions`, `runtime.live_voice_turns`, their effective provider/model/voice snapshot and `LiveVoiceCall`. Add only `runtime.whatsapp_call_controls` for durable commands claimed by the WhatsApp worker. Do not add a WhatsApp voice-preference column or transport-specific session table.

Diagnostics should separate transport evidence from reusable voice evidence:

- webhook event and Meta call state;
- ICE, DTLS and peer-connection transitions;
- received and transmitted RTP packet counts;
- loss, reorder, decode and encode counters;
- output queue depth, starvation and last-media timestamps; and
- generic GPT-Live provider, delegation and terminal-failure state.

A worker restart marks calls disconnected and does not attempt to answer them again. The first release should cap calls at 30 minutes to match the current GPT-Live session lifecycle.

## 5. Delivery sequence

### Phase 0: eligibility and connectivity spike

Confirm that the selected Meta test number supports Calling, that call webhooks arrive with verifiable signatures, and that a minimal Werift peer completes ICE and exchanges audio. Stop here if account or regional eligibility blocks the official path.

### Phase 1: shared live-voice foundation

Implement the companion per-agent voice migration, environment hard cut, provider session options, prompt rendering and shared call-start module. Move Discord onto that module and prove its behaviour before introducing WhatsApp. This phase is independently valuable and prevents parallel provider/configuration paths.

### Phase 2: inbound minimum viable product

Implement Meta connector configuration, Codex auth mounting, webhook handling, caller authorisation, call-ID scoping, `pre_accept`/provider-ready/`accept` ordering, bidirectional media, generic live-session persistence, durable delegation and explicit hang-up.

### Phase 3: reliability and diagnostics

Add bounded RTP reordering, media queue instrumentation, concurrent-call coverage, duplicate-event protection, restart cleanup, exact-once send controls, configuration-state reporting, health reporting and failure-injection coverage.

### Phase 4: outbound calling

Consider `panda whatsapp call dial` only after inbound calling is stable and Meta permissions, regional availability, pricing and user-consent requirements are verified. Outbound dialling is not part of the initial implementation.

## 6. Verification strategy

The implementation should be protected at the public seams callers use.

### 6.1 Automated tests

- webhook challenge, signature, body-limit, rate-limit and duplicate-event tests;
- shared environment parsing and proof that removed Discord-prefixed variables have no readers;
- process-assembly tests proving the same kill switch reaches core, Discord and WhatsApp;
- provider-session tests for immutable voice and transport-aware rendered instructions;
- call-start tests covering agent lookup, catalogue validation, snapshot persistence and rollback;
- disabled connector, unknown caller, missing binding and authorisation-denial tests;
- missing Codex mount/auth tests that fail before Meta accepts the call;
- strict `pre_accept` -> provider ready -> `accept` ordering tests;
- partial-startup rollback, remote termination, local hang-up and worker-shutdown tests;
- Werift-to-Werift integration tests acting as a fake Meta peer with real Opus media;
- codec, resampling, packet-loss, silence segmentation and bounded-queue tests;
- two concurrent call IDs on the same Meta phone-number ID without active-scope conflict;
- provider-authoritative barge-in and stale-audio tests;
- the same agent selecting the same snapshotted voice on Discord and WhatsApp;
- provider recovery retaining the call-start voice after the agent preference changes;
- delegation tests proving current-thread resolution after `/reset`;
- exactly-once progress/final command tests; and
- secret-safe logging and persistence tests.

### 6.2 Repository checks

Run:

```text
pnpm typecheck
pnpm exec vitest run <focused WhatsApp call and live-voice suites>
pnpm architecture:import-law:ratchet
pnpm agent-command-shim:check
pnpm ci:prompt-contracts
pnpm smoke
```

Smoke testing must use a disposable `TEST_DATABASE_URL`. The final acceptance test is a real inbound call to the Meta test number covering casual GPT-Live speech, durable Panda delegation, progress speech, final speech and explicit hang-up.

## 7. Acceptance criteria

The inbound release is ready when:

1. an authorised, bound caller can establish a call and exchange intelligible audio;
2. an unauthorised or unbound caller is rejected without starting GPT-Live;
3. the global kill switch disables call acceptance and related agent commands without a transport-specific feature flag;
4. Meta signalling is accepted only after both WebRTC and GPT-Live are ready;
5. the call uses the agent's voice and reports the same immutable snapshot through recovery;
6. multiple call IDs on one Meta phone number do not collide in generic session persistence;
7. casual responses and delegated Panda responses are each spoken exactly once;
8. barge-in interrupts only the active provider output and does not cancel durable Panda work;
9. `/reset` during an active call causes subsequent delegation to use the new current thread;
10. all partial failures close the peer, provider and live-session record consistently;
11. logs distinguish configuration, signalling, media, provider and delegation failures without secrets; and
12. existing Baileys messaging and Discord voice behaviour remain unchanged.

## 8. Principal risks and mitigations

| Risk | Mitigation |
|---|---|
| Meta account, region or number is not eligible | Prove eligibility in Phase 0 with a dedicated test number before product work. |
| Signalling succeeds but media negotiation differs from the test peer | Capture bounded, secret-safe SDP and codec summaries; exercise dynamic payload types in integration tests. |
| Audio repeats or truncates | Use one bounded playout owner, provider-authoritative clearing and exact-once call controls. |
| A call bypasses Panda identity policy | Require exact actor authorisation and an existing conversation binding before provider startup. |
| Environment values drift between processes | Parse one shared contract, inject one Compose value into all participating processes and expose the effective gate in diagnostics. |
| WhatsApp cannot authenticate to GPT-Live | Mount the same read-only Codex home into every voice-capable worker and fail before `accept` when auth is unavailable. |
| Future OAuth refresh races across channel workers | Require a cross-process lock, reload-after-lock and atomic replacement; do not rely on per-worker serialisation. |
| The new transport destabilises existing WhatsApp messaging | Use an explicit `meta_cloud` connector mode and a separate connector account initially. |
| Phone-number scoping silently permits only one call | Use the opaque call ID as `scopeKey`; keep phone-number identity in transport context. |
| OpenAI-specific voice values leak into transport configuration | Keep the preference on the agent, validate through the provider catalogue and snapshot provider/model/voice on the call. |
| Premature abstraction makes both call transports harder to change | Deepen only proven call-start behaviour; keep Meta and Discord signalling and lifecycle local. |
| Provider expiry leaves a zombie call | Terminate the WhatsApp call and mark the generic session disconnected on terminal provider failure or the 30-minute cap. |

## 9. Conclusion

The correct path is a thin, official Meta transport around a deeper call-start module and Panda's existing live-call core. Agent preference, effective call state, provider configuration and connector configuration now have distinct owners. Panda should not reverse-engineer consumer WhatsApp calling, duplicate Discord environment variables or generalise native transport lifecycle. An inbound-only test-number rollout gives the architecture a real second transport, extracts only the proven shared behaviour and limits operational risk before outbound calling is considered.

## References

Meta Platforms (2026a) *WhatsApp Business Platform: Calling*. Available at: <https://developers.facebook.com/documentation/business-messaging/whatsapp/calling> (Accessed: 31 August 2026).

Meta Platforms (2026b) *User-initiated calls*. Available at: <https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls> (Accessed: 31 August 2026).

Panda Agent (2026a) *Live Voice*. Internal developer documentation. Available at: [`docs/developers/live-voice.md`](../developers/live-voice.md) (Accessed: 31 August 2026).

Panda Agent (2026b) *OpenAI Live wire implementation*. Internal source code. Available at: [`src/integrations/providers/openai-live/wire.ts`](../../src/integrations/providers/openai-live/wire.ts) (Accessed: 31 August 2026).

Panda Agent (2026c) *Per-Agent Live Voice Configuration and Global Voice Migration*. Internal implementation plan. Available at: [`docs/plans/2026-08-31-agent-live-voice-configuration.md`](./2026-08-31-agent-live-voice-configuration.md) (Accessed: 31 August 2026).

WhiskeySockets (2023) *Calls support, issue 40*. Available at: <https://github.com/WhiskeySockets/Baileys/issues/40> (Accessed: 31 August 2026).

WhiskeySockets (2026a) *Baileys README*. Available at: <https://github.com/WhiskeySockets/Baileys/blob/master/README.md> (Accessed: 31 August 2026).
