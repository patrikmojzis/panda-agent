# Sessions

Sessions are the durable chat lanes in Panda.

Keep the model straight:

- `agent` = persona
- `identity` = person
- `session` = durable lane on the agent
- `thread` = replaceable backing history for that session

If you remember one thing, remember this:

- surfaces bind to `session_id`
- `/reset` replaces the thread inside that session
- tasks, watches, and heartbeat stay with the session

## Main And Branch Sessions

Every agent has exactly one `main` session.

That is the default lane for:

- normal chat
- heartbeat
- first inbound channel conversations

An agent may also have `branch` sessions.

Those are explicit side lanes created from the TUI with `/new`.

## TUI Commands

Inside chat:

- `/new` creates a fresh branch session
- `/reset` replaces the current session thread with a fresh empty thread
- `/sessions` opens the current agent's session picker
- `/resume <session-id>` opens another saved session

`/reset` does not create a new session.
It keeps the same `session_id` and swaps the backing thread.

## CLI

List sessions for an agent:

```bash
panda session list luna
```

Inspect one session:

```bash
panda session inspect 2c8d0a1e-...
```

Reset one session through the daemon:

```bash
panda session reset 2c8d0a1e-...
```

Configure heartbeat for a session:

```bash
panda session heartbeat 2c8d0a1e-... --enable --every 45
```

Bind an external conversation to a session:

```bash
panda session bind-conversation 2c8d0a1e-... telegram main 123456
```

## Opening Chat

Open chat on an agent's main session:

```bash
panda chat --identity alice --agent luna
```

If an identity is paired to exactly one agent, Panda can infer the agent.
If that identity is paired to multiple agents, `--agent` is required.

You can also open a session directly:

```bash
panda chat --identity alice --session 2c8d0a1e-...
```

## Channels

Channels do not bind to raw threads anymore.

For v1:

- external actors pair to identities
- external conversations bind to sessions
- if the paired identity has exactly one paired agent, a new conversation can auto-bind to that agent's main session
- if the identity has multiple paired agents, bind the conversation explicitly with `panda session bind-conversation`

## Important Rules

- all paired identities can access all sessions on that agent
- if one paired identity resets a session, that reset applies to everyone on that session
- if you want a private mental space, make a separate agent
- do not think in "home thread" anymore; think "main session with a current thread"
