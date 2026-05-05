# Postgres

## Preferred Setup

Use one Postgres database.
Do not make a separate database per identity.

Best practice for the Panda runtime is:

- one shared Postgres database
- one normal app role
- one restricted read-only role
- scoped `session.*` views as the only SQL tool surface

That is the clean setup. Everything else is half-security cosplay.

If you also run Wiki.js, give it its own database and role.
That makes the company deployment shape:

- `DATABASE_URL` -> `panda_app` on `panda`
- `READONLY_DATABASE_URL` -> `panda_readonly` on `panda`
- `WIKI_DB_URL` -> `panda_wiki` on `panda_wiki`

Three users is the right lane.
Do not reuse the Panda app role for Wiki.js.

## Before You Start

You need:

- a running Postgres server
- one database Panda already uses, or will use
- one normal Panda app connection that already works

If Panda cannot connect with `DATABASE_URL` yet, fix that first.
Do not debug the read-only role before the main app role works.

## Why

The `postgres_readonly_query` tool is read-only.
It is not view-only by itself.

Privacy does not come from the prompt or from the tool description.
Privacy comes from the database role you give that tool.

The right shape is:

- `postgres_readonly_query` reads only `session.*` views
- the views are filtered by the current `sessionId` and `agentKey`
- the SQL tool cannot read base tables directly

## Panda Env

Panda reads the main database URL from:

- `DATABASE_URL`
- `--db-url`

Panda reads the SQL tool database URL from:

- `READONLY_DATABASE_URL`
- `--read-only-db-url`

If `READONLY_DATABASE_URL` is set, Panda uses that role for the SQL tool and grants it access to the scoped `session.*` views during startup.

If it is not set, Panda currently falls back to the main app pool.
That fallback is convenient, but it weakens the privacy story.

## Production Role Setup

Run this as a Postgres admin, with real passwords.
If your managed Postgres provider creates databases for you, apply the same ownership and grants to the provider-created databases.

```sql
CREATE ROLE panda_app LOGIN PASSWORD 'app_pw';
CREATE ROLE panda_readonly LOGIN PASSWORD 'readonly_pw';
CREATE ROLE panda_wiki LOGIN PASSWORD 'wiki_pw';

CREATE DATABASE panda OWNER panda_app;
CREATE DATABASE panda_wiki OWNER panda_wiki;

REVOKE ALL ON DATABASE panda FROM PUBLIC;
REVOKE ALL ON DATABASE panda_wiki FROM PUBLIC;

GRANT CONNECT, TEMPORARY, CREATE ON DATABASE panda TO panda_app;
GRANT CONNECT ON DATABASE panda TO panda_readonly;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE panda_wiki TO panda_wiki;
```

Then connect to `panda` as an admin and make Panda's runtime schemas app-owned:

```sql
-- DigitalOcean example: keep Panda out of public, even though it owns the DB.
-- On another provider, replace doadmin with your admin role.
ALTER SCHEMA public OWNER TO doadmin;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS runtime AUTHORIZATION panda_app;
CREATE SCHEMA IF NOT EXISTS session AUTHORIZATION panda_app;
ALTER SCHEMA runtime OWNER TO panda_app;
ALTER SCHEMA session OWNER TO panda_app;

GRANT USAGE, CREATE ON SCHEMA runtime TO panda_app;
GRANT USAGE, CREATE ON SCHEMA session TO panda_app;
GRANT USAGE ON SCHEMA session TO panda_readonly;

REVOKE ALL ON SCHEMA runtime FROM panda_readonly;
REVOKE CREATE ON SCHEMA session FROM panda_readonly;
REVOKE ALL ON SCHEMA public FROM panda_app, panda_readonly, panda_wiki;
REVOKE ALL ON ALL TABLES IN SCHEMA runtime FROM panda_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA runtime FROM panda_readonly;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA runtime FROM panda_readonly;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM panda_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM panda_readonly;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM panda_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE panda_app IN SCHEMA runtime
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE panda_app IN SCHEMA runtime
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE panda_app IN SCHEMA runtime
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE panda_app IN SCHEMA session
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE panda_app IN SCHEMA session
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE panda_app IN SCHEMA session
  GRANT SELECT ON TABLES TO panda_readonly;
```

Then connect to `panda_wiki` as an admin and keep Wiki.js boxed into its own database:

```sql
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO panda_wiki;
GRANT USAGE, CREATE ON SCHEMA public TO panda_wiki;
REVOKE ALL ON SCHEMA public FROM panda_app, panda_readonly;
```

Important: the Panda app role must own, or be able to create and alter, the `runtime` and `session` schemas.
Panda creates tables, alters tables, drops/recreates readonly views, and grants view access during startup.
Plain `SELECT/INSERT/UPDATE/DELETE` grants are not enough.
If an admin already created Panda objects, transfer ownership to `panda_app` or recreate them as `panda_app`.
Postgres grants do not let a non-owner `ALTER TABLE` or `DROP VIEW`.

Use URLs shaped like this:

```dotenv
DATABASE_URL=postgresql://panda_app:app_pw@db.example.com:5432/panda
READONLY_DATABASE_URL=postgresql://panda_readonly:readonly_pw@db.example.com:5432/panda
WIKI_DB_URL=postgresql://panda_wiki:wiki_pw@db.example.com:5432/panda_wiki
```

## Recommended Local Setup

For a company deployment, use the production setup above.
This local path is only the small version for a database that already works.

### 1. Make sure the main app connection works

Example:

```bash
DATABASE_URL=postgres://panda_app:app_pw@localhost:5432/panda
```

If the main connection is broken, stop here and fix that first.

### 2. Create the read-only role

Create the role before starting Panda with `READONLY_DATABASE_URL`.

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
READONLY_DATABASE_URL=postgres://panda_readonly:readonly_pw@localhost:5432/panda
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
psql postgresql://panda_readonly:readonly_pw@localhost:5432/panda -c 'SELECT * FROM session.threads LIMIT 1;'
```

That should work after Panda has booted.

Now try a raw table:

```bash
psql postgresql://panda_readonly:readonly_pw@localhost:5432/panda -c 'SELECT * FROM runtime.threads LIMIT 1;'
```

That should fail with a permission error.

If the raw table query works, the role is not actually restricted and the setup is wrong.

## Views The SQL Tool Should Use

Treat these views as the public interface:

- `session.agent_sessions`
- `session.threads`
- `session.messages`
- `session.messages_raw`
- `session.tool_results`
- `session.inputs`
- `session.runs`
- `session.agent_prompts`
- `session.agent_pairings`
- `session.agent_skills`
- `session.agent_telepathy_devices`
- `session.scheduled_tasks`
- `session.scheduled_task_runs`
- `session.watches`
- `session.watch_runs`
- `session.watch_events`

If the agent needs more safe query surface later, add another scoped view.
Do not solve that by handing the SQL tool raw table access.

`session.agent_skills` exposes stored skill bodies.
Use `description` or `substring(content from ... for ...)` for large skills instead of yanking the whole blob every time.

## Hard Rules

- do not use the same role for `DATABASE_URL` and `READONLY_DATABASE_URL`
- do not grant the read-only role direct table access
- do not rely on prompt instructions for privacy
- prefer adding a new scoped view over exposing a raw table

Long term, Panda should disable `postgres_readonly_query` entirely when no restricted read-only URL is configured.
