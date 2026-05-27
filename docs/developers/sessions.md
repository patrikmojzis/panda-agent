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
Worker runs use `worker` sessions: constrained role lanes owned by the same
agent, with their own default execution environment and explicit allowlists.

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

Session briefing prompts are stored per session in `session_prompts` with the supported slug `session`. They are operator-managed through `panda session prompt show|set|read|clear`; the TUI does not edit them. The prompt is rendered by `SessionBriefingContext` after the shared agent profile and before the normal runtime contexts.

Rules:

- prompts are keyed by canonical `session_id`, so aliases resolve before reads/writes
- content must be non-empty when set; `read` prints raw content, while `show` prints metadata plus content
- prompts survive `/reset` because reset only swaps `current_thread_id`
- new branch sessions and worker/subagent sessions do not copy another session's prompt
- prompt-cache affinity includes the briefing slug, update time, and a content hash so edits force a fresh prompt lane

Session todo context is stored per session in `session_todos`. It is agent-managed through the `todo_update` tool, not a CLI/TUI editor. The tool replaces the full ordered list for the current runtime session; it never accepts a session id from the model. Items are structured `{status, content}` with `pending | in_progress | blocked | done`, and `items: []` clears the context.

Rules:

- todos are keyed by canonical `session_id` and survive `/reset` because reset only swaps `current_thread_id`
- todo state is structured JSONB, not markdown parsed from transcript history
- `Todo Context` is rendered through the default LLM context lane, including worker sessions by default
- prompt-cache affinity includes the todo hash/update version so `todo_update` is visible on the next model request
- rendering caps completed-heavy lists; done items are not auto-deleted
- no due dates, reminders, priorities, owners, global/project todos, or auto-spawn behavior in V1

Session runtime config is stored per session in `session_runtime_config`. It holds runtime knobs such as `model`, `thinking`, `thinking_configured`, `inference_projection`, and `pending_wake_at`. These values follow the session across `/reset`; thread rows no longer own those scalar runtime settings.

`/reset`:

- keeps the same `session_id`
- aborts the old thread if needed
- cancels old-thread background jobs
- drops old-thread pending inputs
- creates a fresh thread
- updates `session.current_thread_id`

That indirection is the whole point.

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

## Automation

Long-lived automation follows the session:

- heartbeat config lives in `session_heartbeats`
- watches store `session_id`
- scheduled tasks store `session_id`
- scheduled tasks may store `created_from_message_id` so the agent can query `session.messages` for origin context
- scheduled task schema and cross-table integrity checks live in `src/domain/scheduling/tasks/postgres-schema.ts`
- scheduled reminder context shows active scheduled tasks for the current session
- runners resolve `session.current_thread_id` at fire time; if they wait for old thread work to finish, they re-resolve before delivery

So:

- reset does not destroy automation
- reset does move automation onto the new thread automatically

## Boundaries

- pairing is global per `identity <-> agent`
- there are no per-session ACLs
- branch sessions are visible to all identities paired to that agent
- subagents are durable `agent_sessions.kind = "subagent"` sessions created by `spawn_subagent`
- there is no session-scoped memory table

## Code Map

- [src/domain/sessions](../../src/domain/sessions)
- [src/domain/sessions/cli.ts](../../src/domain/sessions/cli.ts) owns `panda session create`, `panda session prompt`, and shared session management commands
- [src/domain/sessions/current-thread.ts](../../src/domain/sessions/current-thread.ts) resolves and submits session-owned runtime work onto the session's current thread
- [src/app/runtime/daemon-threads.ts](../../src/app/runtime/daemon-threads.ts)
- [src/app/runtime/thread-definition.ts](../../src/app/runtime/thread-definition.ts)
- [src/domain/sessions/conversations/repo.ts](../../src/domain/sessions/conversations/repo.ts)
- [src/domain/sessions/routes/repo.ts](../../src/domain/sessions/routes/repo.ts)
