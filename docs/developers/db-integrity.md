# DB Integrity

Panda is Postgres-first. If a row is owned by another row, the database should know it.

## Rules

- Ownership rows use hard foreign keys with `ON DELETE CASCADE`.
  - If the child row has no meaning without the parent, delete it with the parent.
- Provenance rows use hard foreign keys with `ON DELETE SET NULL`.
  - If the parent explains who created something but does not own it, null the pointer and keep the record.
- Active pointers must be strict and same-scope.
  - `agent_sessions.current_thread_id` must point at a real thread for that same session.
  - Session bootstrap and reset must happen transactionally so the pointer is valid at commit time.
- Audit links are nullable foreign keys, not soft text.
  - If Panda keeps an internal pointer to a run, thread, or event for traceability, store it as a nullable FK.
- External/provider identifiers stay soft.
  - `external_actor_id`, `external_message_id`, `external_conversation_id`, `connector_key`, and channel-native ids are not relational ownership keys.

## Scope Enforcement

Some invariants are stricter than a plain single-column FK:

- `messages.run_id` must belong to `messages.thread_id`
- `bash_jobs.run_id` must belong to `bash_jobs.thread_id`
- resolved task/watch thread pointers must stay inside the same session
- scheduled task thread-run pointers must stay inside the resolved thread

When `SET NULL` semantics matter, Panda prefers a composite FK shape over triggers:

- carry the scope in a companion column
- add a same-row `CHECK` tying the companion column back to the owning row
- add a composite FK that nulls the pointer and companion together

That keeps delete semantics honest without leaving soft references behind.

Constraint triggers are the last resort, not the first tool.

## Nullable Natural Keys

If the logical key includes a nullable column, use partial unique indexes instead of sentinels.

`session_routes` is the pattern:

- session-global route: `identity_id IS NULL`
- identity-scoped route: `identity_id IS NOT NULL`
- enforce each case with its own partial unique index

Do not encode “missing” as `''`.

## Delete Semantics

- Agent delete should remove the whole session-owned subtree.
- Identity delete should remove identity-scoped route rows and null provenance where the model says “created by”.
- Thread delete should null audit-style thread pointers, not leave dead text behind.
- Event delete should null audit-style event pointers, not block cleanup forever.

## What Not To Do

- No soft references for internal ownership.
- No sentinel strings for nullable foreign keys.
- No app-only integrity for relationships the database can enforce.
- No dual-write compatibility shims for schema we have not shipped yet.
