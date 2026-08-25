# Live Voice

Discord is the first call transport, not the owner of live-call semantics.

The reusable boundary has four parts:

- `src/domain/live-voice` owns generic `runtime.live_voice_sessions` and `runtime.live_voice_turns` records. Sessions use opaque `source`, `connectorKey`, `scopeKey`, and `roomKey` transport identity. Turns reference the generic live session and provider delegation, never Discord columns.
- `src/integrations/voice/live-call.ts` owns first-speaker arbitration, audible input admission, barge-in, provider replacement, output gating, exact-once delegation, and progress/final delivery.
- `src/integrations/voice/provider.ts` is the provider-session contract and provider-definition seam. `src/integrations/providers/openai-live/provider.ts` binds OpenAI configuration once; transports do not construct the bridge or map provider callbacks themselves. The OpenAI Live adapter owns private call creation, WebRTC, sideband parsing, authentication, and provider wire shape.
- A call transport supplies decoded 24 kHz mono PCM and a `LiveVoiceOutput`. Discord owns guild joins, participant provenance, Discord Opus, Gateway/voice lifecycle, commands, and `discord_voice_controls`.

The daemon's generic handoff resolves the owning Panda session's current thread at delivery time. Source-specific prompt rendering is injected at that boundary; the Discord renderer remains under the Discord integration. Runtime input metadata uses `liveVoice`, so run correlation does not depend on a transport-specific shape.

The important lifecycle rule is that transcript completion, provider response completion, and transport media drain are different facts. Frameless `turn.done` updates transient history and attribution only. Discord playback seals from media quiet and player drain; it never sends EOF because a transcript completed.

Delegation persistence is one PostgreSQL statement: it locks the connected live
session, creates or resolves the turn, and enqueues its idempotent runtime
request. Disconnect marks the session closed before transport teardown, so that
lock is the shutdown fence. `LiveVoiceCall.close()` also joins in-flight
persistence and terminalizes any turn returned after its provider generation
closed; request handling rejects delegations for a disconnected live session.

On barge-in, Panda begins suppression only after the first audible decoded participant frame; leading digital silence cannot cancel an answer. Output remains suppressed until GPT-Live completes that user turn, or until a bounded fallback after Discord capture ends. Durable Panda work already in progress is not cancelled.

Provider replacement keeps the call transport alive. Completed casual transcripts are retained only in process, bounded, and supplied to a fresh provider session as role-bearing `initial_items`; PCM and partial turns are discarded. Durable Panda work is not cancelled.

Diagnostics have the same split. Generic health, provider, capture, playback, delegation, and Postgres facts live in `src/integrations/voice/health.ts`. The snapshot's `transport` object carries Discord Gateway and voice-connection facts rendered by `voice-transport-health.ts`. Operator status therefore stays comparable across future transports without erasing native details.

A future Telegram, WhatsApp, or custom call adapter should create a generic session record, feed `LiveVoiceCall` with participant-attributed PCM, implement `LiveVoiceOutput`, inject a `LiveVoiceProviderDefinition`, render its source-specific delegation instructions, and own its native control/join lifecycle. Do not move connector controls, guild/chat identifiers, codecs, or provider wire details into the reusable module. Add a broader transport interface only after a second real adapter proves the common shape.

The previous experimental `runtime.discord_voice_sessions` and `runtime.discord_voice_turns` tables are migrated once by the daemon and removed. Completed history is preserved; in-flight legacy turns are failed because their spoken outcome is unknowable after restart. Obsolete `discord_voice_delegation` queue records are removed during the same transaction. `runtime.discord_voice_controls` deliberately remains transport-specific.
