# Discord

Discord uses stored bot accounts, channel-to-session bindings, and user-id-to-identity pairings.

## Setup

In the Discord developer portal:

- create a bot and copy its token
- enable the Message Content Intent
- invite the bot with permission to read and send messages in the target channel

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
