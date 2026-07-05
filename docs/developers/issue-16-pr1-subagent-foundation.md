# Issue #16 PR1 — Subagent foundation decisions

This note records the first safe implementation slice for issue #16. It is a foundation for the later hard cut to durable `spawn_subagent`; it is not a compatibility wrapper and does not preserve the legacy worker-spawn tool as product policy.

## Decision chain

- Patrik approved `subagent` as the canonical product noun.
- V1 keeps one future model-facing spawn surface: durable `spawn_subagent` with A2A progress/completion. Removing the legacy worker-spawn tool is a later hard-cut slice, not part of this PR1.
- Profiles are DB-backed from day one. Built-ins may be seeded from code, but runtime lookup should use Postgres as the source of truth.
- Profiles store tool-group keys only. They do not store raw tool names, credentials, environment ids, execution targets, or `skillAllowlist`.
- `transcriptMode` is inert/default `none` in V1.

## Tool-group defaults

The central registry is `src/domain/subagents/tool-groups.ts`.

Approved V1 corrections are pinned there and covered by tests:

- `core` includes safe universal basics through command-native policy names such as `time.now`, A2A commands, `image.generate`, `whisper.transcribe`, `whisper.translate`, `view_media`, and `todo` commands.
- `agent_skill` is not in `core` in PR1 because the raw tool currently supports `load`, `set`, `patch`, and `delete`; adding it to universal raw membership would silently grant skill mutation. The approved long-term intent is operation-level access: load/read broadly, set/patch/delete only for `operate` or a skill-maintainer-equivalent policy.
- `internet` includes public web/browser commands, including `web.fetch`, `brave.*`, and `openai.web_research`.
- `operate` includes operational mutation/control tools, including `thinking_set` and the mutating raw `agent_skill` surface.
- The fixed group keys are `core`, `internet`, `memory`, `execute`, `operate`, and `communicate_human`.

## Profile foundation

`runtime.subagent_profiles` stores global built-ins and future agent-scoped custom profiles. The PR1 seed keeps the current built-in role names for continuity: `workspace`, `memory`, `browser`, and `skill_maintainer`.

`skill_maintainer` is seeded conservatively without broad `operate` because that group also includes env/app/watch/schedule/credential-style mutations. The next slice must either add enforceable operation-level `agent_skill(load|set|patch|delete)` policy or introduce an explicit narrow skill-maintenance capability before using the profile for skill mutation.

This PR deliberately stops before spawn enforcement. The next slice should use these DB-backed profiles and tool groups when implementing durable `spawn_subagent` and removing model-facing the legacy worker-spawn tool.
