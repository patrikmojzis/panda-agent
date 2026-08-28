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

Today the expensive pieces are not just burst traffic. They are the always-on clients that stay checked out from purpose-specific pools.

- `panda-core` uses `PANDA_CORE_DB_POOL_MAX` for short queries. Default: `4`.
- `panda-core` uses `PANDA_CORE_NOTIFICATION_DB_POOL_MAX` for `LISTEN/NOTIFY` clients. Default: `4`.
- `panda-core` uses `PANDA_CORE_MODEL_CALL_DB_POOL_MAX` for bounded asynchronous trace batches. Default: `1`.
- `panda-core` has a separate readonly pool with default `1`, but it is lazy and only exists after the readonly tool is actually used.
- Each channel daemon owns one bounded pool and one shared `LISTEN` client, regardless of account count.
- Telegram, Discord, and WhatsApp account workers reuse their daemon pool. Protocol connections remain per account.
- Discord action, delivery, and voice notifications share the Discord listener; voice does not pin another client.
- Connector ownership uses lease rows with TTL, not pinned advisory-lock sessions.
- Docker healthchecks hit local HTTP endpoints, not the database.

So the pool max is not the whole story. The pinned clients still matter, and each lifetime now has an explicit cap.

## Recommended Budget

For a small 22-slot Postgres plan like `clankerino`, use this core budget:

- `panda-core` query pool: `4`
- `panda-core` notification pool: `4`
- `panda-core` model-call trace writer pool: `1`
- `panda-core` readonly pool: `1`, lazy
- `panda-telegram`: `2` per daemon or single-account run
- `panda-discord`: `2` per daemon or single-account run
- `panda-whatsapp`: `2` per daemon or single-account run

The standard core-plus-three-channel ceiling is `4 + 4 + 1 + 1 + 2 + 2 + 2 = 16`. That leaves six slots on a 22-usable-connection plan.

That `16` is only the baseline. Gateway, Wiki.js, admin sessions, migrations, and other optional consumers need their own additional budget. They are not squeezed into those six spare slots by wishful arithmetic.

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

- Connector action, delivery, and Discord voice workers share one `LISTEN` client per process.
- Connector ownership uses `runtime.connector_leases` with expiry and renewal.
- `panda-core` splits query, notification, and asynchronous trace-write traffic into separate pools.
- The trace-writer pool bounds statements at 5 seconds and client queries at 7.5 seconds so best-effort telemetry cannot wedge shutdown.
- Thread concurrency is process-local backpressure capped by `PANDA_CORE_THREAD_RUN_CONCURRENCY`; durable run claims do not pin database clients.
- Scheduled occurrence supervision is independently capped by `PANDA_SCHEDULED_TASK_CONCURRENCY` (default `4`); it keeps unrelated tasks moving without pinning database clients while their exact thread runs execute.
- Mechanical command supervision is capped by `PANDA_SCHEDULED_COMMAND_CONCURRENCY` (default `2`). Shell execution happens in remote agent runners and does not pin database clients; short claim and settlement statements use the core query pool.
- `panda-core` no longer pays for `panda/core-ro` at boot.
- Healthchecks are local HTTP probes instead of DB-backed pokes.
- Long-running pools set `application_name` and emit pool stats on startup, on errors, and while waiters exist.
- Runtime request claims use renewable leases configured by
  `PANDA_RUNTIME_REQUEST_CLAIM_LEASE_MS`; token-fenced settlement prevents a
  reclaimed worker from overwriting the new owner.
- Runtime request processing is capped by `PANDA_RUNTIME_REQUEST_CONCURRENCY`
  (default `4`). Handlers borrow connections only for bounded statements; they
  do not pin clients while media, provider, or compaction work runs.
- Runtime request shutdown waits at most
  `PANDA_RUNTIME_REQUEST_DRAIN_TIMEOUT_MS` (default `30000`) and stops claim
  renewal immediately, so a stuck handler cannot pin daemon teardown.
- Other daemon listener, runner, and HTTP shutdown joins wait at most
  `PANDA_DAEMON_SERVICE_STOP_TIMEOUT_MS` (default `5000`) each. Postgres pools
  still close last, after the owner-fenced work has had its bounded drain.

## Visibility

If Panda is going to use multiple pools, each client needs a name.

- set `application_name` on every pool
- include service role in the name: `panda/core`, `panda/core-notify`, `panda/core-trace`, `panda/core-ro`, `panda/telegram`, `panda/discord`, `panda/whatsapp`
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

- use `restart: unless-stopped` for `panda-core`, `panda-telegram`, `panda-discord`, and `panda-whatsapp`
- add healthchecks for long-running channel daemons
- keep those healthchecks cheap and avoid opening fresh DB pools every few seconds

Restart policies help Panda recover from transient failure. They do not fix bad connection budgeting.

## Remaining Questions

- If we add more channel daemons or other always-on consumers, re-budget before shipping them.
- If readonly Postgres usage becomes frequent, recheck whether a separate `panda/core-ro` pool still earns its keep.
- If Postgres pressure returns, inspect `pg_stat_activity` first instead of guessing and cargo-culting lower pool caps.

My bias:

- keep explicit per-service budgets
- keep the lazy readonly pool
- keep connector ownership on leases, not session-pinning locks
