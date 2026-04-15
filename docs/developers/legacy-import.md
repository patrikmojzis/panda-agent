# Legacy Import

Panda now has a first-pass importer for legacy OpenClaw-style agent workspaces.

CLI:

```bash
panda agent import-legacy /path/to/backup --dry-run
panda agent import-legacy /path/to/backup --db-url postgres://...
```

The command accepts either:

- one legacy agent directory like `/path/to/clawd`
- or a parent directory containing multiple agent folders

## Mapping

Legacy files map into Panda like this:

- `AGENTS.md` -> `agent_prompts.playbook`
- `HEARTBEAT.md` -> `agent_prompts.heartbeat`
- `SOUL.md` -> `agent_prompts.soul`
- `IDENTITY.md` -> not migrated into prompts
- generated `agent_prompts.agent` -> short Panda-native wrapper so the slot is not empty
- `USER.md` + `MEMORY.md` -> merged into `agent_documents.memory`
- `memory/YYYY-MM-DD*.md` -> `agent_diary`
- `skills/*/SKILL.md` -> `agent_skills`
- `skills/**/*.env`, `skills/**/.env`, `skills/**/*.env.*` -> agent-scoped credentials

## Diary Merge Rule

Panda stores one diary row per day.

Legacy workspaces sometimes split the same day across:

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
