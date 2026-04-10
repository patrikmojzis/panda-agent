# Heartbeat

Panda heartbeat is a periodic wake for the current `home` thread.

That is it.

It is not a cron clone.
It is not a daemon health ping.
It is not a mini protocol that waits for `HEARTBEAT_OK`.

Heartbeat is fire-and-forget:

- Panda decides a `home` thread is due
- Panda injects a synthetic heartbeat input into that thread
- Panda wakes the thread
- the agent does whatever it thinks is worth doing

If the agent wants to stay quiet, it stays quiet.
If it wants to message the user, it must do that deliberately with outbound.

## Mental Model

Heartbeat belongs to the current `home` thread for an identity.

That means:

- one identity gets one heartbeat schedule
- heartbeat follows the current `home` pointer
- if `home` is reset or rebound, heartbeat keeps following the new `home`

This matches Panda's chat model:

- one brain
- many windows
- `home` is the default execution target for scheduled work

## Current V1 Behavior

Today heartbeat works like this:

- default cadence is every `30` minutes
- the daemon runs a dedicated heartbeat runner
- the runner scans due `home_threads`
- if a thread is busy, Panda skips that tick and reschedules the next one
- if a thread is idle, Panda submits a synthetic input with `source: "heartbeat"`
- Panda does **not** wait for the run to finish before moving on

Busy means either:

- the thread already has an active run
- or the thread already has pending inputs waiting to be processed

That second rule matters.
We do not want stale heartbeat nudges piling up behind real user work.

## No Ack Protocol

There is no `HEARTBEAT_OK` contract in Panda v1.

We dropped it on purpose.

Reasons:

- it is extra protocol noise
- Panda does not need to parse a heartbeat-specific response token
- the runtime should not care whether the model says "nothing to do"
- heartbeat is just another wake source

So:

- no ack parsing
- no ack suppression
- no transcript filtering for heartbeat acks
- no waiting for a special response before rescheduling

## Transcript Behavior

Heartbeat is durable history.

The runner injects a normal thread input:

- `origin = input`
- `source = "heartbeat"`
- `message.role = "user"`

The input metadata includes a small heartbeat payload with:

- kind
- scheduled fire time
- identity id

This makes heartbeat visible in the transcript and in runtime context without inventing a separate hidden execution path.

Example shape:

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

It tells Panda:

- this is a periodic wake
- review heartbeat guidance
- check pending promises, reminders, and unfinished follow-ups
- do not invent stale work
- only use outbound if it is intentional
- if nothing needs attention, move on quietly

That last part is important.
Silence is a valid outcome.

## Delivery Behavior

Heartbeat does not auto-deliver the final assistant message.

That is deliberate.

In v1:

- heartbeat wakes the thread
- the agent can think, update memory, use tools, or do nothing
- user-facing delivery only happens if the agent explicitly uses outbound

This keeps the runtime dumb and predictable.
No magical "last route" delivery logic is hidden inside heartbeat itself.

## Storage

Heartbeat state lives on the `home_threads` row.

The row now stores:

- whether heartbeat is enabled
- cadence in minutes
- next fire time
- last fire time
- last skip reason
- claim state for the runner

This is small and boring, which is good.

We did **not** add a separate heartbeat table in v1.

## Config Surface

Heartbeat is now configurable from the CLI:

- `panda identity heartbeat <handle>` inspects the current home-thread heartbeat
- `panda identity heartbeat <handle> --disable` turns it off
- `panda identity heartbeat <handle> --enable` turns it back on
- `panda identity heartbeat <handle> --every 45` changes the cadence

Examples:

```bash
# inspect the current heartbeat config
panda identity heartbeat local

# disable heartbeat for this identity's current home thread
panda identity heartbeat local --disable

# re-enable it
panda identity heartbeat local --enable

# change cadence to every 45 minutes
panda identity heartbeat local --every 45

# do both in one shot
panda identity heartbeat local --enable --every 45
```

`<handle>` is the Panda identity handle.
The command reads and updates the heartbeat attached to that identity's current `home` thread.

The inspect command prints:

- current home thread id
- whether heartbeat is enabled
- interval in minutes
- next fire time
- last fire time
- last skip reason

Important behavior:

- the identity must already have a `home` thread
- `--every` keeps the current enabled/disabled state unless you also pass `--enable` or `--disable`
- `--enable` and `--disable` together is an error

Config updates reschedule the next fire time from "now".

That is intentional.
If you change the interval, Panda should restart the clock instead of trying to honor some stale due timestamp.

That means:

- if you run `--every 45` at `12:00`, the next fire becomes roughly `12:45`
- if you run `--disable`, Panda keeps the state but the runner will ignore it while disabled
- if you later run `--enable`, Panda restarts the countdown from that update time

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

## What Heartbeat Is Good For

Heartbeat is good for soft periodic work on the main relationship thread:

- checking unfinished follow-ups
- nudging the agent to review reminders
- periodic "anything pending?" sweeps
- proactive memory or diary maintenance

Use heartbeat when exact timing does not matter and when the work belongs to the main `home` conversation.

## What Heartbeat Is Not Good For

Do not use heartbeat for:

- exact scheduling
- isolated jobs
- delayed delivery workflows
- anything that must run even if the main thread is busy

That is scheduled-task territory.

## Heartbeat Doc

Panda keeps a shared agent doc slug named `heartbeat`.

That doc is now heartbeat-only.

It does **not** get loaded into the normal shared agent workspace anymore.
Instead, the heartbeat runner reads it and injects it only into the synthetic heartbeat wake prompt.

That keeps normal runs cleaner and makes the heartbeat doc actually mean what its name says.

## Non-Goals In V1

We are intentionally not doing this yet:

- no `HEARTBEAT_OK`
- no heartbeat-specific response filtering
- no automatic delivery to the last remembered route
- no `tasks:` parser inside a heartbeat file
- no isolated heartbeat sessions
- no per-channel heartbeat visibility rules
- no separate heartbeat run ledger

Keep it small.
If it needs more machinery later, earn it.
