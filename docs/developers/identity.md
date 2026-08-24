# Identity System

## What It Is

Panda still has a first-class `Identity` model.

But identity is no longer the durable owner of threads or sessions.

Identity is:

- the recognized human or external actor
- the access principal paired to agents
- speaker provenance for inbound messages

Identity is not:

- the session owner
- the thread owner
- the thing heartbeat, watches, or tasks hang off

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

That boundary stays actor-scoped.
It does not decide the session.

### Agent Pairing

Agent access now hangs off pairings:

- `identity_id`
- `agent_key`

That means:

- one identity can pair with many agents
- one agent can pair with many identities
- pairing is global per agent, not per session

### Prompt Directory

The paired-identities prompt reads one bounded, session-scoped directory from
`src/domain/agents/paired-identity-directory.ts`. The session selects the agent;
callers do not pass a second agent key that can drift out of sync.

The directory has a constant database budget of at most three queries: one for
active pairings, one for recent routes, and one for the visible binding window
plus its exact omitted count. An empty directory stops after the first query.
The prompt currently asks for at most 25 identities and four bindings per
identity. Route and binding data are delivery hints, not authority, so this read
model is deliberately uncached and does not hold a transaction snapshot across
prompt construction.

## No Built-In Identity

Panda does not seed a built-in identity anymore.

Operators create identities explicitly, for example:

- `id`: `alice`
- `handle`: `alice`
- `displayName`: `Alice`

## Runtime Invariants

The TUI/client still runs as one selected identity at a time.

That identity is resolved from:

- explicit `--identity <handle>`

Agent access is then checked through pairings:

- explicit `--agent` must be paired
- if no agent is given and there is exactly one pairing, Panda can infer it
- if there are zero or many pairings, Panda fails loudly

## Storage

Relevant tables now include:

- `runtime.identities`
- `runtime.identity_bindings`
- `runtime.agent_pairings`
- `runtime.agent_sessions`
- `runtime.threads`
- `runtime.messages`
- `runtime.inputs`

Threads no longer have `identity_id` as ownership.
Instead:

- threads carry `session_id`
- inputs and messages carry nullable speaker `identity_id`

That keeps provenance queryable without pretending the thread itself belongs to one person forever.

## Readonly SQL Views

The readonly views expose speaker identity columns on inputs and messages.

That matters now because one session can contain turns from many paired identities.

## Connector Direction

The intended connector flow is:

- connector event arrives
- actor binding resolves to an identity
- pairing gates access to the agent
- conversation binding resolves to a session
- session resolves to the current thread

So identity is still central.
It just is not the owner anymore.

## Not Implemented Yet

- richer identity update/delete flows
- per-session ACLs
- in-band channel UX for explicit session rebinding

Those omissions are deliberate.

## Code Map

- [src/domain/identity/types.ts](../../src/domain/identity/types.ts)
- [src/domain/identity/store.ts](../../src/domain/identity/store.ts)
- [src/domain/identity/postgres.ts](../../src/domain/identity/postgres.ts)
- [src/domain/agents/postgres.ts](../../src/domain/agents/postgres.ts)
- [src/domain/agents/paired-identity-directory.ts](../../src/domain/agents/paired-identity-directory.ts)
- [src/domain/sessions/postgres.ts](../../src/domain/sessions/postgres.ts)
- [src/app/runtime/daemon-threads.ts](../../src/app/runtime/daemon-threads.ts)
