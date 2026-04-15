# Panda Chat Vision

## One Brain, Many Windows, Optional Branches

Panda should feel like one stable brain.

That brain is the agent.
The durable lane users and channels attach to is the session.

So the shape is:

- one agent
- one main session by default
- many windows into that same session
- optional branch sessions when someone explicitly splits off

## Core Model

The stable user-facing unit is:

- `session`

Not:

- `thread`, because `/reset` replaces it
- `identity`, because identity participates but does not own runtime state
- `agent`, because the agent is broader than one execution lane

The base relationship is:

- `identity <-> agent` pairing for access
- `session` for execution and durable routing

## Main Session

Every agent has exactly one `main` session.

That is the default place where:

- TUI opens
- first inbound DM conversations land
- heartbeat runs
- default scheduled work runs

The old phrase "home thread" is dead.
The replacement is:

- main session with a current thread

## Windows

Windows are just surfaces attached to the same session.

Examples:

- TUI
- Telegram DM
- WhatsApp DM

By default they should feel like the same Panda, not separate brains.

## Branches

Branches are explicit side sessions on the same agent.

They are useful when someone wants to:

- deep-dive
- experiment
- fork off a temporary topic

They are not private by default.
If someone wants a private mental space, they should use a separate agent.

## Command Semantics

### TUI

The TUI now speaks session-first:

- `/new` creates a fresh branch session
- `/reset` replaces the current session thread
- `/sessions` opens the session picker
- `/resume <session-id>` switches to another session

### Channels

Channels should not invent hidden session-management UX in-band.

For v1:

- new direct conversations bind to a session
- explicit conversation-to-session rebinding is an operator/admin action
- do not pretend Telegram or WhatsApp expose the full session model to end users yet

## Routing

Inbound flow is:

1. resolve external actor to `identity_id`
2. verify pairing to the target agent
3. resolve conversation binding to `session_id`
4. resolve `session.current_thread_id`
5. enqueue the input on that thread

That is the durable chain.

## Scheduling

Heartbeats, watches, and scheduled tasks belong to sessions.

That means:

- reset does not destroy them
- they re-resolve the session's current thread when they fire

That is why session indirection exists.

## What To Avoid

- thinking in identity-owned home threads
- binding channels directly to raw thread ids
- treating every channel as a separate brain
- sneaking private ACLs into branch sessions
