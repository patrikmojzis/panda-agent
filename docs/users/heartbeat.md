# Heartbeat

Heartbeat is a periodic wake for a session.

That is it.

It is not a cron clone.
It is not a daemon health ping.
It is not a mini protocol waiting for `HEARTBEAT_OK`.

## What It Does

When heartbeat is due:

- Panda checks the session's current thread
- if that thread is idle, Panda injects a synthetic heartbeat input
- the agent can think, use tools, send outbound, or stay quiet

If the thread is busy, Panda skips that tick and schedules the next one.

Silence is a valid outcome.

## Current V1 Behavior

Today heartbeat works like this:

- default cadence is every `60` minutes
- heartbeat belongs to a session
- main sessions start enabled by default
- branch sessions start disabled by default
- if the session is reset, heartbeat follows the new current thread automatically
- Panda does not wait for the run to finish before moving on

Busy means either:

- the thread already has an active run
- the thread already has pending inputs waiting to be processed

That second rule matters. Heartbeat should not pile stale nudges behind real user work.

## CLI

Agents with `operate` can inspect and change their own session's ongoing interval:

```bash
panda heartbeat show
panda heartbeat set --every 15m --reason "Active investigation"
panda heartbeat set --every 4h --reason "Quiet period"
panda heartbeat set --help
```

The interval persists until changed again. Minutes (`15` or `15m`) and whole
hours (`4h`) are supported. JSON input uses `everyMinutes` and `reason`.
Results include the enabled state, interval, next timestamp, last change reason,
and allowed limits. Changing cadence never enables a disabled heartbeat.

The operator sets agent limits through `PANDA_HEARTBEAT_MIN_EVERY_MINUTES`
(default `15`) and `PANDA_HEARTBEAT_MAX_EVERY_MINUTES` (default `1440`). These
limits apply to agent commands; operator controls remain separate.

Use a shorter interval when frequent reassessment helps and a longer one during
quiet periods, after checking live commitments. Use `panda schedule` for a
specific timed task and `panda watch` for external change detection.

The following operator commands can also enable and disable heartbeat:

List sessions for an agent:

```bash
panda session list luna
```

Inspect one session:

```bash
panda session inspect 2c8d0a1e-...
```

Disable heartbeat:

```bash
panda session heartbeat 2c8d0a1e-... --disable
```

Enable heartbeat again:

```bash
panda session heartbeat 2c8d0a1e-... --enable
```

Change cadence to every 45 minutes:

```bash
panda session heartbeat 2c8d0a1e-... --every 45
```

Do both in one shot:

```bash
panda session heartbeat 2c8d0a1e-... --enable --every 45
```

`panda session inspect` prints:

- current thread id
- whether heartbeat is enabled
- interval in minutes
- runtime model
- runtime thinking setting

## Important Behavior

- the session must already exist
- `--every` keeps the current enabled or disabled state unless you also pass `--enable` or `--disable`
- `--enable` and `--disable` together is an error
- unchanged configuration is a no-op, including the next fire time and reason
- shortening an enabled interval keeps an already earlier pending tick; otherwise the next tick is due after the new interval
- lengthening an enabled interval schedules its next tick from now
- a tick already claimed may finish; a cadence change applies to the following tick
- disabling a heartbeat preserves the stored next fire time while it is off
- enabling a disabled heartbeat starts the interval from now
- operator cadence changes clear an older agent-provided reason

## What Heartbeat Is Good For

Use it for soft periodic work on the main session:

- checking unfinished follow-ups
- nudging the agent to review reminders
- periodic "anything pending?" sweeps
- proactive memory or diary maintenance

## What Heartbeat Is Not Good For

Do not use it for:

- exact scheduling
- isolated jobs
- outbound delivery orchestration
- anything that must run even if the session thread is busy

If you are changing heartbeat internals, use the developer doc:

- [Developer Heartbeat Notes](../developers/heartbeat.md)
