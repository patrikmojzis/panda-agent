# ADR 0001: Runtime Architecture Guardrails

- Status: Accepted
- Date: 2026-05-15

## Context

The architecture refactor moved Panda away from broad stores, stale barrels, duplicated connector loops, and public-surface parsing spread across handlers. The important outcome is not the file shuffle. The important outcome is a smaller set of seams that future work can trust.

This ADR records the decisions that should not be reopened casually during follow-up cleanup.

## Decision

### Session Owns Durable Delivery

`session` is the durable runtime lane. `thread` is the replaceable transcript and execution backing for that lane.

Anything that wakes Panda later must resolve `session.currentThreadId` at delivery time:

- gateway delivery
- scheduled tasks
- heartbeats
- watches
- email sync
- channel ingress
- app wakes
- worker handoff
- A2A bindings

Do not store a thread id early and reuse it after `/reset`. If a runner claims durable work before delivery, that runner owns completion, skip, or failure for the claim.

### Public Surfaces Admit Requests Before Parsing Bodies

Public and semi-public surfaces must reject ambiguous bodies before parsing them. Gateway event requests require `application/json`; OAuth token requests accept only `application/json` or `application/x-www-form-urlencoded`.


### Connector Workers Share Lifecycle Glue, Not Protocol Behavior

Connector workers are wake/drain driven. Shared lifecycle code belongs in `src/integrations/channels/worker-runtime.ts`:

- lease acquisition cleanup order
- outbound failure logging
- Postgres notification listener failure handling
- worker start/stop ordering

Telegram, WhatsApp, email, A2A, and TUI modules keep protocol-specific parsing, adapters, typing, media, pairing, and action dispatch local. Do not flatten those into a fake generic channel framework.

### Postgres Modules Split By Responsibility

Domain Postgres modules follow this split:

- `postgres-schema.ts`: DDL, migrations, integrity preflights
- `postgres-rows.ts`: row decoding for large public or shared tables
- `postgres-shared.ts`: table-name builders and shared constants
- `postgres.ts` or `repo.ts`: domain queries, mutations, and transactions

Generic query, transaction, relation, listen, and row-value helpers live in `src/lib`. Domain stores should not import those helpers from another domain's runtime module.

### Supported Entrypoints Are Explicit

Package exports and source barrels are intentionally small. `docs/developers/architecture.md` lists the supported entrypoints, and `tests/package-exports.test.ts` enforces that the package surface does not drift.

Deleting stale barrels is allowed. Reintroducing a barrel requires a real consumer-facing reason, not convenience.

### Tests Protect Behavior, Not Wiring

Architecture tests should pin observable guarantees:

- current-thread delivery after reset
- public body admission rules
- schema repair migrations
- connector lifecycle failure recovery
- package/export boundaries

Tests that only mirror private implementation shape should be deleted or rewritten at the module boundary.

## Consequences

- Follow-up refactors should shrink seams before adding abstractions.
- Import-law cleanup can proceed chunk by chunk; the report-only script exists so drift is visible before it becomes a hard gate.
- Schema changes need migration/backfill reasoning and focused Postgres tests.
- Channel changes should prove lifecycle/drain behavior without moving protocol details out of their connector modules.
