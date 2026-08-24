# WhatsApp Channel

## Goal

WhatsApp is a private DM window into Panda, not a separate brain.

The intended shape is:

- one owning agent per connector account
- multiple linked accounts per supervisor
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

- account-owned, AES-GCM-encrypted auth state in Postgres
- reconnect handling
- TTL-based per-account connector leases

The supervisor runs one isolated protocol worker per enabled linked account. Those workers share one daemon-owned Postgres pool and notification listener; each account keeps its own Baileys socket and auth state.
Do not invent webhooks or clustering until there is a real reason.
Pairing retry policy belongs in `src/integrations/channels/whatsapp/pairing.ts`;
the service should wire auth/socket creation and delegate reconnect semantics to
that module.

Docker stack support is profile-gated:

- set `WHATSAPP_ENABLED=true` to run `panda-whatsapp`
- set `CREDENTIALS_MASTER_KEY`; WhatsApp auth cannot be read or written without it
- leave `PANDA_WHATSAPP_VERSION` empty unless you need to pin a specific WhatsApp Web version
- create/link accounts in Control, or use `panda whatsapp account create/link`
- authorize sender identities with `panda whatsapp pair --account <account-key> --identity <handle> --actor <sender-phone-or-lid>`
- remove stale sender bindings with `panda whatsapp unpair --account <account-key> --actor <sender-phone-or-jid>`

In the Docker stack, run those CLI commands through the core container:

```bash
./scripts/docker-stack.sh panda whatsapp account create main --agent clawd
./scripts/docker-stack.sh panda whatsapp account link main --phone <connector-phone>
./scripts/docker-stack.sh panda whatsapp pair --account main --identity <handle> --actor <sender-phone-or-lid>
./scripts/docker-stack.sh panda whatsapp unpair --account main --actor <sender-phone-or-jid>
./scripts/docker-stack.sh panda whatsapp run --all-enabled
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

Replies go through the WhatsApp provider command, `panda whatsapp send` / `whatsapp.send`.

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
- [tests/whatsapp-runtime-cycle.test.ts](../../tests/whatsapp-runtime-cycle.test.ts)
- [tests/whatsapp-message-ingestion.test.ts](../../tests/whatsapp-message-ingestion.test.ts)
- [tests/whatsapp-connection.test.ts](../../tests/whatsapp-connection.test.ts)
- [tests/whatsapp-pairing.test.ts](../../tests/whatsapp-pairing.test.ts)
- [tests/whatsapp-outbound.test.ts](../../tests/whatsapp-outbound.test.ts)
