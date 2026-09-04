# Sessions

Sessions are now Panda's durable runtime anchor.

That means:

- agents own sessions
- external conversations bind to sessions
- tasks, watches, and heartbeat target sessions
- threads are replaceable backing history inside a session

If you still think "home thread", stop. The correct phrase is:

- main session with a current thread

## Core Model

The current shape is:

- `agents`
- `agent_pairings`
- `agent_sessions` (`alias` + `display_name` are nullable operator labels)
- `session_heartbeats`
- `conversation_sessions`
- `session_routes`
- `session_runtime_config` for session-scoped runtime knobs and pending wake state
- `threads` with `session_id`

Every agent has exactly one `main` session.
Agents may also have `branch` sessions.
Subagent runs use `subagent` sessions: constrained durable child lanes owned by the same
agent. They are created by `panda subagent spawn <task> --profile <slug>` and may use explicit allowlists.

## Lifecycle

Agent bootstrap creates:

1. the agent row
2. the main session
3. the initial thread for that session

`/new`:

- creates a new `branch` session
- creates that session's first thread
- switches the TUI to that session

`panda session create <agentKey> [sessionRef]`:

- creates only `branch` sessions
- validates the agent exists first
- creates the session row and first thread in one `createSessionWithInitialThread` transaction
- uses a UUID session id when no ref is supplied
- uses `${agentKey}:${sessionRef}` when a ref is supplied, after lowercase normalization and conservative ref validation
- can set nullable `alias` and `display_name` labels via `--alias`/`--display-name` without changing the canonical id
- relies on the existing `session_heartbeats` row behavior, so branch heartbeat starts disabled

Readable refs are not aliases. The readable string is still the stored `agent_sessions.id`, and existing raw session-id commands consume it directly.

Aliases are a separate operator affordance:

- one nullable `alias` column per session
- unique per `(agent_key, alias)` when non-null
- normalized lowercase with `[a-z0-9][a-z0-9_-]*`
- resolved exact canonical id first, then alias scoped by agent key
- never stored into conversation bindings, routes, prompts, outbound messages, or A2A payloads by default

`panda session label` updates or clears `alias`/`display_name`; TUI alias editing is intentionally out of scope.

Editable runtime prompts are stored per session in `session_prompts` with slugs `brief`, `memory`, and `heartbeat`. The CLI `panda session prompt show|set|read|clear` edits `brief` by default and accepts `--slug brief|memory|heartbeat`; Control exposes the same bundle in the session Prompts tab. Agents use `panda session prompt read|set|transform` to read, set, or transform the current session's prompt bundle. `brief` and `memory` render through `SessionPromptsContext`; `heartbeat` is read only when building heartbeat wake guidance.

Rules:

- prompts are keyed by canonical `session_id`, so aliases resolve before reads/writes
- content must be non-empty when set; `read` prints raw content, while `show` prints metadata plus content
- prompts survive `/reset` because reset only swaps `current_thread_id`
- new main sessions get the default fresh-start `brief`
- new branch sessions copy `brief` and `heartbeat` from the main/source session; `memory` starts empty
- subagent sessions do not inherit the session prompt bundle
- prompt-cache affinity includes rendered session prompts (`brief` and `memory`), while `heartbeat` affects only heartbeat wake guidance

Session todo context is stored per session in `session_todos`. It is agent-managed through `panda todo add`, `panda todo done`, `panda todo block`, and `panda todo clear`, not a TUI editor. The commands mutate the current runtime session and never accept a session id from the model. Items are structured `{status, content}` with `pending | in_progress | blocked | done`.

Rules:

- todos are keyed by canonical `session_id` and survive `/reset` because reset only swaps `current_thread_id`
- todo state is structured JSONB, not markdown parsed from transcript history
- `Todo Context` is rendered through the default LLM context lane, including subagent sessions by default
- prompt-cache affinity includes the todo hash/update version so command changes are visible on the next model request
- rendering caps completed-heavy lists; done items are not auto-deleted
- no due dates, reminders, priorities, owners, global/project todos, or auto-spawn behavior in V1

Session runtime config is stored per session in `session_runtime_config`. Runtime knobs such as `model`, `thinking`, `thinking_configured`, and `inference_projection` follow the session across `/reset`; thread rows no longer own those scalar settings. Request-driven patches carry per-field acceptance clocks and operation ids. That prevents an older reset/update from overwriting a newer value while still allowing disjoint partial patches to merge. `pending_wake_at` and `pending_wake_generation` share the table but are owned exclusively by runtime wake/admission operations, not by the generic config update API.
`pending_wake_at` is the sole durable scheduler latch, not a second work queue. Every wake advances `pending_wake_generation`; a consumer compare-and-clears only the generation visible to its PostgreSQL snapshot. A concurrent newer wake therefore survives a row-lock wait even though the statement still uses its older snapshot. A run snapshots the largest visible pending `input_order` into `runs.admitted_through_input_order` and may apply that immutable FIFO prefix in bounded pages. Later queue-only inputs remain beyond the cutoff. Abort leaves the prefix dormant until a genuinely new wake advances the cutoff; non-abort failure and orphan recovery re-arm the session latch when unapplied work remains inside the cutoff. `inputs.delivery_mode` records submission policy and history; it is not another scheduling signal.

