# Live Voice

Discord is the first call transport, not the owner of live-call semantics.

The reusable boundary has four parts:

- `src/domain/live-voice` owns generic `runtime.live_voice_sessions` and `runtime.live_voice_turns` records. Sessions use opaque `source`, `connectorKey`, `scopeKey`, and `roomKey` transport identity. Turns reference the generic live session and provider delegation, never Discord columns.
- `src/integrations/voice/live-call.ts` owns first-speaker arbitration, audible input admission, provider-authoritative output clearing, provider replacement, exact-once delegation, and progress/final delivery.
- `src/integrations/voice/provider.ts` is the provider-session contract and provider-definition seam. `src/integrations/providers/openai-live/provider.ts` binds OpenAI configuration once; transports do not construct the bridge or map provider callbacks themselves. The OpenAI Live adapter owns private call creation, WebRTC, sideband parsing, authentication, and provider wire shape.
- A call transport supplies decoded 24 kHz mono PCM and a `LiveVoiceOutput`. Discord owns guild joins, participant provenance, Discord Opus, Gateway/voice lifecycle, commands, and `discord_voice_controls`.

The agent owns its `liveVoice` preference. A transport reads it when a new call starts, validates it through the provider catalogue, and stores the canonical value on `runtime.live_voice_sessions`. That snapshot is immutable for the call and every provider recovery generation. An idempotent rejoin returns the existing snapshot; moving rooms starts a new call and rereads the agent. Historical session rows keep `voice = NULL` rather than claiming a value that was never recorded.

The daemon's generic handoff resolves the owning Panda session's current thread at delivery time. Source-specific prompt rendering is injected at that boundary; the Discord renderer remains under the Discord integration. Runtime input metadata uses `liveVoice`, so run correlation does not depend on a transport-specific shape.

The important lifecycle rule is that transcript completion, provider response completion, and transport media drain are different facts. Frameless `turn.done` updates transient history and attribution only. Discord playback seals from media quiet and player drain; it never sends EOF because a transcript completed.

Delegation persistence is one PostgreSQL statement: it locks the connected live
session, creates or resolves the turn, and enqueues its idempotent runtime
request. Disconnect marks the session closed before transport teardown, so that
lock is the shutdown fence. `LiveVoiceCall.close()` also joins in-flight
persistence and terminalizes any turn returned after the live call closed;
request handling rejects delegations for a disconnected live session.

Panda does not infer barge-in from decoded channel PCM. It keeps forwarding accepted input while GPT-Live decides whether that input interrupts the active answer. Only the provider's `output_audio_buffer.cleared` event clears queued playback and the WebRTC reorder buffer. The OpenAI media adapter then quarantines 200 milliseconds of in-flight RTP while advancing its sequence watermark, preventing pre-clear packets from leaking into the next response. This matches Codex's ownership boundary and prevents Discord noise, echo, or fragmented speaking events from cutting off a valid answer. Durable Panda work already in progress is not cancelled.

Sideband recovery normally does not replace the provider call. The OpenAI adapter reconnects to the same call id with freshly resolved Codex OAuth and bounded exponential backoff, preserving provider transcript and delegation identity. Context delivery waits briefly for that reattachment instead of dropping an in-flight Panda result.

Whole-provider replacement is reserved for media failure or provider desynchronization, including a missing `turn.done` after a completed capture. It keeps the call transport alive. Completed casual transcripts are retained only in process, bounded, and supplied to a fresh provider session as role-bearing `initial_items`. Already-sent PCM and uncommitted provider state are discarded, but an active transport capture remains valid and subsequent PCM continues into the new provider generation. A durable result bound to the old generation is delivered through standalone session context; durable Panda work is not cancelled.

Diagnostics have the same split. Generic health, provider, capture, playback, delegation, and Postgres facts live in `src/integrations/voice/health.ts`. The snapshot's `transport` object carries Discord Gateway and voice-connection facts rendered by `voice-transport-health.ts`. Operator status therefore stays comparable across future transports without erasing native details.

The supported `panda/integrations/live-voice` package entrypoint exposes the channel-neutral call/provider contracts for the standalone voice lab and future call transports. `panda/integrations/openai-live` exposes the OpenAI provider definition plus its versioned V1/V3 voice catalogue and parser. Discord internals and provider wire classes remain private.

`PANDA_LIVE_VOICE_ENABLED` is the channel-neutral deployment kill switch and stays disabled by default. Provider tuning uses `PANDA_OPENAI_LIVE_*`; voice choice is never an environment setting. Operators configure it per agent through Control or `panda agent voice`.

A future Telegram, WhatsApp, or custom call adapter should create a generic session record, feed `LiveVoiceCall` with participant-attributed PCM, implement `LiveVoiceOutput`, inject a `LiveVoiceProviderDefinition`, render its source-specific delegation instructions, and own its native control/join lifecycle. Do not move connector controls, guild/chat identifiers, codecs, or provider wire details into the reusable module. Add a broader transport interface only after a second real adapter proves the common shape.

The previous experimental `runtime.discord_voice_sessions` and `runtime.discord_voice_turns` tables are migrated once by the daemon and removed. Completed history is preserved; in-flight legacy turns are failed because their spoken outcome is unknowable after restart. Obsolete `discord_voice_delegation` queue records are removed during the same transaction. `runtime.discord_voice_controls` deliberately remains transport-specific.
