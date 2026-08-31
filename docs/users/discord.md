# Discord

Discord uses stored bot accounts, channel-to-session bindings, and user-id-to-identity pairings.

## Setup

In the Discord developer portal:

- create a bot and copy its token
- enable the Message Content Intent
- invite the bot with View Channel, Read Message History, Send Messages, and Attach Files in the target channel

For experimental voice, the bot also needs View Channel, Connect, and Speak in the target voice channel. Panda enables the Guild Voice States Gateway intent automatically.

Set `CREDENTIALS_MASTER_KEY` before account commands, then store the token without printing it:

```bash
panda discord account import-env discord-main --env-key DISCORD_BOT_TOKEN --agent panda
```

Or pipe it through stdin:

```bash
printf '%s' "$DISCORD_BOT_TOKEN" | panda discord account set discord-main --bot-token-stdin --agent panda
```

Create a branch session for the Discord channel. A readable ref is easiest to reuse:

```bash
panda session create panda discord-main
```

The ref is normalized to lowercase and the real session id is `panda:discord-main`.

Bind a Discord channel to that Panda session:

```bash
panda discord bind-channel --account discord-main --channel <discordChannelId> --session panda:discord-main
```

You can also pass any existing session id as `--session <sessionId>`.

Pair Discord users to Panda identities:

```bash
panda discord pair --account discord-main --identity alice --actor <discordUserId>
```

Use the stable Discord user id/snowflake for `--actor`, not a username or display name.

## Inbound media

Inbound attachments, embeds, and stickers are summarized separately in runtime context. Supported Discord CDN/proxy media is downloaded into `downloaded_media` for tools such as `view_media` or `whisper`. Multiple images can be sent in one Discord message; Panda exposes one local path per successful item and the agent inspects each path. Embed-only and sticker-only messages wake the bound session normally.

Panda downloads at most one trusted visual candidate per embed. PNG, APNG, and GIF stickers use Discord's official sticker CDN; Lottie stickers remain identifiable metadata because Panda does not render Lottie. Inbound downloads keep the 25 MiB and 30-second limits.

Discord `proxy_url`, `proxyUrl`, and `url` attachment fields are accepted. Panda prefers a trusted proxy and falls back to the trusted CDN URL, validates supported image MIME/signatures, and stores the actual downloaded byte size. Unsupported, oversized, untrusted, or failed downloads are reported with stable status/reason codes without persisting or rendering raw CDN/proxy URLs.

Outbound Discord messages can include files and images when the bot has the Attach Files permission.

## Guild stickers

List bot-visible stickers in the guild behind a channel already bound to the current session:

```bash
panda discord sticker list --channel <parentChannelId> --connector <connectorKey>
```

Send one to three native Discord stickers:

```bash
panda discord sticker send --channel <parentChannelId> --connector <connectorKey> \
  --sticker <stickerId> --sticker <stickerId>
```

Thread, guild, and reply options match `panda discord send`. Sticker IDs are Discord snowflakes. PNG, APNG, Lottie, and GIF stickers are listable and sendable; Lottie is not rendered when received. The bot must be able to view the guild/channel and send messages there. Panda does not use undocumented client APIs or scrape Discord's picker.

## GIFs

Send one validated local GIF:

```bash
panda discord gif send --channel <parentChannelId> --connector <connectorKey> \
  --file ./reaction.gif --caption "Mood"
```

Or send a direct public HTTPS GIF asset:

```bash
panda discord gif send --channel <parentChannelId> --connector <connectorKey> \
  --url https://cdn.example/reaction.gif
```

Exactly one source is required. Local files must be at most 10 MiB and carry a `GIF87a` or `GIF89a` signature. Remote downloads use a 20-second timeout, at most three redirects, HTTPS at every hop, DNS pinning and private-network blocking, a 10 MiB limit, compatible MIME validation, and the same GIF signature check. Remote bytes are copied into the agent media root; the source URL is not persisted.

URLs must point directly to GIF bytes. Provider search, Tenor/Klipy-style result pages, webpage scraping, and a durable GIF/sticker library are intentionally not supported.

## Run workers

Run one account manually:

```bash
panda discord run discord-main
```

Run every enabled Discord connector account in one process:

```bash
panda discord run --all-enabled
```

`--all-enabled` keeps running even with zero accounts, reconciles enabled accounts every 30 seconds, and isolates account failures with bounded restart backoff.

## Docker stack

After storing and enabling at least one Discord account, opt in from `.env`:

```bash
DISCORD_ENABLED=true
PANDA_DISCORD_DB_POOL_MAX=2
```

Then run the stack normally:

```bash
./scripts/docker-stack.sh up --build
./scripts/docker-stack.sh logs discord
```

The stack runs `panda discord run --all-enabled`. It also adds a Wiki.js dependency so the Discord runner container is started before Wiki.js.

`PANDA_DISCORD_DB_POOL_MAX` is the ceiling for the whole Discord daemon, not each account. All enabled accounts share that pool and its one notification listener; their Discord Gateway connections remain separate.

## Experimental voice

Discord voice creates private `gpt-live-1-codex` calls through the ChatGPT Codex backend and controls them over the direct GPT-Live sideband. It does not go through `pi-ai` or require `codex app-server`. The text-bound Panda session remains the durable brain, while raw audio and casual GPT-Live conversation stay transient.

Opt in explicitly and mount the Codex OAuth home read-only:

