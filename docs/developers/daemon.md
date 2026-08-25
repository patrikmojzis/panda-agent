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
- loading bounded transcript-history pages
- loading the indexed latest-run state
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

## Run Abort Delivery

An abort targets the latest durable running run for a thread. The mutation sets
the run's abort fields and publishes a typed `run_abort_requested` Postgres
notification in the same transaction. Every coordinator receives that hint,
but only the coordinator holding the matching `run_id` controller acts on it.
This prevents a delayed notification from aborting a successor run.

Durable abort requests also record `request_id -> thread_id, run_id, reason` in
that transaction, including an intentional no-running-run result. Replaying the
request therefore returns its original target or no-op; it never drifts onto a
newer run that happened to start after a crash.

Postgres remains authoritative because `NOTIFY` delivery is not durable. The
owning coordinator reconciles its active run ids once after registration and
after listener reconnection. While the listener is unhealthy or an abort/run
confirmation is uncertain, a bounded batch reconciliation every five seconds
protects against a missed notification. There is deliberately no per-run abort
poll during healthy operation.

## Run Ownership And Scheduling

Thread execution is bounded by `PANDA_CORE_THREAD_RUN_CONCURRENCY` (default
`4`). The coordinator keeps a process-local FIFO scheduler with one lane per
thread. This is backpressure, not durability: inputs and pending wakes remain
in Postgres. Bounded scans run at startup and after `LISTEN` reconnects. If a
scan finds a full page, the scheduler refills at low water until a short page
proves the backlog is drained; a failed backlog refill gets one coalesced retry.
Interactive work has priority, but a bounded burst admits the oldest backlog
lane so sustained traffic cannot starve recovery. Exact per-thread settlement
checks retry until Postgres answers. Shutdown keeps retrying a cooperative
run's fenced settlement until it becomes terminal, loses ownership, or reaches
the scheduler's shared drain deadline. The lane is not reported idle while a
coalesced wake is still uncertain. Healthy steady state does not poll.

Starting work is a durable claim. A `runtime.runs` row records the exact daemon
lease source, key, and holder, and a partial unique index permits only one
`running` row per thread. The claim succeeds only while that renewable
`runtime.connector_leases` row is current and the thread is still the session's
current backing thread **and** durable runnable work exists. A stale `NOTIFY`
therefore cannot create an empty model run. `pending_wake_at` is an admission
edge, fenced by a monotonic `pending_wake_generation`. A claim or run boundary
clears only the generation visible to its PostgreSQL snapshot, so a newer wake
that commits while the statement waits on a row lock remains armed for the next
boundary. Admission atomically demotes the visible pending `wake` inputs to
`queue`, records their exact `admitted_run_id`, and applies the visible FIFO
set. Admission identity lets a run page through more than one input batch
without sweeping in
later queue-only work. An abort leaves only its admitted set durably dormant
across restart/reconnect scans. A new enqueue, queue promotion, or explicit wake
re-admits that set. Non-abort failure and orphan recovery re-arm only inputs
admitted by the failed run, atomically with terminalizing it, so retryable work
cannot be stranded or violate queue intent. Thread concurrency must never be
implemented by checking out a Postgres client for the lifetime of a model run.

Owner-fenced control and claim paths lock the daemon lease before session state;
a queued renewal must never sit between those locks. Live input mutations then
use one row-lock protocol: session (when routing is involved), thread, input,
then runtime config. Data-modifying CTEs carry explicit dependencies before
touching the config row; textual CTE order alone is not an execution-order
guarantee in PostgreSQL. Direct thread enqueue and explicit wake are
exact-current-thread operations. Session-targeted ingress is the only path that
follows a concurrent `/reset` to its replacement thread.

Every write owned by a run locks and rechecks that run together with its daemon
lease in the same SQL statement or transaction. This includes input
application, transcript messages, compaction checkpoints, runtime-state
updates, tool-job creation, shell-state persistence, run boundaries, and
terminal run status. An expired daemon may finish external work, but it cannot
commit stale results after another daemon takes ownership.

