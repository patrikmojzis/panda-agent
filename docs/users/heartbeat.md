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

- default cadence is every `30` minutes
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
- thread model

## Important Behavior

- the session must already exist
- `--every` keeps the current enabled or disabled state unless you also pass `--enable` or `--disable`
- `--enable` and `--disable` together is an error
- config updates reschedule the next fire time from now

That last rule is intentional. If you change the interval, Panda restarts the clock instead of honoring stale due timestamps.

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
