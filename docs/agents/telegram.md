# Telegram stickers

When a Telegram sticker arrives, its attachment context contains an opaque `tg-in:` reference plus safe pack metadata. The reference is valid only for media in the current session's bound chat.

```bash
panda telegram sticker inspect tg-in:<media-id> --chat <conversation-id> --connector <key>
panda telegram sticker save tg-in:<media-id> --chat <conversation-id> --connector <key> --tag celebrate --description "Panda celebration"
```

If the sticker has a `sticker_set_name`, inspect the public pack and import either selected `tg-set:` references or the complete set:

```bash
panda telegram sticker set show <set-name> --connector <key>
panda telegram sticker set save <set-name> --connector <key> --sticker tg-set:<opaque-token> --tag support
panda telegram sticker set save <set-name> --connector <key> --all --tag favorite
```

The library is agent-owned and durable across sessions, restarts, and compaction. Search it, then send the returned opaque `tg-lib:` reference:

```bash
panda telegram sticker list --tag celebrate
panda telegram sticker list --query "good night" --emoji "🌙"
panda telegram sticker send --chat <conversation-id> --connector <key> --ref tg-lib:<uuid>
```

Do not copy raw Telegram file ids into prompts or notes. Library and inbound references enforce the intended scope; pack publishing remains a separate explicit action.
