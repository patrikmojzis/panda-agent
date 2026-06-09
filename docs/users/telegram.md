# Telegram setup

Telegram runtime accounts are stored in the database as connector accounts. Do **not** run production Telegram from a raw `TELEGRAM_BOT_TOKEN` in `.env`; that legacy mental model makes Control unable to see/bind the account.

## Happy path in Control

1. Open Control → target agent → **Connectors** → **Telegram setup**.
2. Choose an account key per bot. Use `main` for Clawd's main bot, `luna` for Luna's bot, etc. Do not reuse one shared `main` key for every bot.
3. Paste the bot token. Control validates it with Telegram `getMe`, stores it write-only, and shows only bot identity/secret presence.
4. Bind the Telegram conversation/chat id to the target agent session in **Channel bindings**.
5. Pair the Panda identity to the agent, then pair the numeric Telegram user id to that identity in **Telegram and WhatsApp actors**. Use the numeric user id, not `@handle`.
6. Ensure the Telegram worker is enabled (`TELEGRAM_ENABLED=true`) and run/deploy `panda telegram run --all-enabled`.

`telegram run --all-enabled` reconciles enabled account changes periodically after this release, so a newly stored/enabled account should be picked up without a container restart. Restart only if the running worker predates this release or logs show reconcile failures.

## CLI equivalents

```bash
printf '%s' "$BOT_TOKEN" | panda telegram account set main --agent clawd --bot-token-stdin
panda telegram account whoami main
panda telegram run --all-enabled
```

Replacing an existing key is blocked by default. To rotate the same bot intentionally:

```bash
printf '%s' "$NEW_BOT_TOKEN" | panda telegram account set main --agent clawd --bot-token-stdin --replace
```

## Troubleshooting

- `Unknown Telegram account main`: store it in Control Telegram setup, or run `panda telegram account set main --agent <agent> --bot-token-stdin`.
- Account key collision: choose a per-bot key (`main`, `luna`, etc.) or use `--replace`/the Replace switch only when rotating the same bot.
- Telegram not visible in Control: make sure the connector account is agent-owned (`--agent <agent>` or Control setup), enabled, and has a stored `bot_token` secret.
- Inbound messages do not route: bind the Telegram conversation to a session and pair the numeric Telegram user id to an identity already paired with the agent.
- Docker worker not running: `TELEGRAM_ENABLED=true` enables the worker service; bot tokens still belong in DB-stored connector accounts.
