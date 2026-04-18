# A2A Messaging

A2A lets one Panda session message another Panda session.

The real model is session-to-session.
Agent names are just sugar for "that agent's main session."

## Keep The Model Straight

- `agent` = persona
- `session` = durable lane
- `thread` = replaceable backing history inside that session
- A2A binding = `sender_session_id -> recipient_session_id`

Important bit:

- no thread targeting
- resets are fine because the session survives and the current thread is resolved at receive time
- `agentKey` with no `sessionId` always means the recipient main session

If you want a branch session, bind that session explicitly.

## Quick Start

Bind Panda main to Koala main:

```bash
panda a2a bind --from-agent panda --to-agent koala
```

That creates both directions by default:

- `panda main -> koala main`
- `koala main -> panda main`

List the current bindings:

```bash
panda a2a list
```

Remove the binding later:

```bash
panda a2a unbind --from-agent panda --to-agent koala
```

## Binding Exact Sessions

If branches are involved, stop using agent flags and bind exact session ids.

First find the sessions:

```bash
panda session list panda
panda session list koala
```

Then bind the exact lanes you care about:

```bash
panda a2a bind <senderSessionId> <recipientSessionId>
```

Examples:

- main -> branch
- branch -> main
- branch -> branch
- same agent, different sessions

That is the honest model.

## One-Way Binding

If you only want one direction, use `--one-way`:

```bash
panda a2a bind <senderSessionId> <recipientSessionId> --one-way
```

Same thing for unbind:

```bash
panda a2a unbind <senderSessionId> <recipientSessionId> --one-way
```

## Remote Database

Every A2A CLI command accepts `--db-url`.

That is useful when Panda is pointed at a remote instance:

```bash
panda a2a bind --from-agent panda --to-agent koala --db-url postgresql://user:pass@host:5432/panda
```

## Filtering And Inspection

List only bindings from one sender:

```bash
panda a2a list --from-agent panda
```

List only bindings into one recipient session:

```bash
panda a2a list --to-session <sessionId>
```

## What The Agents Can Send

Once a binding exists, Panda can use `message_agent` to send:

- text
- images
- arbitrary files

Delivery is:

- wake-only
- fire-and-forget
- session-scoped

It is not request/response RPC.

## Rules And Limits

- same-session send is blocked
- allowlist is checked on send and on receive
- default rate limit is `20` messages per hour per session pair
- files and images are allowed, but size caps still apply
- agent flags resolve only main sessions

## Typical Patterns

Use agent flags when:

- you want main-session to main-session messaging

Use session ids when:

- a branch session is involved
- you want one exact lane
- you do not want "main session" resolution

If you are unsure, use session ids.
It is more explicit and less magical.
