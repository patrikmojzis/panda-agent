# Postgres Pool Sizing

Panda needs an explicit Postgres connection budget.

Without one, each process happily uses the default `pg` pool max of `10`, and the deployment dies when the combined demand exceeds the database limit.

## Why This Exists

The failure mode is simple:

- Panda opens separate pools per long-running service.
- `pg` defaults each pool to `10`.
- Some Panda services also pin long-lived clients for `LISTEN` and advisory locks.
- The database does not care about our feelings. It only cares about total open sessions.

On `clankerino`, Postgres is currently:

- `max_connections = 25`
- `superuser_reserved_connections = 3`
- usable app slots = `22`

That means a deployment can kill itself purely by letting a few services use default pool settings.

## Current Cost Shape

Today the expensive pieces are not just burst traffic. They are the always-on clients.

- `panda-core` keeps a long-lived notification listener.
- `panda-core` may also create a separate readonly pool.
- `panda-telegram` pins one advisory-lock client.
- `panda-telegram` pins one action `LISTEN` client.
- `panda-telegram` pins one delivery `LISTEN` client.
- `panda-whatsapp` follows the same general pattern.
- the current core Docker healthcheck opens a fresh DB pool on every run, which is cheap individually but still needless churn

So the pool max is not the whole story. The pinned clients matter.

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

## How To Spend Fewer Always-On Clients

These are the real structural wins:

- Collapse connector action and delivery listeners into one `LISTEN` client per connector process.
- Stop using a dedicated session-pinning advisory-lock client if a lease row plus heartbeat can do the job cleanly.
- Keep the readonly pool lazy and small.
- Replace DB-heavy liveness checks with a cheap in-process health endpoint or local heartbeat file.

Until those land, budget as if the pinned clients are permanent, because right now they are.

## Visibility We Should Add

If Panda is going to use multiple pools, each client needs a name.

- set `application_name` on every pool
- include service role in the name: `panda/core`, `panda/core-ro`, `panda/telegram/<connectorKey>`, `panda/whatsapp/<connectorKey>`, `panda/health/core`
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

## Open Questions

- Should connector ownership stay on Postgres advisory locks, or move to a lease row with expiry?
- Should channel actions and outbound deliveries share one notification channel per connector process?
- Should the readonly pool exist at runtime startup, or only be created on first actual readonly-tool use?
- Should small deployments expose pool limits via env vars per service, or one global budget that Panda splits internally?

My bias:

- keep the first implementation boring
- configure per-service pool max explicitly
- add `application_name`
- cut the duplicate `LISTEN` clients next
