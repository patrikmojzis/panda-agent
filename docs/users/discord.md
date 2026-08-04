# Discord

Discord uses stored bot accounts, channel-to-session bindings, and user-id-to-identity pairings.

## Setup

In the Discord developer portal:

- create a bot and copy its token
- enable the Message Content Intent
- invite the bot with View Channel, Read Message History, Send Messages, and Attach Files in the target channel

For experimental voice, also grant Connect and Speak. Panda enables the Guild Voice States Gateway intent automatically.

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

`--all-enabled` starts accounts one at a time, keeps failures isolated per account, and keeps running as long as at least one account starts.

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

Budget Postgres connections explicitly: Discord opens one worker pool per enabled account, so the Discord ceiling is `enabled Discord accounts x PANDA_DISCORD_DB_POOL_MAX`.

## Experimental voice

Discord voice creates private `gpt-live-1-codex` calls through the ChatGPT Codex backend and controls them over the direct GPT-Live sideband. It does not go through `pi-ai` or require `codex app-server`. The text-bound Panda session remains the durable brain, while raw audio and casual GPT-Live conversation stay transient.

Opt in explicitly and mount the Codex OAuth home read-only:

```bash
PANDA_DISCORD_VOICE_EXPERIMENTAL=true
PANDA_DISCORD_VOICE_VOICE=cove
CODEX_HOST_HOME=/home/you/.codex
PANDA_DISCORD_DB_POOL_MAX=4
```

The worker reads `CODEX_HOME/auth.json` afresh for every provider connection and requires ChatGPT/Codex OAuth with a `chatgpt_account_id`. It never refreshes, stores, or logs that token. An expired token or HTTP 401 disconnects voice with `auth_unavailable`; the backend's overloaded HTTP 403 is reported as `provider_startup_failed`, not as a Discord permission error.

From a Discord-bound Panda session:

```bash
panda discord voice join --channel <voiceChannelId> [--connector <connectorKey>]
panda discord voice send --text <message> [--mode progress|final] [--turn <voiceTurnId>] [--channel <voiceChannelId>] [--connector <connectorKey>]
panda discord voice status [--connector <connectorKey>]
panda discord voice leave [--channel <voiceChannelId>] [--connector <connectorKey>]
```

The target voice channel need not be text-bound, but the invoking session must already have a conversation binding for the connector. `join` reminds the agent that it may call `discord.voice.send` at any time. A delegated task should use short `progress` sends while work continues and exactly one concise `final` send when it is done. The command infers the voice turn from the current run when unambiguous; `--turn` selects it explicitly. Without a matching delegation, the same command appends standalone session context so GPT-Live can speak a proactive update.

Only explicit `discord.voice.send` deliveries are handed back to GPT-Live. Ordinary assistant transcript text remains Panda's internal working space and is never harvested as a voice response. Delegated prompts and explicit final answers are durable; PCM and casual GPT-Live chatter are not. Panda accepts humans and other bots, ignores only itself, limits utterances to 60 seconds and 30 accepted utterances per minute, and supports barge-in.

The private GPT-Live sideband can reset independently of Discord. Panda keeps the Discord voice connection alive, creates a fresh provider session, and carries over only a bounded in-memory window of voice conversation context. After a provider replacement, an explicit send falls back to standalone session context because the replacement no longer owns the old delegation id. Unexpected audio, Discord, and provider failures are logged and tear down owned resources cleanly.

Voice sessions are capped at eight per process, expire 30 minutes after the original join even if the provider reconnects, and are not restored after worker restart. This integration targets an undocumented experimental protocol and carries no compatibility guarantee.
