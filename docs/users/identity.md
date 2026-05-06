# Identity

## What It Means For Operators

Panda keeps these separate on purpose:

- `agent` = persona
- `identity` = person
- `session` = durable agent lane
- `thread` = replaceable backing history

Identity is not the runtime owner anymore.
It is the participant and access principal.

## What Identity Does

Identity is responsible for:

- who is allowed to talk to an agent
- which external actor maps to which person
- speaker provenance in transcript history

Identity does not own:

- sessions
- threads
- heartbeat
- watches
- scheduled tasks

## Pairing

Access is granted through global `identity <-> agent` pairings.

That means:

- one identity can pair with many agents
- one agent can pair with many identities
- once paired, that identity can access all sessions for that agent

## Create An Identity

Fresh setup:

```bash
panda identity create alice
```

List identities:

```bash
panda identity list
```

Pair the identity to an agent:

```bash
panda agent pair luna alice
```

Remove the pairing:

```bash
panda agent unpair luna alice
```

List pairings for an agent:

```bash
panda agent pairings luna
```

## Common Flows

Fresh local setup:

```bash
panda agent create luna
panda identity create alice
panda agent pair luna alice
panda run
panda chat --identity alice --agent luna
```

Open chat when the identity is already paired:

```bash
panda chat --identity alice --agent luna
```

If the identity is paired to exactly one agent, Panda can infer the agent:

```bash
panda chat --identity alice
```

## Channels

Channel workers resolve people to identities.
They do not own sessions.

That means:

- pair Telegram or WhatsApp to an identity
- pair that identity to the right agent
- let `panda run` resolve session bindings and thread execution

## Hard Rules

- do not expect identity to own threads anymore
- do not look for `set-default-agent` or `switch-home-agent`; they are gone
- always start `panda run` before chat or channel workers
- treat identity as the participant and agent as the durable brain

If you are changing the identity model itself, use the developer doc:

- [Developer Identity Notes](../developers/identity.md)
