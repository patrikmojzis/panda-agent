# Discord

Discord uses stored bot accounts, channel-to-session bindings, and user-id-to-identity pairings.

## Setup

In the Discord developer portal:

- create a bot and copy its token
- enable the Message Content Intent
- invite the bot with View Channel, Read Message History, Send Messages, and Attach Files in the target channel

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
