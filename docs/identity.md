# Identity System

## What It Is

Panda now has a first-class `Identity` model.

An identity is the durable principal that owns threads.
It is not:

- a live agent instance
- an auth account system
- a connector-specific user record

Threads are still the persistent chat unit. The difference is that every thread now belongs to exactly one identity.

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

Right now, the app only creates and reads identities. There is no delete flow yet.

For custom identities:

- `id` is an opaque internal key
- `handle` is the human-facing unique name used by CLI and runtime selection

That means `id` and `handle` are not the same thing anymore.

### Identity Binding

An identity binding maps an external actor to a Panda identity.

An identity binding has:

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
`source` and `connectorKey` are trimmed and must be non-empty.
`externalActorId` stays opaque, but it must not be blank.

### Thread Ownership

Each thread has:

- `identityId`

That means:

- one identity can own many threads
- one thread belongs to exactly one identity
- a thread does not move between identities

This is deliberate. Letting threads bounce between identities sounds flexible, but it usually turns into data-confusion garbage.

## Default Local Identity

Panda seeds a default identity automatically:

- `id`: `local`
- `handle`: `local`
- `displayName`: `Local`

This keeps the existing CLI and TUI usable without forcing setup first.

If you do not pass an identity explicitly, Panda runs as `local`.

## Runtime Behavior

The chat runtime runs as exactly one identity at a time.

That identity is resolved at startup from:

- `--identity <handle>` if provided
- otherwise the default `local` identity

When the runtime creates a thread, it stamps:

- `thread.identityId`
- `context.identityId`
- `context.identityHandle`

When the runtime loads a thread, it verifies that the thread belongs to the currently selected identity. If not, it throws instead of crossing identity boundaries silently.

## CLI

### Chat And Thread Commands

These commands accept:

```bash
--identity <handle>
```

Supported places:

- `panda`
- `panda chat`
- `panda threads`
- `panda thread <threadId>`

Examples:

```bash
panda --identity local
panda chat --identity alice
panda threads --identity alice
panda thread 1234 --identity alice
```

### Identity Commands

Create an identity:

```bash
panda identity create <handle> [--name <displayName>]
```

List identities:

```bash
panda identity list
```

Examples:

```bash
panda identity create alice --name "Alice"
panda identity list
```

The CLI generates a new opaque `id` for each custom identity and keeps `handle` as the stable lookup key.

These commands require Postgres.

If Panda is running without `--db-url`, `PANDA_DATABASE_URL`, or `DATABASE_URL`, identity management commands now fail loudly instead of pretending a RAM-only write is durable.

## Storage

### Postgres Schema

The Postgres runtime store now includes:

- `thread_runtime_identities`
- `thread_runtime_identity_bindings`
- `thread_runtime_threads`
- `thread_runtime_messages`
- `thread_runtime_inputs`
- `thread_runtime_runs`

If a custom table prefix is used, the prefix changes accordingly.

### `identities` Table

Purpose:

- stores durable identity records

### `identity_bindings` Table

Purpose:

- maps an external actor to a Panda identity

Columns:

- `identity_id`
- `source`
- `connector_key`
- `external_actor_id`
- `metadata`

Unique lookup key:

- `source`
- `connector_key`
- `external_actor_id`

Current behavior:

- Postgres stores and resolves bindings
- runtime does not use bindings yet
- bindings do not select the active thread

### `threads` Table

`threads` now includes:

- `identity_id TEXT NOT NULL`

This is a foreign key to `identities.id`.

## Readonly SQL Views

The readonly `panda_threads` view now exposes:

- `identity_id`
- `identity_handle`

That makes identity-aware debugging and transcript inspection possible from the readonly SQL tool.

## Design Rules

These are the current rules the implementation assumes:

- identity is the owner of threads
- identity binding resolves an external actor to an identity
- thread is still the durable chat unit
- agent/provider/model selection stays on the thread runtime and thread records
- identity isolation is enforced in the runtime surface

## Telegram Compatibility

Telegram is not implemented here, but the model is shaped for it.

The intended direction is:

- connector event arrives
- connector binding resolves to an identity
- runtime runs as that identity
- thread selection or creation happens under that identity after a separate conversation-to-thread mapping step

What exists now:

- `identity_bindings` for external actor -> identity

What still does not exist:

- connector runtime integration
- conversation -> active thread mapping
- `/new` rotation semantics for connectors

When that later mapping lands, the safer name is probably `external_conversation_id`, not `external_channel_id`.

## What Is Not Implemented Yet

- identity switching inside the TUI
- identity update commands
- identity delete commands
- connector runtime integration
- conversation-to-thread mapping
- Telegram integration
- auth / permissions between human operators

## Files

Identity-specific implementation now lives in:

- [src/features/identity/types.ts](/Users/patrikmojzis/Projects/panda/src/features/identity/types.ts)
- [src/features/identity/store.ts](/Users/patrikmojzis/Projects/panda/src/features/identity/store.ts)
- [src/features/identity/postgres.ts](/Users/patrikmojzis/Projects/panda/src/features/identity/postgres.ts)
- [src/features/identity/runtime.ts](/Users/patrikmojzis/Projects/panda/src/features/identity/runtime.ts)
- [src/features/identity/cli.ts](/Users/patrikmojzis/Projects/panda/src/features/identity/cli.ts)

Thread/runtime integration still lives in:

- [src/features/thread-runtime/types.ts](/Users/patrikmojzis/Projects/panda/src/features/thread-runtime/types.ts)
- [src/features/thread-runtime/store.ts](/Users/patrikmojzis/Projects/panda/src/features/thread-runtime/store.ts)
- [src/features/thread-runtime/postgres.ts](/Users/patrikmojzis/Projects/panda/src/features/thread-runtime/postgres.ts)
- [src/features/thread-runtime/postgres-readonly.ts](/Users/patrikmojzis/Projects/panda/src/features/thread-runtime/postgres-readonly.ts)
- [src/features/tui/runtime.ts](/Users/patrikmojzis/Projects/panda/src/features/tui/runtime.ts)
- [src/cli.ts](/Users/patrikmojzis/Projects/panda/src/cli.ts)
