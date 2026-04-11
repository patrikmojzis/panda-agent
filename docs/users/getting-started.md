# Getting Started

This is the shortest sane path to a working Panda setup.

## Before You Start

You need:

- a working Postgres connection
- an LLM API key for the provider you want to use

If Postgres is not ready yet, fix that first:

- [Postgres](./postgres.md)

If you plan to run bash in Docker or another isolated runner, read this too:

- [Remote Bash](./remote-bash.md)

## The Model

Panda keeps these separate on purpose:

- `agent` = persona
- `identity` = person
- `thread` = conversation

That means `panda agent create luna` creates a persona, not a home thread.

## Fresh Local Setup

```bash
panda agent create luna
panda identity create local --agent luna
panda run
panda chat --identity local
```

That is the default happy path:

- create the agent
- create the identity and set its default agent
- start the runtime
- open chat on that identity

## If The Identity Already Exists

If the identity exists and you only want future home creation to prefer a new agent:

```bash
panda identity set-default-agent local luna
```

If the identity already has a home thread and you want to replace that home:

```bash
panda identity switch-home-agent local luna
```

That distinction matters. `set-default-agent` is config only. It does not replace the current home thread.

## Start The Runtime First

```bash
panda run
```

Or with an explicit database URL:

```bash
panda run --db-url postgres://panda_app:app_pw@localhost:5432/panda
```

If chat says:

```text
panda run (primary) is offline.
```

you skipped this step.

## Open Chat

Open the current home thread:

```bash
panda chat --identity local
```

Assert the home agent at startup:

```bash
panda chat --identity local --agent luna
```

Current behavior:

- if no home thread exists yet, Panda creates one on the requested agent
- if the home thread already exists on that agent, Panda opens it
- if the home thread exists on another agent, Panda fails loudly

That failure is deliberate. Silent switching is how you get confusing garbage.

## Pair Channels If You Need Them

Telegram:

```bash
panda telegram whoami
panda telegram pair --identity local --actor 123456789
panda telegram run
```

WhatsApp:

```bash
panda whatsapp whoami
panda whatsapp pair --phone 421900000000
panda whatsapp run
```

Channel workers do I/O. `panda run` still owns threads and inference.

## Read Next

- [Identity](./identity.md) for home-thread behavior and operator flows
- [Heartbeat](./heartbeat.md) for periodic wake behavior
- [Remote Bash](./remote-bash.md) for Docker runner setups
