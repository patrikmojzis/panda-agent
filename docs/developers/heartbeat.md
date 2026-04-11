# Heartbeat

Heartbeat is a periodic wake for the current `home` thread.

That is it.

It is not a cron clone, not a daemon health ping, and not a protocol waiting for `HEARTBEAT_OK`.

## Current V1 Behavior

Today heartbeat works like this:

- default cadence is every `30` minutes
- the daemon runs a dedicated heartbeat runner
- the runner scans due `home_threads`
- if a thread is busy, Panda skips that tick and reschedules the next one
- if a thread is idle, Panda submits a synthetic input with `source: "heartbeat"`
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
- `identityId`

Example:

```json
{
  "heartbeat": {
    "kind": "interval",
    "scheduledFor": "2026-04-10T18:46:01.187Z",
    "identityId": "alice-id"
  }
}
```

## Agent Behavior

The heartbeat prompt is intentionally simple.
Its synthetic wake text lives in `src/prompts/runtime/heartbeat.ts`.

It tells Panda:

- this is a periodic wake
- review heartbeat guidance
- check pending promises, reminders, and unfinished follow-ups
- do not invent stale work
- only use outbound if it is intentional
- if nothing needs attention, move on quietly

Silence is a valid outcome.

## Runner Flow

The runner loop is:

1. list due home-thread heartbeats
2. claim one
3. resolve the current `home` thread id from the same row
4. skip if the thread is busy
5. otherwise enqueue a synthetic heartbeat input with `mode: "wake"`
6. reschedule the next fire time
7. clear the claim

The runner does not block on thread completion.
It only guarantees that the wake was submitted.

## Storage

Heartbeat state lives on the `home_threads` row.

The row stores:

- whether heartbeat is enabled
- cadence in minutes
- next fire time
- last fire time
- last skip reason
- claim state for the runner

We did not add a separate heartbeat table in v1.
Good. One less thing to regret.

## Heartbeat Doc Injection

Panda keeps a shared agent doc slug named `heartbeat`.

That doc is heartbeat-only.
It is not loaded into the normal shared agent workspace anymore.
Instead, the heartbeat runner reads it and injects it only into the synthetic heartbeat wake prompt rendered from `src/prompts/runtime/heartbeat.ts`.

That keeps normal runs cleaner and makes the heartbeat doc actually mean what its name says.

## Non-Goals In V1

- no `HEARTBEAT_OK`
- no heartbeat-specific response filtering
- no automatic delivery to the last remembered route
- no `tasks:` parser inside a heartbeat file
- no isolated heartbeat sessions
- no per-channel heartbeat visibility rules
- no separate heartbeat run ledger

Keep it small. If it needs more machinery later, it can earn it.
