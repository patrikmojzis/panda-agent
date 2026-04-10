# Postgres Setup

## Preferred Setup

Use one Postgres database.
Do not make a separate database per identity.

The preferred setup is:

- one app role for normal Panda writes
- one restricted read-only role for `postgres_readonly_query`
- scoped `panda_*` views as the SQL tool contract

That gives you one shared database with clear boundaries instead of a pile of tiny databases and future regret.

## Why

The `postgres_readonly_query` tool is read-only.
It is not view-only by itself.

That means privacy does **not** come from the prompt or from the tool description.
Privacy comes from the database role you give that tool.

If the SQL tool runs with the main app role, it can read whatever that role can read.
That is too much.

The right shape is:

- `postgres_readonly_query` reads only `panda_*` views
- the views are filtered by the current `identityId` and `agentKey`
- the SQL tool cannot read base tables directly

## Current Panda Wiring

Panda reads the main database URL from:

- `PANDA_DATABASE_URL`
- or `DATABASE_URL`
- or `--db-url`

Panda reads the SQL tool database URL from:

- `PANDA_READONLY_DATABASE_URL`
- or `--read-only-db-url`

If `PANDA_READONLY_DATABASE_URL` is set, Panda uses that role for the SQL tool and grants it access to the `panda_*` views during startup.

If it is **not** set, Panda currently falls back to the main app pool.
That fallback is convenient, but it weakens the privacy story.

## Recommended Local Setup

Example main app URL:

```bash
PANDA_DATABASE_URL=postgres://panda_app:app_pw@localhost:5432/panda
```

Create a separate read-only role:

```sql
CREATE ROLE panda_readonly LOGIN PASSWORD 'readonly_pw';
```

Point Panda at the same database with that separate role:

```bash
PANDA_READONLY_DATABASE_URL=postgres://panda_readonly:readonly_pw@localhost:5432/panda
```

You can also pass it explicitly:

```bash
panda chat \
  --db-url postgres://panda_app:app_pw@localhost:5432/panda \
  --read-only-db-url postgres://panda_readonly:readonly_pw@localhost:5432/panda
```

## Lock Down The Read-only Role

This part matters.
If the read-only role can still read base tables, the setup is fake.

Minimum sane starting point:

```sql
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM panda_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM panda_readonly;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM panda_readonly;
```

Then start Panda with `PANDA_READONLY_DATABASE_URL` set.
During startup Panda grants that role access to the scoped `panda_*` views.

The intent is simple:

- app role owns tables
- read-only role reads views
- SQL tool never gets raw table access

## Views The SQL Tool Should Use

The SQL tool should treat these views as the public interface:

- `panda_threads`
- `panda_messages`
- `panda_messages_raw`
- `panda_tool_results`
- `panda_inputs`
- `panda_runs`

Those views are filtered to the current `(identityId, agentKey)` scope.

If the agent needs more safe query surfaces later, add another scoped view.
Do not solve that by handing the SQL tool direct table access.

## Relationship Memory And Agent Docs

Relationship memory, diary entries, and shared agent docs should stay behind the `agent_document` tool unless Panda grows dedicated safe views for them.

That is deliberate.
The SQL tool should not become a skeleton key for every table in the database.

## Hard Rules

- Do not use the same role for `PANDA_DATABASE_URL` and `PANDA_READONLY_DATABASE_URL`.
- Do not grant the read-only role direct table access.
- Do not rely on prompt instructions for privacy.
- Prefer adding a new scoped view over exposing a raw table.
- Long term, Panda should disable `postgres_readonly_query` entirely when no restricted read-only URL is configured.

## Quick Summary

Best practice for Panda is not "one database per identity."

Best practice is:

- one shared Postgres database
- one normal app role
- one restricted read-only role
- scoped `panda_*` views as the only SQL tool surface

That is the clean setup.
Everything else is half-security cosplay.
