# Postgres Pool Sizing

Panda needs an explicit Postgres connection budget.

Without one, each process happily uses the default `pg` pool max of `10`, and the deployment dies when the combined demand exceeds the database limit.

## Why This Exists

The failure mode is simple:

- Panda opens separate pools per long-running service.
- `pg` defaults each pool to `10`.
- Some Panda services also keep long-lived clients around for `LISTEN` and other always-on work.
- The database does not care about our feelings. It only cares about total open sessions.

On `clankerino`, Postgres is currently:

- `max_connections = 25`
- `superuser_reserved_connections = 3`
- usable app slots = `22`

That means a deployment can kill itself purely by letting a few services use default pool settings.

## Current Cost Shape

Today the expensive pieces are not just burst traffic. They are the always-on clients that stay checked out from each pool.

- `panda-core` keeps one long-lived runtime `LISTEN` client.
- `panda-core` has a separate readonly pool, but it is lazy and only exists after the readonly tool is actually used.
- `panda-telegram/<connectorKey>` keeps one shared worker `LISTEN` client.
- `panda-whatsapp/<connectorKey>` keeps one shared worker `LISTEN` client.
- Connector ownership uses lease rows with TTL, not pinned advisory-lock sessions.
- Docker healthchecks hit local HTTP endpoints, not the database.

So the pool max is not the whole story. The pinned clients still matter, they are just much cheaper than before.

## Recommended Budget

For the current `clankerino` deployment, use this budget:

- `panda-core` main pool: `7`
- `panda-core` readonly pool: `2`
- `panda-telegram`: `5`
- `panda-whatsapp`: `5`

That totals `19` against `22` usable slots, leaving `3` spare.

That is intentionally not razor-thin and not sloppy. It gives Panda room to breathe without pretending the database is infinite.

## Budget Rules

- Treat pool `max` as a hard ceiling for each service, not a suggestion.
- Budget against deployed services, not theoretical ones.
- Leave at least `3` app slots unassigned on small Postgres plans like this one.
- Do not spend spare slots just because they exist. Save them for one-off admin work, migrations, and ugly moments.
- Bigger per-service pools are not automatically safer. Bigger aggregate ceilings are exactly how Panda gets `53300`.

## What Already Landed

The first real fixes are in:

- Connector action and delivery workers share one `LISTEN` client per process.
- Connector ownership uses `runtime.connector_leases` with expiry and renewal.
- `panda-core` no longer pays for `panda/core-ro` at boot.
- Healthchecks are local HTTP probes instead of DB-backed pokes.
- Long-running pools set `application_name` and emit pool stats on startup, on errors, and while waiters exist.

## Visibility

If Panda is going to use multiple pools, each client needs a name.

- set `application_name` on every pool
- include service role in the name: `panda/core`, `panda/core-ro`, `panda/telegram/<connectorKey>`, `panda/whatsapp/<connectorKey>`
- log pool stats on error and periodically: `totalCount`, `idleCount`, `waitingCount`
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
