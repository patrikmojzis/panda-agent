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

These commands require Postgres.

If Panda is running without `--db-url`, `PANDA_DATABASE_URL`, or `DATABASE_URL`, identity management commands now fail loudly instead of pretending a RAM-only write is durable.

## Storage

### In-Memory Store

The in-memory runtime store only exposes the built-in `local` identity.

It does not create or persist custom identities in RAM anymore.

That keeps local chat working without a database, but avoids the fake-persistent identity path.

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

- future connector mapping layer

Current status:

- schema exists
- unique binding key exists
- runtime does not use it yet

This is intentional. We wanted the identity model in place before wiring Telegram or any other connector-specific behavior.

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
- thread is still the durable chat unit
- agent/provider/model selection stays on the thread runtime and thread records
- identity isolation is enforced in the runtime surface
- connector bindings belong above threads, not inside the agent loop

## Telegram Compatibility

Telegram is not implemented here, but the model is shaped for it.

The intended direction is:

- connector event arrives
- connector binding resolves to an identity
- runtime runs as that identity
- thread selection or creation happens under that identity

That is why `identity_bindings` already exists even though no connector uses it yet.

## What Is Not Implemented Yet

- identity switching inside the TUI
- identity update commands
- identity delete commands
- binding commands
- Telegram integration
- auth / permissions between human operators

## Files

Identity-specific implementation now lives in:

- [src/features/identity/types.ts](/Users/patrikmojzis/Projects/panda/src/features/identity/types.ts)
- [src/features/identity/store.ts](/Users/patrikmojzis/Projects/panda/src/features/identity/store.ts)
- [src/features/identity/in-memory.ts](/Users/patrikmojzis/Projects/panda/src/features/identity/in-memory.ts)
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
