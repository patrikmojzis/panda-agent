# Wiki.js Local Setup

Panda can run Wiki.js as a separate local service while keeping the main Panda runtime on its own database.

Current local shape:

- one Wiki.js container
- same PostgreSQL server as Panda
- separate database: `panda_wiki`
- one scoped group + API token per agent namespace
- Panda stores the token encrypted in its own database, not in the credentials table and not in debug env files

## Env

Add these to your local `.env`:

```dotenv
CREDENTIALS_MASTER_KEY=
WIKI_ADMIN_EMAIL=
WIKI_ADMIN_PASSWORD=
WIKI_URL=http://wiki:3000
WIKI_PUBLISH_PORT=3100
WIKI_SITE_URL=
WIKI_SEARCH_DICT_LANGUAGE=simple
WIKI_DB_URL=
WIKI_DB_SSL_CERT_FILE=
WIKI_DB_SSL_CA=
```

On macOS, `host.docker.internal` lets the Wiki.js container reach Postgres running on the host.
The helper scripts auto-detect the host cert file in this order:

- `/etc/ssl/certs/panda-postgres-ca.crt`
- `$HOME/.panda/ca.crt`

Preferred setup is a single URI:

```dotenv
WIKI_DB_URL=postgresql://user:pass@host:5432/panda_wiki
```

For Panda runtime inside Docker, use:

```dotenv
WIKI_URL=http://wiki:3000
```

`WIKI_SITE_URL` is for host-side helper scripts like `wiki-local.sh`.
`WIKI_URL` is for Panda runtime code talking to the Wiki.js container over the Docker network.

Host publishing is opt-in.

For local `./scripts/wiki-local.sh init` / `bootstrap`, the easiest path is:

```dotenv
WIKI_PUBLISH_PORT=3100
```

That binds Wiki.js only on `127.0.0.1`, not on every host interface.
If `WIKI_SITE_URL` is empty, `wiki-local.sh` derives it as `http://127.0.0.1:${WIKI_PUBLISH_PORT}`.
If you do not want host publishing, leave `WIKI_PUBLISH_PORT` empty and set `WIKI_SITE_URL` to some other host-reachable Wiki URL before using the helper script.

For TLS with a mounted cert file, keep the container path fixed and only vary the host file when needed:

```dotenv
WIKI_DB_SSL_CERT_FILE=/Users/patrikmojzis/.panda/ca.crt
WIKI_DB_URL=postgresql://user:pass@host:25060/panda_wiki?sslmode=verify-full&sslrootcert=/etc/ssl/certs/panda-postgres-ca.crt
```

On the VPS, the current path already is `/etc/ssl/certs/panda-postgres-ca.crt`, so you likely do not need to set `WIKI_DB_SSL_CERT_FILE` at all.

This matches the current Panda stack shape: the host cert file is bind-mounted into the container at `/etc/ssl/certs/panda-postgres-ca.crt`, and `sslrootcert` should always point there.

If you prefer not to use `sslrootcert`, Wiki.js also accepts the CA body inline:

```dotenv
WIKI_DB_URL=postgresql://user:pass@host:25060/panda_wiki?sslmode=verify-full
WIKI_DB_SSL_CA=<single-line certificate body without BEGIN/END lines>
```

## Commands

```bash
./scripts/wiki-local.sh init
./scripts/wiki-local.sh logs
./scripts/wiki-local.sh down
```

Wiki.js can also ride along with the main Docker stack:

```dotenv
WIKI_ADMIN_EMAIL=admin@localhost
WIKI_ADMIN_PASSWORD=change-me
PANDA_AGENTS=panda,luna
```

Then:

```bash
./scripts/docker-stack.sh up
./scripts/docker-stack.sh logs wiki
```

`init` will:

- start Wiki.js
- run the first-time setup if needed
- enable the GraphQL API
- switch Wiki.js search from the basic `db` engine to the built-in `postgres` engine
- rebuild the Wiki.js search index
- create or update one group per agent in `PANDA_AGENTS`
- apply one namespace page rule per agent, e.g. `agents/panda`
- rotate one scoped API token per agent
- store that token encrypted in Panda via `panda wiki binding set`

`WIKI_SEARCH_DICT_LANGUAGE=simple` is the sane default for agent memory. It is less clever than language-specific stemming, which is exactly why it behaves better with mixed notes, names, code, and half-structured markdown.

Useful operator command:

```bash
pnpm exec tsx src/app/cli.ts wiki binding show panda
```

## Rule Path Gotcha

Wiki.js page-rule paths are stored without a leading slash.

Use:

- `agents/panda`

Not:

- `/agents/panda`

The UI shows a `/` prefix, but the stored rule value itself should not include it.
