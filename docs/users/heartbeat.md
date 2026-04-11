# Heartbeat

Heartbeat is a periodic wake for the current `home` thread.

That is it.

It is not a cron clone.
It is not a daemon health ping.
It is not a mini protocol waiting for `HEARTBEAT_OK`.

## What It Does

When heartbeat is due:

- Panda checks the current `home` thread for the identity
- if the thread is idle, Panda injects a synthetic heartbeat input
- the agent can think, use tools, send outbound, or stay quiet

If the thread is busy, Panda skips that tick and schedules the next one.

Silence is a valid outcome.

## Current V1 Behavior

Today heartbeat works like this:

- default cadence is every `30` minutes
- heartbeat belongs to the current `home` thread
- if `home` is reset or rebound, heartbeat follows the new `home`
- Panda does not wait for the run to finish before moving on

Busy means either:

- the thread already has an active run
- the thread already has pending inputs waiting to be processed

That second rule matters. Heartbeat should not pile stale nudges behind real user work.

## CLI

Inspect the current heartbeat config:

```bash
panda identity heartbeat local
```

Disable heartbeat:

```bash
panda identity heartbeat local --disable
```

Enable heartbeat again:

```bash
panda identity heartbeat local --enable
```

Change cadence to every 45 minutes:

```bash
panda identity heartbeat local --every 45
```

Do both in one shot:

```bash
panda identity heartbeat local --enable --every 45
```

The inspect command prints:

- current home thread id
- whether heartbeat is enabled
- interval in minutes
- next fire time
- last fire time
- last skip reason

## Important Behavior

- the identity must already have a `home` thread
- `--every` keeps the current enabled or disabled state unless you also pass `--enable` or `--disable`
- `--enable` and `--disable` together is an error
- config updates reschedule the next fire time from now

That last rule is intentional. If you change the interval, Panda restarts the clock instead of honoring stale due timestamps.

## What Heartbeat Is Good For

Use it for soft periodic work on the main relationship thread:

- checking unfinished follow-ups
- nudging the agent to review reminders
- periodic "anything pending?" sweeps
- proactive memory or diary maintenance

## What Heartbeat Is Not Good For

Do not use it for:

- exact scheduling
- isolated jobs
- delayed delivery workflows
- anything that must run even if the main thread is busy

If you are changing heartbeat internals, use the developer doc:

- [Developer Heartbeat Notes](../developers/heartbeat.md)
