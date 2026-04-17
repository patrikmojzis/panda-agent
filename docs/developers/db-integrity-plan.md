# DB Integrity Plan

This pass hardens Panda’s session, thread, route, task, watch, and audit tables in one shot.

## Order

1. Preflight checks
2. Schema hardening
3. Write-path fixes
4. Tests
5. Live verification

## Scope

### Ownership

- `agent_sessions.agent_key -> agents.agent_key`
- `conversation_sessions.session_id -> agent_sessions.id`
- `session_routes.session_id -> agent_sessions.id`
- task/watch run rows must match the same parent `session_id` as their task/watch

Delete rule: `ON DELETE CASCADE`

### Provenance

- `agent_sessions.created_by_identity_id -> identities.id`
- existing task/watch provenance stays `SET NULL`

Delete rule: `ON DELETE SET NULL`

### Active Pointers

- `agent_sessions.current_thread_id` must resolve to a real thread in the same session
- session creation and reset must be transactional

### Audit Links

- `messages.run_id -> runs.id`
- `outbound_deliveries.thread_id -> threads.id`
- `scheduled_task_runs.thread_run_id -> runs.id`
- `scheduled_task_runs.resolved_thread_id -> threads.id`
- `watch_runs.resolved_thread_id -> threads.id`
- `watch_runs.emitted_event_id -> watch_events.id`
- `watch_events.resolved_thread_id -> threads.id`

Delete rule: nullable FK with `SET NULL`

## Implementation Notes

- `session_routes.identity_id` uses `NULL` for session-global routes.
- `session_routes` uses a surrogate primary key plus partial unique indexes for global vs identity-scoped uniqueness.
- Same-scope run/thread/session invariants are enforced in Postgres, not trusted to callers.
- Where plain FKs would lose the intended delete semantics, Panda carries scope in companion columns and enforces it with composite FKs plus row checks.
- No compatibility layer or dual-write path is needed for this codebase state.

## Acceptance Checklist

- [x] Add developer docs for rules and rollout
- [x] Link the docs from `docs/developers/README.md`
- [x] Replace `session_routes.identity_id = ''` with `NULL`
- [x] Add hard FKs for ownership and provenance edges
- [x] Harden audit links as nullable FKs
- [x] Enforce same-thread and same-session invariants in the database
- [x] Make session bootstrap and reset transactional in real write paths
- [x] Add integrity-focused tests for rejection, cascade, and nulling behavior
- [x] Run targeted verification on tasks, watches, routes, bindings, runtime rows, and reset flows
