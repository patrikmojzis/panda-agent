# Agent Setup

This is the sane setup flow for a new Panda agent.

Short version:

- create the agent
- bind it to an identity
- start `panda run`
- open chat
- pair channels if you want Telegram or WhatsApp

## Before You Start

You need:

- a working Postgres connection
- an LLM API key for the provider you want to use

If Postgres is not set up yet, fix that first:

- [Postgres Setup](./postgres-setup.md)

## The Model

Panda keeps these separate on purpose:

- `agent` = persona
- `identity` = person
- `thread` = conversation

That means:

- `panda agent create luna` creates the persona only
- it does **not** create a home thread
- the home thread belongs to an identity, not to the agent by itself

## 1. Create The Agent

Example:

```bash
panda agent create luna
```

That creates:

- the agent record in Postgres
- the local skills directory for that agent

## 2. Create Or Choose An Identity

If this is a fresh setup, create an identity and give it a default agent:

```bash
panda identity create local --agent luna
```

If the identity already exists, set the default agent for future home creation:

```bash
panda identity set-default-agent local luna
```

Important:

- `set-default-agent` is config only
- it does **not** replace the current home thread

If the identity already has a home thread on another agent and you want to replace it, use:

```bash
panda identity switch-home-agent local luna
```

That is the explicit "replace the current home persona" command.

## 3. Start The Runtime

Panda has one real runtime now.
Start it first:

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

you forgot this step.

## 4. Open Chat

If the identity already points at the right home agent:

```bash
panda chat --identity local
```

If you want to assert the home agent at startup:

```bash
panda chat --identity local --agent luna
```

Current behavior:

- if no home thread exists yet, Panda creates one on `luna`
- if the home thread already exists on `luna`, Panda opens it
- if the home thread exists on another agent, Panda fails loudly

That failure is deliberate.
Silent switching was bullshit.

If you want to replace the existing home, do this first:

```bash
panda identity switch-home-agent local luna
```

Then open chat again.

## 5. Pair Telegram

Check the bot identity first:

```bash
panda telegram whoami
```

Pair a Telegram user to an identity:

```bash
panda telegram pair --identity local --actor 123456789
```

Run the Telegram worker:

```bash
panda telegram run
```

Telegram is just a worker now.
It does not choose an agent.
It sends work into `panda run`.

## 6. Pair WhatsApp

Check the connector state:

```bash
panda whatsapp whoami
```

Pair the connector:

```bash
panda whatsapp pair --phone 421900000000
```

Run the WhatsApp worker:

```bash
panda whatsapp run
```

Same rule as Telegram:

- WhatsApp does I/O
- `panda run` owns threads and inference

## Common Flows

### Fresh Local Setup

```bash
panda agent create luna
panda identity create local --agent luna
panda run
panda chat --identity local
```

### Switch An Existing Identity To A New Agent

```bash
panda agent create luna
panda identity switch-home-agent local luna
panda chat --identity local
```

### Keep The Current Home, Change Only The Default

```bash
panda identity set-default-agent local luna
```

Use that only when you want future home creation to prefer `luna` but do **not** want to replace the current home yet.

## Troubleshooting

### `Unknown agent luna`

You did not create the agent yet.

```bash
panda agent create luna
```

### `panda run (primary) is offline.`

Start the daemon:

```bash
panda run
```

### `Identity local already has a home thread on agent jozef`

That means you tried:

```bash
panda chat --identity local --agent luna
```

but `local` already has a home thread on `jozef`.

If you really want to replace it:

```bash
panda identity switch-home-agent local luna
```

### `set-default-agent` did not switch chat immediately

Good.
That command is not supposed to replace the current home thread.

Use:

```bash
panda identity switch-home-agent local luna
```

## Hard Rules

- do not expect `agent create` to create a home thread
- do not expect channel workers to choose the agent
- do not use `set-default-agent` when you mean "replace my current home"
- always start `panda run` before chat or channel workers
