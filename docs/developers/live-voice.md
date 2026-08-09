# Live Voice

Discord is the first call transport, not the owner of live turn semantics.

`src/integrations/voice/live-voice-session.ts` is the channel-neutral module for input/output arbitration and bounded transient reconnect history. `src/integrations/voice/pcm.ts` owns provider-independent PCM conversion. The Discord adapter still owns guild joins, participant streams, Discord Opus, commands, and control records. The OpenAI Live adapter owns private call creation, WebRTC, sideband parsing, authentication, and provider session shape.

The important lifecycle rule is that transcript completion, provider response completion, and transport media drain are different facts. Frameless `turn.done` updates transient history and attribution only. Discord playback seals from media quiet and player drain; it never sends EOF because a transcript completed.

On barge-in, Panda begins suppression only after the first audible decoded participant frame; leading digital silence cannot cancel an answer. Output remains suppressed until GPT-Live completes that user turn, or until a bounded fallback after Discord capture ends. Durable Panda work already in progress is not cancelled.

Provider replacement keeps the Discord call alive. Completed casual transcripts are retained only in process, bounded, and supplied to a fresh call as role-bearing `initial_items`; PCM and partial turns are discarded. Durable delegation still targets the owning Panda session and resolves its current thread at delivery time.

A future Telegram or WhatsApp call adapter should reuse the live voice module and implement only its native call lifecycle, participant provenance, codec conversion, and media transport. Do not move connector controls, guild/chat identifiers, or provider wire details into the channel-neutral module. Finalize any broader transport interface only when a second real call adapter exists.
