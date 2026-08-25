# ADR 0002: Archive Sessions Through A Durable Runtime Fence

- Status: Accepted
- Date: 2026-08-25

## Context

A session owns durable runtime work: its current thread, routes, prompts, todos,
heartbeat, watches, scheduled tasks, execution bindings, and queued effects.
Deleting the session is therefore the wrong way to retire a branch. Foreign-key
cascades erase some history, detach other records, and provide no coordination
with live runs or workers.

A database flag checked only by operator surfaces is also insufficient. Input
admission, run claims, automation claims, outbound queues, live voice, and
subagent creation are independent persisted seams. Each can race an archive
unless the session row participates in its admission transaction.

## Decision

Only `branch` sessions may be archived. `main` remains the always-active default
lane, while `subagent` sessions keep their existing disposable purge lifecycle.

`runtime.agent_sessions.archived_at` is the single durable archive authority.
There is no generic lifecycle enum and no archive flag in session metadata.

Archive and restore are daemon-owned durable runtime requests ordered by
session. Archive reuses the current thread's persistent run-claim fence and
exclusive coordinator lane before it changes session-owned state. Every seam
that admits new runtime work locks or rechecks the session row and requires
`archived_at IS NULL`.

Archiving preserves the session id, alias, current thread, transcript,
configuration, routes, automation definitions, execution bindings, and audit
history. It discards unapplied thread inputs, clears pending wake state,
terminalizes active automation occurrences, rejects new ingress, fails pending
session-owned outbound work, disconnects live voice, and stops direct child
subagents. Work already claimed by a true external adapter may settle because
Panda cannot safely undo an effect already in flight.

Restore reopens the same current thread without replaying discarded input.
Heartbeat and watch clocks are rebased from restore time. Recurring scheduled
tasks skip missed occurrences and compute their next future fire. A one-shot
task missed while archived becomes cancelled history. Voice sessions and child
subagents are not resurrected.

Conversation, A2A, email, gateway, and app bindings remain attached to the
archived session. Ingress fails as `session_archived`; it is never silently
rerouted to the main session.

## Consequences

- Archive is reversible without pretending that deletion is reversible.
- The session row becomes the common admission lock for all durable work.
- Runtime lifecycle knowledge stays behind one narrow archive/restore module
  instead of being duplicated across operator surfaces.
- Configuration may be edited while archived, but it cannot execute until
  restore.
- Pending work is intentionally not replayed after restore.
- Schema and worker changes must ship together; an old daemon must never run
  against a database containing archived sessions.
- Future reviews should not reintroduce general session deletion, metadata
  flags, automatic rerouting, or pause-and-replay semantics under the archive
  name unless this decision is explicitly reopened.
