# Skills

Skills are now stored in Postgres.

That means:

- the skill source of truth is the database, not `~/.panda/agents/<agent>/skills`
- Panda injects only each skill's key and short description into normal runs
- the full skill body is fetched on demand through the scoped `session.agent_skills` readonly view

## What Panda Sees By Default

In the normal Agent Profile context, Panda gets a cheap skill index:

- `skill_key`
- `description`

It does **not** get every full skill body on every run.
That would be a dumb way to burn tokens.

## Creating Or Updating A Skill

Use Panda chat itself.

Paste the skill content and tell Panda to save it as a skill.
Panda uses the `agent_skill` tool to upsert:

- `skillKey`
- `description`
- `content`

Skills are scoped to the current agent.

## Deleting A Skill

Ask Panda to delete the skill by key.
It uses the same `agent_skill` tool with `operation = delete`.

## Reading Full Skill Content

When Panda needs the exact body of a skill, it should query `session.agent_skills` through `postgres_readonly_query`.

Useful columns:

- `skill_key`
- `description`
- `content`
- `content_bytes`
- `created_at`
- `updated_at`

For large skills, do not pull the full blob blindly.
Prefer:

- `description`
- `content_bytes`
- `substring(content from ... for ...)`

Example:

```sql
SELECT skill_key, description, content_bytes
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
