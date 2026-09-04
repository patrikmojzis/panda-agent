# Heartbeat

Heartbeat is a periodic wake for a session.

That is it.

It is not a cron clone, not a daemon health ping, and not a protocol waiting for `HEARTBEAT_OK`.

## Current V1 Behavior

Today heartbeat works like this:

- default cadence is every `60` minutes
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

Each claim has a unique token. Completion only clears that token and uses the
configuration revision to avoid overwriting a newer cadence change. A lost or
revoked claim is harmless. Configuration updates lock the session before its
heartbeat row, matching claim and archive lock order. Cadence-only updates never
write a stale enabled flag back over an operator disable.

Unchanged configuration is a full no-op. Shortening takes the earlier of the
existing due time and now plus the new interval; lengthening starts the new
interval from now. A valid claim owns its current tick, so a change during that
claim schedules the following tick from now. Already admitted input may still
execute after disable; the setter does not retract transcript input.

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
- configuration revision and last cadence change reason

This is cleaner than burying heartbeat state inside a fake home-thread row.

## Heartbeat Guidance

The heartbeat prompt stays intentionally simple.

Its synthetic wake text lives in `src/prompts/runtime/heartbeat.ts`.

It identifies the periodic wake and asks Panda to review open loops, follow-ups,
conversation momentum, or memory candidates. It includes the current interval
and last cadence change reason as data. When the session can invoke
`heartbeat.set`, it adds one short cadence-adjustment hint. The daemon reuses
command visibility and a read-only environment resolver; building the hint must
not provision or recover an environment. Invocation still checks the current
lease authority.

Silence is a valid outcome.

## Agent cadence commands

`heartbeat.show` and `heartbeat.set` are catalog commands under `operate`,
scoped to the authenticated calling session. They use the existing command shim
and daemon; they are not new native model tools. Detailed usage lives in
`panda heartbeat set --help`.

`PANDA_HEARTBEAT_MIN_EVERY_MINUTES` and `PANDA_HEARTBEAT_MAX_EVERY_MINUTES` bound
agent choices, defaulting to `15` and `1440`. They are read during runtime
assembly. The setter accepts only `everyMinutes` and a bounded single-line
`reason`; it cannot change enabled state. Operator controls share the atomic
store mutation but retain their own authorization and interval policy.

## Non-Goals In V1

- no `HEARTBEAT_OK`
- no heartbeat-specific response filtering
- no separate delivery-target architecture
- no isolated heartbeat sessions
- no per-channel heartbeat visibility rules
- no separate heartbeat run ledger

Keep it small. If it needs more machinery later, it can earn it.
