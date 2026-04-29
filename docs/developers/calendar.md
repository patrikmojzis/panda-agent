# Calendar

Calendar is Panda's agent-owned planning surface.

It is not a wake system. Scheduled tasks stay responsible for future execution.

## Shape

- one Radicale calendar per agent
- default collection path: `/AGENT/calendar`
- Docker stack service: `radicale`
- runtime env:
  - `PANDA_CALENDAR_URL`
  - `PANDA_CALENDAR_USERS_FILE`
  - `PANDA_CALENDAR_NAME`

`scripts/docker-stack.sh` enables Radicale automatically when `PANDA_AGENTS` is set, unless `PANDA_CALENDAR_ENABLED=false`.

## Runtime Contract

The `calendar` tool is scoped to the current runtime `agentKey`.

No agent selector is exposed to the model.
Cross-agent access is intentionally absent.

V1 supports:

- query events
- get event
- create event
- update event
- delete event
- all-day events
- notes on explicit tool calls

V1 intentionally skips:

- VTODO
- recurring event creation
- reminder wake semantics
- sharing
- arbitrary calendar URLs
- raw ICS input from the model

## Passive Context

`CalendarAgendaContext` injects a small agenda only when calendar is configured.

The context shows the current agent's events from the start of the current local week through 35 days later.
It is capped and excludes notes.

If Radicale is unavailable, the context stays silent. The explicit `calendar` tool reports operational errors.

## Docker Notes

Radicale is internal to the Docker network by default. No host port is published.

The stack writes plain htpasswd credentials under:

```text
~/.panda/radicale/config/users
```

The file is generated with owner-only permissions. The Docker stack also runs the Radicale process with the host UID/GID so the container can read that file without making passwords world-readable.