```bash
PANDA_LIVE_VOICE_ENABLED=true
PANDA_OPENAI_LIVE_DELEGATION_ACK_FILLER=
PANDA_OPENAI_LIVE_SIDEBAND_PING_MS=0
CODEX_HOST_HOME=/home/you/.codex
PANDA_DISCORD_DB_POOL_MAX=2
```

The worker reads `CODEX_HOME/auth.json` afresh for every provider connection and requires ChatGPT/Codex OAuth with a `chatgpt_account_id`. The mount is read-only: Panda never refreshes, stores, or logs that token and has no API-key or public Realtime fallback. An expired token or HTTP 401 disconnects voice with `auth_unavailable`; the backend's overloaded HTTP 403 is reported as `provider_startup_failed`, not as a Discord permission error. Sideband ping frames are disabled by default; enable them only when the deployment's network path needs them.

Live voice is configured per agent and defaults to `cove`. Change it in Control under **Agent → Settings**, or use `panda agent voice list`, `panda agent voice get <agent-key>`, and `panda agent voice set <agent-key> <voice>`. The setting is read when a new call starts; active calls keep their existing voice.

From a Discord-bound Panda session:

```bash
panda discord voice join --channel <voiceChannelId> [--connector <connectorKey>]
panda discord voice send --text <message> [--mode progress|final] [--turn <voiceTurnId>] [--channel <voiceChannelId>] [--connector <connectorKey>]
panda discord voice status [--connector <connectorKey>]
panda discord voice leave [--turn <voiceTurnId>] [--channel <voiceChannelId>] [--connector <connectorKey>]
```

The target voice channel need not be text-bound, but the invoking session must already have a conversation binding for the connector. `join` reminds the agent that it may call `discord.voice.send` at any time. A delegated task should use short `progress` sends while work continues and exactly one concise `final` send when it is done. The command infers the voice turn from the current run when unambiguous; `--turn` selects it explicitly. A delegated send requires a current provider binding for that exact source utterance and fails with `provider_unavailable` if it cannot be correlated safely. A proactive send without a voice turn uses standalone session context.

Only explicit `discord.voice.send` deliveries are handed back to GPT-Live. Ordinary assistant transcript text remains Panda's internal working space and is never harvested as a voice response. Delegated prompts and explicit final answers are durable; PCM and casual GPT-Live chatter are not. Panda accepts humans and other bots, ignores only itself, limits utterances to 60 seconds and 30 accepted utterances per minute, and supports barge-in.

When GPT-Live delegates a leave request, Panda uses `discord.voice.leave --turn <voiceTurnId>` so the durable turn completes as the worker disconnects. A successful leave does not require a final voice send afterward.

The private GPT-Live sideband can reset independently of Discord. Panda follows Codex's ownership model: it reconnects the sideband to the same provider call id after bounded exponential backoff, resolves OAuth afresh, and preserves the active delegation. A context send waits up to ten seconds for that reattachment.

WebRTC media failure or a missing provider `turn.done` requires a fresh provider call. Panda keeps the Discord connection and any active receiver capture alive and tries replacement sessions after 0, 500, and 1,500 milliseconds. A replacement receives a bounded in-memory tail of completed user and assistant transcripts as role-bearing history. That history is never persisted or replayed as executable input. Durable Panda work continues; a result from an older provider generation is spoken through standalone session context rather than discarded. Four whole-provider failures within five minutes open the room circuit and disconnect it.

`PANDA_OPENAI_LIVE_DELEGATION_ACK_FILLER` may be `true`, `false`, or empty to preserve the provider default. It changes provider delegation acknowledgement only; it does not change Panda's prompts. Leave sideband pings disabled unless a live network-path comparison proves they help.

`discord voice status` reports lifecycle state plus `ready`, `degraded`, `recovering`, or `error` health and the latest bounded diagnostic snapshot. Generic provider, playback, capture, delegation, and Postgres facts are separate from the `transport` object containing Gateway and Discord voice state. Bounded generic reasons are `transport_not_ready`, `provider_connecting`, `provider_recovering`, `provider_unavailable`, `notification_listener_reconnecting`, `postgres_pool_waiting`, `audio_dropped`, and `playback_failed`. Useful structured events are `discord_voice_health`, `live_voice_provider_reconnected`, `live_voice_provider_reconnect_failed`, `live_voice_delegation_queued`, `live_voice_playback_failed`, `voice_utterance_dropped`, and `voice_disconnected`.

GPT-Live transcript completion is not treated as Discord media completion. Playback resources drain from actual media activity, tolerate a bounded 320 milliseconds of RTP starvation, and never accept late RTP into an ended stream. Leading digital silence never activates playback. Quiet output inside a sentence is preserved, while a trailing quiet run is capped at 300 milliseconds so endless provider silence cannot keep Discord's speaking indicator alive. Panda never clears an answer merely because Discord received audible participant PCM: only GPT-Live's own output-clear event authorizes barge-in. One failed playback resource is reset without dropping the room. Four playback failures within one minute open the playback circuit and disconnect cleanly.

Stable command failures include `voice_disabled`, `worker_unavailable`, `auth_unavailable`, `invalid_channel`, `permission_denied`, `session_conflict`, `voice_session_unavailable`, `voice_turn_conflict`, `provider_startup_failed`, `provider_unavailable`, and `timeout`. Voice sessions are capped at eight per process, expire 30 minutes after the original join even if the provider reconnects, and are not restored after worker restart. A restart fails active controls and active delegated turns because their speech outcome may be ambiguous; it never replays them. This integration targets an undocumented experimental protocol and carries no compatibility guarantee.