Every running `runtime.tool_jobs` row also snapshots that exact daemon owner.
Run-owned jobs derive it from the active claim; standalone command audits and
other background jobs must provide the current owner when they reserve the row.
Job updates fence against the snapshot directly, so a completed/deleted run is
not needed and `run_id IS NULL` is never an ownership bypass. Startup marks jobs
whose owner lease disappeared as `lost`.

Manual compaction and `/reset` reserve the scheduler's exclusive lane for the
thread. The database mutation also checks the current daemon lease while
holding the thread row lock and refuses to race a running claim. Do not add a
second TTL lease table or a fake maintenance run for this.

Shutdown closes ingress and producers first, aborts and drains scheduled work,
then cancels and durably settles cooperative background jobs while the daemon
lease is still held. A job still acquiring its external handle remains part of
that drain: shutdown signals its startup and, if a delayed handle still arrives,
cancels that handle before releasing ownership. Remote Bash start additionally
uses an idempotent cancel tombstone: if HTTP acceptance is ambiguous, the client
sends a bounded compensating cancel and the runner rejects/cancels a pending or
slightly later start with the same job id. Thread work gets
`PANDA_CORE_THREAD_RUN_DRAIN_TIMEOUT_MS` (default `30000`) before shutdown
continues, while background jobs get
`PANDA_CORE_BACKGROUND_JOB_DRAIN_TIMEOUT_MS` (default `5000`). Non-cooperative
work may still finish externally, but its late writes remain fenced after lease
release. The lease is released only after those grace periods, and Postgres
pools close last.

## Runtime Request Ordering

The daemon drains up to `PANDA_RUNTIME_REQUEST_CONCURRENCY` requests at once
(default `4`). This prevents slow compaction, voice, or media work from blocking
unrelated ingress. PostgreSQL still preserves FIFO for each causal producer
stream: a channel conversation, target session, or target thread.

Shutdown cancels active request handlers and waits up to
`PANDA_RUNTIME_REQUEST_DRAIN_TIMEOUT_MS` (default `30000`). Claim renewal stops
as soon as cancellation begins. Cooperative handlers release their claim
immediately; a stuck handler cannot hold shutdown forever, and its token-fenced
claim becomes replayable after lease expiry.

`runtime.runtime_requests.ordering_key` is a stable hash of that stream. Claim
SQL will not bypass an earlier pending/running request with the same key, and a
partial unique index permits only one running owner per key. Completion and
failure notify the drain because settling one row may make its successor
claimable. Do not prefix keys with request kind: a message and reaction in the
same conversation must remain ordered.

Request execution is at-least-once after lease expiry, so durable side effects
use the request UUID as their operation identity. Input uses it as `input_id`;
reset and session creation use stable resource ids; manual compaction uses it as
the checkpoint message id; channel control replies use it as the outbound
delivery idempotency key. Replays enqueue the same delivery again, which closes
both crash windows around effect and request settlement without duplicating the
human-visible reply. Token fencing protects request settlement, while these
stable ids protect effects if an expired owner finishes late.

Channel ingress supplies a separate hash of event kind, connector, provider
scope, and external event id as the request idempotency key, so transport
redelivery cannot create two durable requests or collide across conversations.
On shutdown the drain stops claiming, signals active handlers, and waits up to
`PANDA_RUNTIME_REQUEST_DRAIN_TIMEOUT_MS` (default `30000`). A handler that
unwinds releases—not completes—its token-fenced claim. A non-cooperative handler
stops renewing immediately; shutdown continues and the claim becomes replayable
only after its lease expires. Coordinator shutdown begins concurrently so a
request waiting on a thread lane cannot deadlock daemon shutdown. Stable
operation identities make a rare late handler/successor overlap converge on the
same durable effect.

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

## Transcript Reads

Postgres keeps complete append-only thread history, but runtime replay reads an
active snapshot: the latest compact checkpoint plus uncompacted messages after
its cutoff. This makes compaction reduce database rows decoded by every run, not
only tokens sent to the provider.

Operator history is separate. Chat and observe use bounded pages; chat fetches
older pages on upward scroll and incremental refresh seeks forward from the last
seen sequence. Do not restore a full-transcript read to make a UI caller easier.