`/reset`:

- keeps the same `session_id`
- aborts the old thread if needed
- cancels old-thread background jobs
- drops old-thread pending inputs
- clears the old thread's pending wake while holding the session lock
- creates a fresh thread
- records the replaced thread in `threads.replaces_thread_id`
- updates `session.current_thread_id`

That lineage lets a replayed reset return its original result even after a newer
reset has superseded it. The session indirection is the whole point.

Before replacing the pointer, reset reserves the old thread's scheduler lane
and records a request-keyed abort receipt while setting
`threads.run_claims_blocked_at`. The thread-owned fence survives receipt pruning
and blocks every new run claim before local cancellation begins. Session ingress
that encounters the retiring current thread is deferred until the pointer
advances, so accepted work is never inserted into a thread that reset is about to
discard. A crash after the fence leaves the old thread dormant, and the durable
request retry completes the same replacement instead of replaying old input.
Upgrade refuses the one unsafe legacy state: an interrupted reset receipt whose
old thread is still current.

### Archive and restore

`panda session archive <session-ref>` and `panda session restore <session-ref>`
are daemon-owned lifecycle operations. Only `branch` sessions support them.
The main session must remain active, and subagent retirement continues to use
the bounded purge lifecycle.

`agent_sessions.archived_at` is the durable authority. Archive first installs
the same persistent run-claim fence used by reset and takes the current
thread's exclusive coordinator lane. The database transition then:

- discards unapplied input and clears the session wake latch
- cancels pending, claimed, or running scheduled occurrences
- fails claimed/running watch runs and clears watch/heartbeat claims
- fails pending session-owned deliveries, channel actions, and voice turns
- queues Discord voice leave controls and expires incomplete MCP OAuth attempts
- stops direct child subagent lanes without deleting their history

Every persisted admission seam also locks or rechecks the session row. This is
what closes races with archive; filtering archived rows in the CLI would not.
Ingress receives `SessionArchivedError` and is never rerouted to the main
session.

Restore keeps the same session and current thread. It does not replay discarded
input or failed outbound work. Heartbeat and watch clocks restart from restore
time, recurring tasks choose their next future occurrence, and one-shot tasks
missed during archive become cancelled history. Voice and child subagents stay
stopped. Session labels, prompts, todos, runtime configuration, routes,
conversation/A2A bindings, automation definitions, execution targets,
transcript, and audit history remain editable and preserved throughout.

The exact boundary is recorded in
[ADR 0002](./adr/0002-session-archive-lifecycle.md).

## Agent-requested compaction

`panda session compact current [--instructions <text>]` is the `session.compact`
CLI Tool in the `core` group. Its authenticated run scope selects the session;
the input accepts only optional instructions, capped at 4096 characters.

The command durably records one pending request per session and returns
`{status: "requested", applyAt: "next_model_boundary"}` immediately. Repeated
requests while one is pending retain the first request and its instructions.
The coordinator handles it after tool results are persisted, before the next
model call, using the owning run's compaction fence. It then reloads replay and
continues the task. It never waits for its own exclusive scheduler lane.

The runtime records a `compacted`, `skipped`, or `failed` outcome in the transcript.
Compacted outcomes include estimated transcript tokens before and after. Full
history remains append-only. A checkpoint receipt makes an interrupted commit
replayable; outcome insertion and pending-request removal are atomic. Non-abort
run failure and orphan recovery rearm the normal session wake latch when a
request remains. Reset preserves the request; the next run resolves the current
thread. An explicit abort does not restart work. Archiving clears the request.

Agent-requested compaction can summarize part of a long turn, retaining the two
latest complete assistant exchanges and carrying the latest task request,
including image content, verbatim into the checkpoint. Incomplete tool batches
are not split. Checkpoint replay context retains input identity and reply-route
provenance; repeated compaction retrieves the original task by its message id.
A summary that does not reduce estimated context is skipped.
Automatic compaction and operator compaction retain their existing six-user-turn
policy.

## Routing

External conversation binding is session-first:

- external actor resolves to `identity_id`
- pairing decides whether that identity may reach the agent
- conversation binding resolves `session_id`
- the runtime resolves `session.current_thread_id`

For a new external conversation:

- if the paired identity has exactly one paired agent, Panda can auto-bind to that agent's main session
- if the identity has multiple paired agents, an operator must bind the conversation explicitly

That explicit bind lives in `panda session bind-conversation`; aliases must be resolved to canonical session ids before writing `conversation_sessions`.
Channel UIs should not invent hidden session-management UX in-band. New direct
conversations bind to a session; explicit rebinding is an operator/admin action.

