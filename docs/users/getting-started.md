# Getting Started

This is the shortest sane path from zero to a working Panda setup.

If you are new, follow the steps in order.
Do not freestyle the pairing model. That is how you end up confused at 2am.

## Before You Start

You need:

- a working Postgres connection
- an LLM API key for the provider you want to use
- Docker only if you want the built-in browser tool

Useful background docs:

- [Postgres](./postgres.md)
- [Browser](./browser.md)
- [Remote Bash](./remote-bash.md)
- [Sessions](./sessions.md)

## The Model

Panda keeps these separate on purpose:

- `agent` = persona
- `identity` = person
- `session` = durable lane on that agent
- `thread` = replaceable backing history for a session

What that means in practice:

- `panda agent create luna` creates the agent and its `main` session
- `panda identity create alice` creates the person
- `panda agent pair luna alice` grants that person access to that agent
- chat opens sessions, not identity-owned home threads

The old `set-default-agent` and `switch-home-agent` flow is gone.
Good riddance.

## The Happy Path

Do this:

```bash
panda agent create luna
panda identity create alice
panda agent pair luna alice
panda run
panda chat --identity alice --agent luna
```

That is the normal local setup:

1. create the agent
2. create the identity
3. pair the identity to the agent
4. start the runtime
5. open chat on that agent's main session

## Step 1: Create An Agent

Create an agent:

```bash
panda agent create luna
```

Optional display name:

```bash
panda agent create luna --name "Luna"
```

What this does:

- creates the agent row
- seeds its default prompts
- creates exactly one `main` session
- creates the initial thread backing that session

Useful checks:

```bash
panda agent list
panda session list luna
```

## Step 2: Create An Identity

Create an identity:

```bash
panda identity create alice
```

Optional display name:

```bash
panda identity create alice --name "Alice"
```

Useful check:

```bash
panda identity list
```

## Step 3: Pair The Identity To The Agent

Grant access:

```bash
panda agent pair luna alice
```

Check pairings:

```bash
panda agent pairings luna
```

Remove a pairing:

```bash
panda agent unpair luna alice
```

Important rule:

- only paired identities can talk to an agent

If an identity is not paired, TUI access and inbound channel access should fail.

## Step 4: Start The Runtime

Start the daemon:

```bash
panda run
```

With an explicit database URL:

```bash
panda run --db-url postgres://panda_app:app_pw@localhost:5432/panda
```

If chat says:

```text
panda run (primary) is offline.
```

then you forgot this step.

## Step 5: Open Chat

Open chat on a specific agent:

```bash
panda chat --identity alice --agent luna
```

Open a specific session directly:

```bash
panda chat --identity alice --session 2c8d0a1e-...
```

Important behavior:

- if the identity is paired to exactly one agent, Panda can infer the agent when you omit `--agent`
- if the identity is paired to multiple agents, `--agent` is required
- if you pass `--session`, Panda opens that session directly

That failure mode is deliberate.
Silent switching would be bullshit.

## Inspect What You Created

List agents:

```bash
panda agent list
```

List sessions for an agent:

```bash
panda session list luna
```

Inspect one session:

```bash
panda session inspect <sessionId>
```

That inspect output shows:

- agent key
- session kind
- current thread id
- thread model
- heartbeat status

## If The Identity Already Exists

If the identity already exists, you usually only need:

```bash
panda agent pair luna alice
panda chat --identity alice --agent luna
```

## Multiple Agents

One identity can pair with many agents:

```bash
panda agent pair work-bot alice
panda agent pair personal-bot alice
```

At that point, this is ambiguous and should fail:

```bash
panda chat --identity alice
```

Use this instead:

```bash
panda chat --identity alice --agent work-bot
```

## Sessions Matter

Every agent has:

- one `main` session
- optional `branch` sessions created later with `/new`

Remember the key rule:

- `/reset` keeps the same session and replaces its current thread

That is why channels, heartbeat, watches, and scheduled tasks bind to sessions instead of raw thread ids.

Read this next if you want the fuller mental model:

- [Sessions](./sessions.md)

## Channels

Channel pairing is not the same thing as agent pairing.

You still need both layers:

1. external actor -> identity
2. identity -> agent

Telegram example:

```bash
panda telegram whoami
panda telegram pair --identity alice --actor 123456789
panda telegram run
```

WhatsApp example:

```bash
panda whatsapp whoami
panda whatsapp link --phone 421900000000
panda whatsapp pair --identity alice --actor 421911111111
panda whatsapp run
```

Channel workers handle I/O.
`panda run` still owns routing, sessions, and inference.

For WhatsApp, `link --phone` links the connector account itself.
`pair --identity --actor` authorizes a sender phone number to speak as a Panda identity.

For a brand-new channel conversation:

- if the identity is paired to exactly one agent, Panda can auto-bind that conversation to the agent's main session
- if the identity is paired to multiple agents, bind the conversation explicitly

Explicit bind example:

```bash
panda session bind-conversation <sessionId> telegram main <externalConversationId>
```

## Common Mistakes

- creating an identity and forgetting to pair it to the agent
- starting `panda chat` before `panda run`
- assuming identity owns a home thread
- assuming channel pairing is enough without agent pairing
- omitting `--agent` after one identity has been paired to multiple agents

## Read Next

- [Sessions](./sessions.md) for the durable unit and session CLI
- [Identity](./identity.md) for the access model
- [Heartbeat](./heartbeat.md) for periodic wakes
- [Browser](./browser.md) for the Dockerized Chromium lane
- [Remote Bash](./remote-bash.md) for runner setups
