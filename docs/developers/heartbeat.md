# Heartbeat

Heartbeat is a periodic wake for a session.

That is it.

It is not a cron clone, not a daemon health ping, and not a protocol waiting for `HEARTBEAT_OK`.

## Current V1 Behavior

Today heartbeat works like this:

- default cadence is every `30` minutes
- the daemon runs a dedicated heartbeat runner
- the runner scans due `session_heartbeats`
- main sessions start enabled by default
- branch sessions start disabled by default
- if a session thread is busy, Panda skips that tick and reschedules the next one
- if the thread is idle, Panda submits a synthetic input with `source: "heartbeat"`
- Panda does not wait for the run to finish before moving on

Busy means either:

- the thread already has an active run
- the thread already has pending inputs waiting to be processed

That second rule matters. Heartbeat should not pile stale nudges behind real work.

## Transcript Shape

Heartbeat is durable history.

The runner injects a normal thread input:

- `origin = input`
- `source = "heartbeat"`
- `message.role = "user"`

The input metadata includes a small heartbeat payload with:

- `kind`
- `scheduledFor`
- `sessionId`

Example:

```json
{
  "heartbeat": {
    "kind": "interval",
    "scheduledFor": "2026-04-10T18:46:01.187Z",
    "sessionId": "session-main"
  }
}
```

## Runner Flow

The runner loop is:

1. list due session heartbeats
2. claim one
3. re-resolve the session
4. read `session.current_thread_id`
5. skip if that thread is busy
6. otherwise enqueue a synthetic heartbeat input with `mode: "wake"`
7. reschedule the next fire time
8. clear the claim

Re-resolving the session after claim is important.
That is what makes heartbeat follow resets cleanly.

## Storage

Heartbeat state lives in the `session_heartbeats` table.

The row stores:

- whether heartbeat is enabled
- cadence in minutes
- next fire time
- last fire time
- last skip reason
- claim state for the runner

This is cleaner than burying heartbeat state inside a fake home-thread row.

## Heartbeat Guidance

The heartbeat prompt stays intentionally simple.

Its synthetic wake text lives in `src/prompts/runtime/heartbeat.ts`.

It tells Panda:

- this is a periodic wake
- review heartbeat guidance
- check pending promises, reminders, and unfinished follow-ups
- do not invent stale work
- only use outbound if it is intentional
- if nothing needs attention, move on quietly

Silence is a valid outcome.

## Non-Goals In V1

- no `HEARTBEAT_OK`
- no heartbeat-specific response filtering
- no separate delivery-target architecture
- no isolated heartbeat sessions
- no per-channel heartbeat visibility rules
- no separate heartbeat run ledger

Keep it small. If it needs more machinery later, it can earn it.
