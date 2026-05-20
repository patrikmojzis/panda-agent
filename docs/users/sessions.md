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
- `/resume <session-id-or-alias>` opens another saved session on the current agent

`/reset` does not create a new session.
It keeps the same `session_id` and swaps the backing thread.

## CLI

Create a fresh branch session for an agent:

```bash
panda session create luna
```

That prints the generated `sessionId`, the first thread id, and a copy-paste Discord bind example.

Create a branch session with a readable stable id:

```bash
panda session create luna ops-inbox
```

Readable refs are normalized to lowercase, must start with a letter or number, and must use only letters, numbers, hyphens, or underscores.
The session id becomes `luna:ops-inbox`. That string is the real session id, not an alias.
Branch-session heartbeat starts disabled.

Create a branch session with an operator-only alias/display name:

```bash
panda session create luna --alias ops-inbox --display-name "Ops Inbox"
```

Aliases are lowercase, unique per agent, and resolve only when Panda knows the agent scope. The stored `session_id` stays canonical.

List sessions for an agent:

```bash
panda session list luna
```

Set, change, or clear labels:

```bash
panda session label 2c8d0a1e-... --alias ops --display-name "Ops"
panda session label ops --agent luna --clear-alias
```

Inspect one session:

```bash
panda session inspect 2c8d0a1e-...
# or a readable branch id
panda session inspect luna:ops-inbox
# or an alias with agent scope
panda session inspect ops-inbox --agent luna
```

Reset one session through the daemon:

```bash
panda session reset 2c8d0a1e-...
panda session reset ops-inbox --agent luna
```

Configure heartbeat for a session:

```bash
panda session heartbeat 2c8d0a1e-... --enable --every 45
panda session heartbeat ops-inbox --agent luna --enable --every 45
```

Bind an external conversation to a session:

```bash
panda session bind-conversation 2c8d0a1e-... telegram main 123456
panda session bind-conversation ops-inbox telegram main 123456 --agent luna
panda discord bind-channel --account main --channel 123456 --session ops-inbox --agent luna
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
panda chat --identity alice --session luna:ops-inbox
panda chat --identity alice --agent luna --session ops-inbox
```

Watch a session without opening chat:

```bash
panda observe --agent luna
```

`panda observe` is read-only.
It is session-aware, so `--agent` and `--session` follow resets onto the new current thread.
Use it when you want a second window tailing persisted activity without attaching an interactive TUI.

## Channels

Channels do not bind to raw threads anymore.

For v1:

- external actors pair to identities
- external conversations bind to sessions
- if the paired identity has exactly one paired agent, a new conversation can auto-bind to that agent's main session
- if the identity has multiple paired agents, bind the conversation explicitly with `panda session bind-conversation`

For Panda-to-Panda messaging, use [A2A Messaging](./a2a.md).

## Important Rules

- aliases/display names are operator affordances; Panda stores canonical session ids in bindings and routes
- all paired identities can access all sessions on that agent
- if one paired identity resets a session, that reset applies to everyone on that session
- if you want a private mental space, make a separate agent
- do not think in "home thread" anymore; think "main session with a current thread"