Session-owned delivery must resolve the current thread at the last responsible
moment. Do not read `session.currentThreadId` directly from channel workers,
scheduled-task runners, watch runners, gateway delivery, app wake actions, or
A2A inbound handling. Use `resolveCurrentSessionThread` when the caller must
record the resolved thread id, `submitCurrentSessionInput` when the caller only
needs to wake the current backing thread through the live daemon, and
`enqueueCurrentSessionInput` when already-reserved work must persist directly
through the thread store. That keeps `/reset` attached to the durable session
instead of the stale backing thread.
If a delivery path performs a pre-submit check such as “is this thread busy,”
re-resolve after the check and apply the check to the final target before
submitting. Do not check one backing thread and then submit to another.

## Runtime Context

Runtime context is assembled session-first, but not every field is durable session state. The durable anchor is `sessionId`; each wake resolves the current `threadId` from `session.current_thread_id` and reads session-scoped runtime config from `session_runtime_config`.

The default runtime context passed to tools/model includes:

- `agentKey`
- `sessionId`
- resolved `threadId`
- resolved `cwd`
- turn-level `currentInput` when present

Model, thinking, inference projection, and pending wake state are session runtime config, not thread fields. Timezone comes from the DateTime context/host clock, not a durable session column.

Human identity is turn-level provenance, not durable thread ownership.

That means:

- active human runs use `currentInput.identityId`
- tools can use `currentInput.messageId` as a scoped transcript retrieval anchor
- autonomous runs may have no active identity
- tools that need identity-scoped access must ask for it explicitly

Route context is separate from provenance. `currentInput` remains the latest
input, even for internal continuations such as background-tool, runtime
idle-reroll, or scheduled-task wakes. The runtime also exposes
`currentRouteInput` as the latest input with `metadata.route` so no-`to`
outbound replies can recover the previous routed
channel for internal or no-input continuations; identity-scoped route memory
is preferred, and generic/null route memory is only a last resort.

## Automation

Long-lived automation follows the session:

- heartbeat config lives in `session_heartbeats`
- watches store `session_id`
- scheduled tasks store `session_id`
- scheduled tasks may store `created_from_message_id` so the agent can query `session.messages` for origin context
- scheduled task schema and cross-table integrity checks live in `src/domain/scheduling/tasks/postgres-schema.ts`
- scheduled reminder context shows active scheduled tasks for the current session
- `scheduled_tasks` is only the mutable schedule definition; each `(task_id, scheduled_for)` fire becomes exactly one durable `scheduled_task_runs` occurrence before execution
- due definitions are advanced and materialized in one atomic batch, while runners claim occurrences with renewable, token-fenced leases
- each definition may have at most one pending, claimed, or running occurrence; recurring catch-up is sequential per task while unrelated tasks still run concurrently
- claimed occurrences are supervised with bounded concurrency, so one long thread run cannot stop unrelated schedules from being claimed or materialized
- scheduled input submission locks the session, resolves `session.current_thread_id`, and inserts a stable input UUID in one database statement; retries therefore find the same input without racing `/reset`
- `runtime.inputs.applied_run_id` records the run that consumed an input, and the scheduled occurrence links that exact input and run
- runners wait for that input's run receipt; they never infer causality by loading or comparing thread history
- cancellation removes pending occurrences and future fires; an occurrence already claimed by a runner remains owned work and must settle with its claim token
- completed and cancelled definitions are immutable history; rearming means creating a new task, never recycling an old occurrence key
- scheduled-task list/history reads are capped at 100 rows; Control uses bounded per-task/session index probes, and execution never reads terminal occurrence history

So:

- reset does not destroy automation
- work not yet submitted resolves onto the new current thread automatically
- a submitted input keeps its durable outcome, including a discarded tombstone, so crash recovery cannot duplicate it on another thread

## Boundaries

- pairing is global per `identity <-> agent`
- there are no per-session ACLs
- branch sessions are visible to all identities paired to that agent
- subagents are durable `agent_sessions.kind = "subagent"` sessions created by `panda subagent spawn`
- there is no session-scoped memory table

## Code Map

- [src/domain/sessions](../../src/domain/sessions)
- [src/domain/sessions/cli.ts](../../src/domain/sessions/cli.ts) owns `panda session create`, `panda session prompt`, and shared session management commands
- [src/domain/sessions/current-thread.ts](../../src/domain/sessions/current-thread.ts) resolves and submits session-owned runtime work onto the session's current thread
- [src/domain/sessions/archive.ts](../../src/domain/sessions/archive.ts) owns the atomic durable archive/restore transition
- [src/app/runtime/session-archive-service.ts](../../src/app/runtime/session-archive-service.ts) coordinates run fences, background jobs, and direct child subagents
- [src/app/runtime/daemon-threads.ts](../../src/app/runtime/daemon-threads.ts)
- [src/app/runtime/thread-definition.ts](../../src/app/runtime/thread-definition.ts)
- [src/domain/sessions/conversations/repo.ts](../../src/domain/sessions/conversations/repo.ts)
- [src/domain/sessions/routes/repo.ts](../../src/domain/sessions/routes/repo.ts)
