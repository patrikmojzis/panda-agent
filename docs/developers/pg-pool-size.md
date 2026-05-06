# Postgres Pool Sizing

Panda needs an explicit Postgres connection budget.

Without one, each process happily uses the default `pg` pool max of `10`, and the deployment dies when the combined demand exceeds the database limit.

## Why This Exists

The failure mode is simple:

- Panda opens separate pools per long-running service.
- `pg` defaults each pool to `10`.
- Some Panda services also keep long-lived clients around for `LISTEN`, advisory locks, and other always-on work.
- The database does not care about our feelings. It only cares about total open sessions.

On `clankerino`, Postgres is currently:

- `max_connections = 25`
- `superuser_reserved_connections = 3`
- usable app slots = `22`

That means a deployment can kill itself purely by letting a few services use default pool settings.

## Current Cost Shape

Today the expensive pieces are not just burst traffic. They are the always-on clients that stay checked out from purpose-specific pools.

- `panda-core` uses `PANDA_CORE_DB_POOL_MAX` for short queries. Default: `5`.
- `panda-core` uses `PANDA_CORE_NOTIFICATION_DB_POOL_MAX` for `LISTEN/NOTIFY` clients. Default: `4`.
- `panda-core` uses `PANDA_CORE_THREAD_LEASE_DB_POOL_MAX` for advisory-lock thread leases. Default: `4`.
- `panda-core` has a separate readonly pool, but it is lazy and only exists after the readonly tool is actually used.
- `panda-telegram/<connectorKey>` keeps one shared worker `LISTEN` client.
- `panda-whatsapp/<connectorKey>` keeps one shared worker `LISTEN` client.
- Connector ownership uses lease rows with TTL, not pinned advisory-lock sessions.
- Docker healthchecks hit local HTTP endpoints, not the database.

So the pool max is not the whole story. The pinned clients still matter, and each lifetime now has an explicit cap.

## Recommended Budget

For a small 22-slot Postgres plan like `clankerino`, use this core budget:

- `panda-core` query pool: `5`
- `panda-core` notification pool: `4`
- `panda-core` thread lease pool: `4`
- `panda-core` readonly pool: `2`, lazy
- `panda-telegram`: `5`
- `panda-whatsapp`: `5`

Core plus one connector totals `18` active slots, or `20` after the lazy readonly pool is used.

Core plus both connector defaults totals `23` active slots, or `25` after readonly. Do not run that on a 22-slot plan without lowering connector pool caps or upsizing the database.

That is intentionally explicit. It gives Panda room to breathe without pretending the database is infinite.

## Budget Rules

- Treat pool `max` as a hard ceiling for each service, not a suggestion.
- Budget against deployed services, not theoretical ones.
- Leave at least `3` app slots unassigned on small Postgres plans like this one.
- Do not spend spare slots just because they exist. Save them for one-off admin work, migrations, and ugly moments.
- Bigger per-service pools are not automatically safer. Bigger aggregate ceilings are exactly how Panda gets `53300`.
- Keep `PANDA_DB_POOL_ACQUIRE_TIMEOUT_MS` set. It maps to pg's native `connectionTimeoutMillis`, so timed-out checkouts leave the pending queue instead of becoming invisible promise sludge.

## What Already Landed

The first real fixes are in:

- Connector action and delivery workers share one `LISTEN` client per process.
- Connector ownership uses `runtime.connector_leases` with expiry and renewal.
- `panda-core` splits query, notification, and advisory-lock traffic into separate pools.
- `panda-core` no longer pays for `panda/core-ro` at boot.
- Healthchecks are local HTTP probes instead of DB-backed pokes.
- Long-running pools set `application_name` and emit pool stats on startup, on errors, and while waiters exist.
- Runtime requests stuck in `running` are reclaimed after `PANDA_RUNTIME_REQUEST_CLAIM_TIMEOUT_MS`.

## Visibility

If Panda is going to use multiple pools, each client needs a name.

- set `application_name` on every pool
- include service role in the name: `panda/core`, `panda/core-notify`, `panda/core-lease`, `panda/core-ro`, `panda/telegram/<connectorKey>`, `panda/whatsapp/<connectorKey>`
- log pool stats on error and periodically: `totalCount`, `idleCount`, `waitingCount`
- fail health when the query pool has sustained waiters; that is backpressure, not vibes
- keep a canned `pg_stat_activity` query in the runbook so we can see who is hoarding connections in seconds, not after a crime scene reconstruction

Without `application_name`, debugging connection pressure is half guesswork.

Use this query when a box starts acting cursed:

```sql
SELECT
  application_name,
  state,
  COUNT(*)::INTEGER AS connections
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY application_name, state
ORDER BY connections DESC, application_name ASC, state ASC;
```

## Docker Guidance

These are worthwhile, but they are not the root fix:

- use `restart: unless-stopped` for `panda-core`, `panda-telegram`, and `panda-whatsapp`
- add healthchecks for long-running channel daemons
- keep those healthchecks cheap and avoid opening fresh DB pools every few seconds

Restart policies help Panda recover from transient failure. They do not fix bad connection budgeting.

## Remaining Questions

- If we add more always-on connectors, re-budget before shipping them.
- If readonly Postgres usage becomes frequent, recheck whether a separate `panda/core-ro` pool still earns its keep.
- If Postgres pressure returns, inspect `pg_stat_activity` first instead of guessing and cargo-culting lower pool caps.

My bias:

- keep explicit per-service budgets
- keep the lazy readonly pool
- keep connector ownership on leases, not session-pinning locks
