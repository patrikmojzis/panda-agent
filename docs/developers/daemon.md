# Panda Daemon

Panda's TUI is not supposed to be a pure frontend that talks only to the daemon or API.

It is a hybrid client:

- DB is the source for reading persisted stuff.
- daemon is the source for live orchestration stuff.

That split matters.

- Reading an existing session, thread, or transcript should work from Postgres.
- Creating a new main session, submitting input, aborting runs, and other live runtime mutations should go through the daemon.
- The TUI should not become daemon-dependent for plain persisted reads.

## What Counts As Persisted Read

These should come from the DB, not from a daemon round-trip:

- opening an existing session
- loading the current thread record
- loading transcript history
- loading stored runs
- rendering pinned thread settings like `thread.model` or `thread.thinking`

If the daemon is offline, these paths should still work.

## What Counts As Live Orchestration

These should go through the daemon:

- creating or resolving the main session thread
- submitting new input
- aborting a run
- waiting for a run to finish
- compacting a thread
- any operation that changes live execution state

If the daemon is offline, these paths should fail loudly.

## Exact Live Config

"Exact live config" means the effective config the runtime would use if Panda ran *right now*, after applying:

- provider and env defaults
- thread-level overrides
- any runtime-only definition overrides

Use daemon-resolved live config only when we truly need the exact answer.

Good uses:

- an explicit diagnostic like "what model will this run use right now?"
- a usage/debug screen that wants the real active model budget, not just stored thread pins
- admin/debug tooling comparing stored thread settings with effective runtime behavior

Bad uses:

- opening an existing session
- background transcript refresh
- normal transcript rendering
- other read-only UI paths that can safely use stored thread state plus local defaults

The default rule is simple:

- persisted reads should stay DB-driven
- orchestration should stay daemon-driven
- exact live config should be best-effort and opt-in, not a hidden dependency of normal UI reads
