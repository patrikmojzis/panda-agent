# OpenClaw Import

Panda now has a first-pass importer for OpenClaw agent workspaces.

CLI:

```bash
panda agent import-openclaw /path/to/backup --dry-run
panda agent import-openclaw /path/to/backup --db-url postgres://...
panda agent import-openclaw /path/to/backup --identity patrik --include-messages --db-url postgres://...
```

The command accepts either:

- one OpenClaw agent directory like `/path/to/clawd`
- or a parent directory containing multiple agent folders

## Mapping

OpenClaw files map into Panda like this:

- `AGENTS.md` -> `agent_prompts.playbook`
- `HEARTBEAT.md` -> `agent_prompts.heartbeat`
- `SOUL.md` -> `agent_prompts.soul`
- `IDENTITY.md` -> not migrated into prompts
- generated `agent_prompts.agent` -> short Panda-native wrapper so the slot is not empty
- `USER.md` + `MEMORY.md` -> merged into `agent_documents.memory`
- `memory/YYYY-MM-DD*.md` -> `agent_diary`
- `skills/*/SKILL.md` -> `agent_skills`
- `skills/**/*.env`, `skills/**/.env`, `skills/**/*.env.*` -> credentials

When `--identity <handle>` is set:

- imported `memory` lands in the agent+identity document scope
- imported diary entries land in the agent+identity diary scope
- imported credentials land in the relationship scope (`agent_key` + `identity_id`)
- the importer also pairs that identity to the agent

Without `--identity`, those imports stay agent-scoped like before.

## Message Import

`--include-messages` turns on a deliberately lossy chat import from `.openclaw/agents/<agent>/sessions`.

What it does:

- keeps only human-ish `user -> assistant` pairs
- strips channel wrappers like Telegram headers when possible
- drops thinking, tool calls, tool results, cron prompts, and deleted session files
- caps the import to the last 200 pairs so the main Panda thread does not become unusable
- preserves original timestamps
- writes the result into the agent's current main thread, so it shows up through `panda_messages`

Guardrail:

- if the Panda main thread already has transcript rows, legacy message import is skipped instead of duplicating soup

## Diary Merge Rule

Panda stores one diary row per day.

OpenClaw workspaces sometimes split the same day across:

- `2026-01-26.md`
- `2026-01-26-topic.md`
- `2026-01-26-1533.md`

The importer collapses those into one markdown blob for that date and keeps filename markers so the source is still obvious.

## Legacy Copy

After import, Panda copies a filtered snapshot into:

```text
~/.panda/agents/<agentKey>/legacy-import
```

That snapshot intentionally skips obvious junk and plaintext secret files:

- `.git`
- `.openclaw`
- `.pi`
- `node_modules`
- `venv`
- `.DS_Store`
- `*.env`, `.env`, `.env.*`, `*.pass`
- SQLite `-wal` / `-shm` sidecars

This keeps the raw workspace available without dragging old runtime garbage and secret files forward.

## Credential Note

The importer writes credentials only when `PANDA_CREDENTIALS_MASTER_KEY` is set.

Without it:

- the rest of the import still runs
- credential entries are reported as skipped

That is deliberate. Silent plaintext fallback would be dumb.
