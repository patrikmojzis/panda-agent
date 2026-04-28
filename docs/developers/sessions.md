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
- `agent_sessions`
- `session_heartbeats`
- `conversation_sessions`
- `session_routes`
- `threads` with `session_id`

Every agent has exactly one `main` session.
Agents may also have `branch` sessions.

## Lifecycle

Agent bootstrap creates:

1. the agent row
2. the main session
3. the initial thread for that session

`/new`:

- creates a new `branch` session
- creates that session's first thread
- switches the TUI to that session

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

That explicit bind lives in `panda session bind-conversation`.

## Runtime Context

Durable context is session-first:

- `agentKey`
- `sessionId`
- `threadId`
- `cwd`
- `timezone`

Human identity is turn-level provenance, not durable thread ownership.

That means:

- active human runs use `currentInput.identityId`
- autonomous runs may have no active identity
- tools that need identity-scoped access must ask for it explicitly

## Automation

Long-lived automation follows the session:

- heartbeat config lives in `session_heartbeats`
- watches store `session_id`
- scheduled tasks store `session_id`
- runners resolve `session.current_thread_id` at fire time

So:

- reset does not destroy automation
- reset does move automation onto the new thread automatically

## Boundaries

- pairing is global per `identity <-> agent`
- there are no per-session ACLs
- branch sessions are visible to all identities paired to that agent
- subagents are not a session kind
- there is no session-scoped memory table

## Code Map

- [src/domain/sessions](../../src/domain/sessions)
- [src/app/runtime/daemon-threads.ts](../../src/app/runtime/daemon-threads.ts)
- [src/app/runtime/thread-definition.ts](../../src/app/runtime/thread-definition.ts)
- [src/domain/threads/conversations/repo.ts](../../src/domain/threads/conversations/repo.ts)
- [src/domain/threads/routes/repo.ts](../../src/domain/threads/routes/repo.ts)
