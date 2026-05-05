# WhatsApp Channel

## Goal

WhatsApp is a private DM window into Panda, not a separate brain.

The intended shape is:

- one agent
- one main session by default
- many windows into that same session

## Privacy Boundary

This channel stays private by default.

Every inbound message must pass identity binding lookup for:

- `source = "whatsapp"`

And must satisfy these rules:

- DM only
- paired senders only
- unpaired senders are dropped and logged
- no raw message bodies in logs
- no history sync messages enter the transcript

That gate matters. Nothing reaches Panda before it.

## Worker Shape

The worker is a long-lived Baileys process with:

- durable auth state in Postgres
- reconnect handling
- one-process-per-account locking

Keep it one worker per linked account.
Do not invent webhooks or clustering until there is a real reason.

Docker stack support is profile-gated:

- set `WHATSAPP_ENABLED=true` to run `panda-whatsapp`
- set `WHATSAPP_CONNECTOR_KEY=main` unless you need multiple linked accounts
- link the connector once with `panda whatsapp link --phone <connector-phone>`
- authorize sender identities with `panda whatsapp pair --identity <handle> --actor <sender-phone>`

In the Docker stack, run those CLI commands through the core container:

```bash
./scripts/docker-stack.sh panda whatsapp link --phone <connector-phone>
./scripts/docker-stack.sh panda whatsapp pair --identity <handle> --actor <sender-phone>
```

## Inbound Shape

Inbound normalization should fit Panda's channel model, not drag provider junk into the core loop.

Useful channel metadata:

- `connectorKey`
- `externalConversationId`
- `externalActorId`
- `externalMessageId`

Keep connector-specific metadata minimal but useful.

## Routing

WhatsApp routing is session-first now.

The flow is:

1. resolve the external actor to an identity
2. verify that identity is paired to an agent
3. resolve the conversation binding to a session
4. resolve `session.current_thread_id`
5. enqueue the input on that thread

For a new DM:

- if the identity has exactly one paired agent, Panda can auto-bind that conversation to the agent's main session
- if the identity has multiple paired agents, an operator must bind the conversation explicitly

Storage lives in:

- `conversation_sessions` for conversation -> session binding
- `session_routes` for remembered return path

## Outbound

Replies go through the existing universal `outbound` tool.

WhatsApp-specific behavior should stay in the adapter layer:

- text send
- image send
- file send
- successful sends update the remembered route

We are not introducing a separate delivery-target abstraction here yet.
Keep it simple.

## Media

Media ingestion should:

- download and decrypt WhatsApp media bytes
- push them through the existing filesystem media store
- attach stable local file paths and useful metadata for the model

Byte-based only. No URL download assumptions.

## Current Scope

The current slice is intentionally narrow:

- DM only
- text inbound and outbound
- image inbound and outbound
- file inbound and outbound

Not in this slice:

- groups
- history sync ingest
- in-band session rebinding UX
- scheduler-specific special cases

## Code Map

- [src/integrations/channels/whatsapp/config.ts](../../src/integrations/channels/whatsapp/config.ts)
- [src/integrations/channels/whatsapp/cli.ts](../../src/integrations/channels/whatsapp/cli.ts)
- [src/integrations/channels/whatsapp/auth-store.ts](../../src/integrations/channels/whatsapp/auth-store.ts)
- [src/integrations/channels/whatsapp/service.ts](../../src/integrations/channels/whatsapp/service.ts)
- [src/integrations/channels/whatsapp/outbound.ts](../../src/integrations/channels/whatsapp/outbound.ts)
- [tests/whatsapp-service.test.ts](../../tests/whatsapp-service.test.ts)
- [tests/whatsapp-outbound.test.ts](../../tests/whatsapp-outbound.test.ts)
