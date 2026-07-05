# Skills

Skills are now stored in Postgres.

That means:

- the skill source of truth is the database, not `~/.panda/agents/<agent>/skills`
- Panda injects only each skill's key and short description into normal runs
- the full skill body is fetched on demand through `panda skill load` or `panda skill show`

## What Panda Sees By Default

In the normal Agent Profile context, Panda gets a cheap skill index:

- `skill_key`
- `description`
- `tags`

It does **not** get every full skill body on every run.
That would be a dumb way to burn tokens.

## Creating Or Updating A Skill

Use Panda chat itself.

Paste the skill content and tell Panda to save it as a skill.
Panda uses `panda skill set` to upsert:

- `skillKey`
- `description`
- `content`
- optional `tags`

Tags are short lowercase discovery hints such as `coding`, `github`, `orchestration`, `health`, or `finance`. Keep them sparse and broad; tags are for browsing/filtering skills, not permissions or secrets.

When only the injected short description needs to change, Panda can use `panda skill patch <skill-key> --description <text|@file|@->`. That path updates the description of an existing editable skill without resubmitting or changing the stored body or tags.

Skills are scoped to the current agent. Existing skills are agent-editable by default.

## Tags

Skills can have zero or more tags. Tags are normalized to lowercase, deduplicated, and kept intentionally small. Use them to group and filter skills in injected summaries, readonly views, and Control surfaces.

Good tags describe when the skill is useful:

- `coding`
- `github`
- `orchestration`
- `monitoring`
- `ui-ux`
- `finance`

Avoid tag stuffing. A skill with two useful tags is better than one with ten vague ones. Tags are metadata only; they do not grant access or restrict editing.

## Locked Skills

Control can mark a skill as **Locked from agent edits** by turning off **Allow agent edits**. Locked skills still appear in the skill index and remain readable through `panda skill load`, `panda skill show`, and `session.agent_skills`, but Panda cannot replace, patch the description of, or delete them with `panda skill set`, `panda skill patch`, or `panda skill delete`.

Control operators can still edit, delete, lock, or unlock locked skills. This is useful for owner-maintained runbooks that agents should read but not overwrite.

## Deleting A Skill

Ask Panda to delete the skill by key.
It uses `panda skill delete <skill-key> --yes`.

## Reading Full Skill Content

When Panda needs the exact body of a skill, it should prefer `panda skill load <skill-key>` or `panda skill show <skill-key>`.
For SQL-shaped inspection across many skills, use `panda postgres readonly query --sql <text|@file|@->` against `session.agent_skills`.

Useful columns:

- `skill_key`
- `description`
- `content`
- `content_bytes`
- `agent_editable`
- `tags`
- `created_at`
- `updated_at`

For large skills, do not pull the full blob blindly.
Prefer:

- `description`
- `content_bytes`
- `substring(content from ... for ...)`

Example:

```sql
SELECT skill_key, description, tags, content_bytes, agent_editable
FROM session.agent_skills
ORDER BY skill_key;
```

```sql
SELECT substring(content FROM 1 FOR 3000) AS content_chunk
FROM session.agent_skills
WHERE skill_key = 'calendar';
```

## Filesystem Notes

Agent home directories still matter for:

- media
- runner-mounted files
- bash workspaces

They are just no longer the source of truth for skill markdown.
