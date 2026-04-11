# WhatsApp Channel

## Goal

WhatsApp is a private DM window into Panda, not a separate brain.

The intended shape stays consistent with the rest of chat:

- one brain (`home`)
- many windows
- optional branches later

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

## Inbound Shape

Inbound normalization should fit Panda's current channel model, not drag provider junk into the core loop.

Useful channel metadata:

- `connectorKey`
- `externalConversationId`
- `externalActorId`
- `externalMessageId`

Keep connector-specific metadata minimal but useful.

## Routing

Unbound WhatsApp DMs route to the relationship `home`.

That means:

- DM to `home` by default
- future branch override can hang off `conversation_threads`
- remembered `lastRoute` lives on `home_threads`

WhatsApp is a window into the same Panda, not a channel-owned truth source.

## Outbound

Replies go through the existing universal `outbound` tool.

WhatsApp-specific behavior should stay in the adapter layer:

- text send
- image send
- file send
- successful sends update the remembered route

Route resolution rules should match Telegram unless there is a concrete reason to diverge.

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
- channel-local `/new`
- scheduler or heartbeat-specific behavior

## Code Map

- [src/integrations/channels/whatsapp/config.ts](../../src/integrations/channels/whatsapp/config.ts)
- [src/integrations/channels/whatsapp/cli.ts](../../src/integrations/channels/whatsapp/cli.ts)
- [src/integrations/channels/whatsapp/auth-store.ts](../../src/integrations/channels/whatsapp/auth-store.ts)
- [src/integrations/channels/whatsapp/service.ts](../../src/integrations/channels/whatsapp/service.ts)
- [src/integrations/channels/whatsapp/outbound.ts](../../src/integrations/channels/whatsapp/outbound.ts)
- [tests/whatsapp-service.test.ts](../../tests/whatsapp-service.test.ts)
- [tests/whatsapp-outbound.test.ts](../../tests/whatsapp-outbound.test.ts)
