# Postgres

## Preferred Setup

Use one Postgres database.
Do not make a separate database per identity.

Best practice is:

- one shared Postgres database
- one normal app role
- one restricted read-only role
- scoped `panda_*` views as the only SQL tool surface

That is the clean setup. Everything else is half-security cosplay.

## Before You Start

You need:

- a running Postgres server
- one database Panda already uses, or will use
- one normal Panda app connection that already works

If Panda cannot connect with `PANDA_DATABASE_URL` yet, fix that first.
Do not debug the read-only role before the main app role works.

## Why

The `postgres_readonly_query` tool is read-only.
It is not view-only by itself.

Privacy does not come from the prompt or from the tool description.
Privacy comes from the database role you give that tool.

The right shape is:

- `postgres_readonly_query` reads only `panda_*` views
- the views are filtered by the current `identityId` and `agentKey`
- the SQL tool cannot read base tables directly

## Panda Env

Panda reads the main database URL from:

- `PANDA_DATABASE_URL`
- `DATABASE_URL`
- `--db-url`

Panda reads the SQL tool database URL from:

- `PANDA_READONLY_DATABASE_URL`
- `--read-only-db-url`

If `PANDA_READONLY_DATABASE_URL` is set, Panda uses that role for the SQL tool and grants it access to the scoped `panda_*` views during startup.

If it is not set, Panda currently falls back to the main app pool.
That fallback is convenient, but it weakens the privacy story.

## Recommended Local Setup

### 1. Make sure the main app connection works

Example:

```bash
PANDA_DATABASE_URL=postgres://panda_app:app_pw@localhost:5432/panda
```

If the main connection is broken, stop here and fix that first.

### 2. Create the read-only role

Create the role before starting Panda with `PANDA_READONLY_DATABASE_URL`.

```sql
CREATE ROLE panda_readonly LOGIN PASSWORD 'readonly_pw';
```

### 3. Let that role connect to the database

```sql
GRANT CONNECT ON DATABASE panda TO panda_readonly;
```

If your database is not named `panda`, replace it with the real name.

### 4. Point Panda at the same database with the new role

```bash
PANDA_READONLY_DATABASE_URL=postgres://panda_readonly:readonly_pw@localhost:5432/panda
```

You can also pass both URLs explicitly:

```bash
panda chat \
  --db-url postgres://panda_app:app_pw@localhost:5432/panda \
  --read-only-db-url postgres://panda_readonly:readonly_pw@localhost:5432/panda
```

### 5. Lock down the read-only role

If the read-only role can still read base tables, the setup is fake.

```sql
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM panda_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM panda_readonly;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM panda_readonly;
```

### 6. Start Panda once with both URLs set

Panda creates the scoped views and grants access during startup.
If you never start Panda with both roles configured, the grants do not happen.

## Verify It

Try a scoped view as the read-only user:

```bash
psql postgresql://panda_readonly:readonly_pw@localhost:5432/panda -c 'SELECT * FROM panda_threads LIMIT 1;'
```

That should work after Panda has booted.

Now try a raw table:

```bash
psql postgresql://panda_readonly:readonly_pw@localhost:5432/panda -c 'SELECT * FROM thread_runtime_threads LIMIT 1;'
```

That should fail with a permission error.

If the raw table query works, the role is not actually restricted and the setup is wrong.

## Views The SQL Tool Should Use

Treat these views as the public interface:

- `panda_threads`
- `panda_messages`
- `panda_messages_raw`
- `panda_tool_results`
- `panda_inputs`
- `panda_runs`

If the agent needs more safe query surface later, add another scoped view.
Do not solve that by handing the SQL tool raw table access.

## Hard Rules

- do not use the same role for `PANDA_DATABASE_URL` and `PANDA_READONLY_DATABASE_URL`
- do not grant the read-only role direct table access
- do not rely on prompt instructions for privacy
- prefer adding a new scoped view over exposing a raw table

Long term, Panda should disable `postgres_readonly_query` entirely when no restricted read-only URL is configured.
