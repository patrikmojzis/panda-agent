# Identity

## What It Means For Operators

Panda keeps these separate on purpose:

- `agent` = persona
- `identity` = person
- `thread` = conversation

The durable owner is the identity.
Threads belong to identities. Agents do not own threads by themselves.

## Home Thread Behavior

Panda chat is built around a `home` thread for the `(identity, agent)` relationship.

That means:

- one identity can have multiple Pandas
- each Panda can have its own home thread
- the same Panda can be reached from TUI and channels

When you open chat:

- if the home thread does not exist yet, Panda creates it
- if it already exists on the requested agent, Panda opens it
- if it exists on another agent, Panda fails loudly

That last rule is deliberate. Silent switching is bullshit.

## Create An Identity

Fresh setup:

```bash
panda identity create local --agent luna
```

That creates the identity and sets the default agent for future home creation.

List identities:

```bash
panda identity list
```

## Change The Agent The Right Way

If you only want future home creation to prefer a different agent:

```bash
panda identity set-default-agent local luna
```

If you want to replace the current home thread's agent:

```bash
panda identity switch-home-agent local luna
```

Do not mix those up.

## Common Flows

Fresh local setup:

```bash
panda agent create luna
panda identity create local --agent luna
panda run
panda chat --identity local
```

Switch an existing identity to a new agent:

```bash
panda agent create luna
panda identity switch-home-agent local luna
panda chat --identity local
```

Keep the current home, change only the default:

```bash
panda identity set-default-agent local luna
```

## Channels

Channel workers resolve people to identities.
They do not choose the agent.

That means:

- pair Telegram or WhatsApp to an identity
- let `panda run` own thread execution
- do not expect channel workers to silently rewrite the home persona

## Hard Rules

- do not expect `panda agent create` to create a home thread
- do not use `set-default-agent` when you mean "replace my current home"
- always start `panda run` before chat or channel workers
- treat identity as the durable owner and the agent as the persona layered on top

If you are changing the identity model itself, use the developer doc:

- [Developer Identity Notes](../developers/identity.md)
