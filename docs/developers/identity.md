# Identity System

## What It Is

Panda has a first-class `Identity` model.

An identity is the durable principal that owns threads.
It is not:

- a live agent instance
- an auth account system
- a connector-specific user record

Threads are still the persistent chat unit. The difference is that every thread belongs to exactly one identity.

## Current Model

### Identity

An identity has:

- `id`
- `handle`
- `displayName`
- `status`
- `metadata`
- `createdAt`
- `updatedAt`

Current status values:

- `active`
- `deleted`

For custom identities:

- `id` is an opaque internal key
- `handle` is the human-facing unique name used by CLI and runtime selection

### Identity Binding

An identity binding maps an external actor to a Panda identity.

A binding has:

- `id`
- `identityId`
- `source`
- `connectorKey`
- `externalActorId`
- `metadata`
- `createdAt`
- `updatedAt`

The binding key is:

- `source`
- `connectorKey`
- `externalActorId`

That means bindings are actor-scoped, not thread-scoped and not conversation-scoped.

### Thread Ownership

Each thread has:

- `identityId`

That means:

- one identity can own many threads
- one thread belongs to exactly one identity
- a thread does not move between identities

Letting threads bounce between identities sounds flexible and turns into data-confusion garbage fast.

## Default Local Identity

Panda seeds a default identity automatically:

- `id`: `local`
- `handle`: `local`
- `displayName`: `Local`

This keeps the existing CLI and TUI usable without forcing setup first.

## Runtime Invariants

The runtime runs as exactly one identity at a time.

That identity is resolved from:

- `--identity <handle>` if provided
- otherwise the default `local` identity

When the runtime creates a thread, it stamps:

- `thread.identityId`
- `context.identityId`
- `context.identityHandle`

When the runtime loads a thread, it verifies that the thread belongs to the selected identity. If not, it throws instead of crossing identity boundaries silently.

## Storage

The Postgres runtime store now includes:

- `thread_runtime_identities`
- `thread_runtime_identity_bindings`
- `thread_runtime_threads`
- `thread_runtime_messages`
- `thread_runtime_inputs`
- `thread_runtime_runs`

If a custom table prefix is used, the prefix changes accordingly.

`threads` now includes:

- `identity_id TEXT NOT NULL`

That column is a foreign key to `identities.id`.

## Readonly SQL Views

The readonly `panda_threads` view exposes:

- `identity_id`
- `identity_handle`

That makes identity-aware debugging and transcript inspection possible from the readonly SQL tool.

## Connector Direction

The intended connector flow is:

- connector event arrives
- connector binding resolves to an identity
- runtime runs as that identity
- thread selection or creation happens under that identity after a separate conversation-to-thread mapping step

What exists now:

- `identity_bindings` for external actor to identity

What does not exist yet:

- connector runtime integration
- conversation-to-thread mapping
- `/new` rotation semantics for connectors

When that mapping lands, the safer name is probably `external_conversation_id`, not `external_channel_id`.

## Not Implemented Yet

- identity switching inside the TUI
- identity update commands
- identity delete commands
- connector runtime integration
- conversation-to-thread mapping
- auth or permissions between human operators

## Code Map

Identity-specific implementation:

- [src/features/identity/types.ts](../../src/features/identity/types.ts)
- [src/features/identity/store.ts](../../src/features/identity/store.ts)
- [src/features/identity/postgres.ts](../../src/features/identity/postgres.ts)
- [src/features/identity/cli.ts](../../src/features/identity/cli.ts)

Thread and runtime integration:

- [src/features/thread-runtime/types.ts](../../src/features/thread-runtime/types.ts)
- [src/features/thread-runtime/store.ts](../../src/features/thread-runtime/store.ts)
- [src/features/thread-runtime/postgres.ts](../../src/features/thread-runtime/postgres.ts)
- [src/features/thread-runtime/postgres-readonly.ts](../../src/features/thread-runtime/postgres-readonly.ts)
- [src/features/tui/runtime.ts](../../src/features/tui/runtime.ts)
- [src/cli.ts](../../src/cli.ts)
