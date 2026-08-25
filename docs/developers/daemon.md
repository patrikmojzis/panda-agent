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

A database failure before the durable run claim exists moves the same thread
lane into an equal-jitter exponential retry, from 100ms to a 5s ceiling. The
delay holds neither a scheduler run slot nor a database client; later wake hints
coalesce into that lane, and retry continues at the capped rate until admission
succeeds or the coordinator stops. The lane retains one run UUID across those
attempts, so a claim that committed before its response was lost is recovered
idempotently without consuming another wake or inserting another run. An empty
claim result is reconciled by a fresh exact-ID read, covering a retry whose
older statement snapshot waited behind the original commit. During shutdown,
any already-ambiguous ID replays the same claim protocol within the shared drain
deadline. That replay waits for a still-finishing backend transaction instead
of treating an early read miss as rollback; the recovered owned run is failed
before execution and its consumed wake is atomically restored, including
wake-only turns with no input row. Concurrent shutdown callers share that one
drain. This
retry applies only around claim admission. Once the committed run is returned,
its fenced settlement owns the outcome and the scheduler never replays model or
tool side effects as an admission retry.

Starting work is a durable claim. A `runtime.runs` row records the exact daemon
lease source, key, and holder, and a partial unique index permits only one
`running` row per thread. The claim succeeds only while that renewable
`runtime.connector_leases` row is current and the thread is still the session's
current backing thread **and** durable runnable work exists. A stale `NOTIFY`
therefore cannot create an empty model run. `pending_wake_at` is an admission
edge, fenced by a monotonic `pending_wake_generation`. A claim or run boundary
clears only the generation visible to its PostgreSQL snapshot, so a newer wake
that commits while the statement waits on a row lock remains armed for the next
boundary. The run snapshots the greatest visible pending `input_order` into
`runs.admitted_through_input_order`, then applies only that immutable FIFO
prefix in bounded pages. This is one scalar write no matter how large the
backlog is, and later queue-only inputs remain outside the run. Abort leaves the
prefix dormant across restart/reconnect scans until a genuinely new wake
advances the cutoff. Non-abort failure and orphan recovery re-arm the session's
wake latch when unapplied work remains inside the failed run's cutoff. Input
rows are never rewritten merely to express scheduling state. Thread concurrency
must never be implemented by checking out a Postgres client for the lifetime of
a model run.

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
Reset reservation and active-run cancellation are one ordered scheduler
operation: reserve the lane, commit a request-keyed blocking abort receipt,
then cancel the active controller. The receipt makes the old thread ineligible
for every later claim, including reconnect scans, until reset atomically swaps
the session pointer. If cancellation or replacement fails, the request remains
retryable and resumes from that receipt; it never re-arms old-thread work.
Splitting abort from reservation, or treating local cancellation as the durable
boundary, reopens the race.

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
as soon as cancellation begins. Each handler also tracks the last
database-confirmed lease deadline with a monotonic timer; a failed renewal can
therefore never let side effects continue past known ownership. Cooperative
handlers release their claim immediately; a stuck handler cannot hold shutdown
forever, and its token-fenced claim becomes replayable after lease expiry.

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

Every claim increments `runtime_requests.execution_attempts`. A first-attempt
database error after a replay-safe mutation is treated as an ambiguous outcome,
not a terminal failure. The next claim probes the operation receipt before any
mutable identity, pairing, profile, current-thread, or environment lookup. This
is deliberate: authorization is checked when the request is accepted, while a
retry must reconcile what that accepted request already committed.

Channel ingress supplies a separate hash of event kind, connector, provider
scope, and external event id as the request idempotency key, so transport
redelivery cannot create two durable requests or collide across conversations.
Abort, no-op compaction, session creation/main resolution, and runtime-config
effects have explicit receipts foreign-keyed to their runtime request. Config
receipts prevent replay from reapplying an old patch; creation receipts preserve
the accepted identity/agent target even if pairings later change. Receipt rows
disappear when their request leaves the idempotency window. Direct internal
operations do not manufacture permanent receipt ids. Runtime config is ordered
by request acceptance independently for model, thinking, and inference
projection, so an older partial patch can fill its own field without erasing a
newer value in another field.

Transport media remains in `.idempotent` only while its accepted request can
retry. Relocation first transfers ownership to the agent media tree and leaves
a small descriptor-only replay receipt. Unconsumed bytes are removed only after
the request is durably completed or failed. One daemon-owned periodic janitor
handles the cross-connector crash window by resolving a bounded batch of receipt
owners in one query; terminal owners release staging promptly, while missing or
pre-owner receipts require the conservative 31-day cutoff plus a final manifest
recheck. It never performs DB probes on the ingress write path. Relocated agent
bytes are immutable here because a prior transcript may reference the same
redelivered media. Per-account connector janitors are forbidden because all
connectors share the same media tree.

Subagent creation is a small durable saga: session/thread creation is its
anchor, environment attachment and A2A pairing are idempotent steps, and the
stable handoff input is the completion marker. Once that handoff exists, replay
does not repeat earlier effects. Environment attachment is deliberately first;
if its accepted snapshot becomes deterministically invalid before an attachment
exists, the saga deletes the unobservable anchor instead of retrying forever.
`/reset` and channel control replies use the same rule: probe the committed
reset, abort, and delivery receipts before mutable authorization, then converge
on the same thread and outbound idempotency key.

On shutdown the drain stops claiming, signals active handlers, and waits up to
its configured deadline. Coordinator shutdown begins concurrently so a request
waiting on a thread lane cannot deadlock daemon shutdown. Every remaining
service join is capped by `PANDA_DAEMON_SERVICE_STOP_TIMEOUT_MS` (default
`5000`), so a broken listener or HTTP server cannot wedge process teardown.
After model work settles, runtime closure also flushes provider session-resource
caches; cached Codex WebSockets must not keep a stopped process alive until
their idle timeout.

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
