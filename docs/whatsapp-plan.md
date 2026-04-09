# WhatsApp V1 Plan

## Goal

Add a private WhatsApp DM channel to Panda using Baileys, while keeping the existing Panda model intact:

- one brain (`home`)
- many windows
- optional branches later

WhatsApp should behave like Telegram:

- unbound DM -> `home`
- paired users only
- same `outbound` tool
- same `lastRoute` memory on `home_threads`

## Scope

V1 is intentionally narrow:

- DM only
- text inbound/outbound
- image inbound/outbound
- file inbound/outbound
- no groups
- no history sync ingest
- no `/new`
- no live smoke testing until the SIM arrives

## Safety Rules

- The WhatsApp number may be publicly reachable, but Panda stays private.
- Every inbound message must pass `identity_bindings` lookup for `source="whatsapp"`.
- Unpaired senders are silently dropped and logged.
- No raw message bodies in logs.
- No history sync messages should enter the transcript.

## Execution Rules

For every task below:

1. Move exactly one task to `in_progress`.
2. Read the existing code first.
3. Write the smallest plan that fits Panda's current patterns.
4. Implement without inventing new abstractions.
5. Re-read and simplify your own code.
6. Mark the task `completed` before starting the next one.

## Task 1: Connector Shell

Status: `completed`

Goal:
- Create the WhatsApp feature folder with the same basic shape as Telegram.

Read first:
- `src/features/telegram/cli.ts`
- `src/features/telegram/runtime.ts`
- `src/features/telegram/service.ts`
- `src/features/telegram/outbound.ts`

Deliverables:
- `src/features/whatsapp/config.ts`
- `src/features/whatsapp/cli.ts`
- `src/features/whatsapp/runtime.ts`
- `src/features/whatsapp/service.ts`
- `src/features/whatsapp/outbound.ts`
- `src/features/whatsapp/index.ts`

Notes:
- Match Telegram structure.
- Do not add a generic transport framework.

## Task 2: Durable Baileys Auth Store

Status: `completed`

Goal:
- Persist Baileys auth state in Postgres so the worker survives restarts.

Read first:
- `src/features/home-threads/postgres.ts`
- `src/features/channel-cursors/postgres.ts`
- `src/features/identity/postgres.ts`

Deliverables:
- `src/features/whatsapp/auth-store.ts`
- schema for creds + keys
- typed load/save API for Baileys auth state

Notes:
- No file-based auth as the source of truth.
- Keep the schema boring and explicit.

## Task 3: Pairing + Operator CLI

Status: `completed`

Goal:
- Let the operator pair the WhatsApp account and inspect what account is linked.

Read first:
- `src/features/telegram/cli.ts`
- `tests/telegram-cli.test.ts`

Deliverables:
- `panda whatsapp pair`
- `panda whatsapp whoami`
- `panda whatsapp run`

Notes:
- `pair` should drive the Baileys pairing flow.
- `whoami` should show the linked account JID / number.
- Use the existing CLI command style.

## Task 4: Worker Lifecycle

Status: `completed`

Goal:
- Run a long-lived WhatsApp worker process with reconnect handling and one-process-per-account locking.

Read first:
- `src/features/telegram/service.ts`
- connector lock logic there
- `src/features/channel-cursors/*`

Deliverables:
- Baileys socket bootstrap
- reconnect policy
- connector advisory lock
- clean shutdown

Notes:
- Keep it one worker per linked account.
- Do not implement webhooks or multi-process clustering.

## Task 5: Inbound Gate

Status: `completed`

Goal:
- Make WhatsApp private by default and only ingest paired DM senders.

Read first:
- `src/features/identity/store.ts`
- `src/features/telegram/service.ts`
- `docs/chat-vision.md`

Deliverables:
- DM-only gate
- unpaired drop path
- structured drop logging
- ignore groups and unsupported event types

Notes:
- This is the privacy wall.
- Nothing reaches Panda before this gate.

## Task 6: Inbound Normalization

Status: `completed`

Goal:
- Normalize WhatsApp messages into Panda's current inbound shape.

Read first:
- `src/features/channels/core/types.ts`
- `src/features/telegram/helpers.ts`
- `src/features/telegram/service.ts`
- `src/features/channels/core/media-store.ts`

Deliverables:
- text normalization
- WhatsApp channel-context block for the model
- metadata attached to the user message
- mapping for:
  - `connectorKey`
  - `externalConversationId`
  - `externalActorId`
  - `externalMessageId`

Notes:
- Keep connector-specific metadata minimal but useful.
- Match the Telegram-to-Panda experience.

## Task 7: Home Routing

Status: `completed`

Goal:
- Route unbound WhatsApp DMs to the relationship `home`.

Read first:
- `src/features/home-threads/store.ts`
- `src/features/conversation-threads/store.ts`
- `src/features/telegram/runtime.ts`
- `src/features/telegram/service.ts`

Deliverables:
- unbound DM -> `home`
- branch override support through `conversation_threads` if needed later
- remember `lastRoute` on `home_threads`

Notes:
- WhatsApp is a window into the same Panda, not a separate brain.

## Task 8: Outbound

Status: `completed`

Goal:
- Send WhatsApp replies through the existing universal `outbound` tool.

Read first:
- `src/features/panda/tools/outbound-tool.ts`
- `src/features/channels/core/outbound.ts`
- `src/features/telegram/outbound.ts`

Deliverables:
- WhatsApp outbound adapter
- text send
- image send
- file send
- successful sends update remembered route like Telegram does

Notes:
- Keep route resolution rules consistent with Telegram.

## Task 9: Media Pipeline

Status: `completed`

Goal:
- Download/decrypt WhatsApp media bytes and push them through the existing file-system media store.

Read first:
- `src/features/channels/core/media-store.ts`
- media handling in `src/features/telegram/service.ts`
- `src/features/panda/tools/media-tool.ts`

Deliverables:
- image ingest
- document ingest
- attachment metadata for the model
- stable local file paths

Notes:
- Byte-based only.
- No URL download assumptions.

## Task 10: Tests

Status: `completed`

Goal:
- Prove the WhatsApp adapter matches Panda’s current conventions before a SIM-based smoke test.

Read first:
- `tests/telegram-service.test.ts`
- `tests/telegram-cli.test.ts`
- `tests/outbound-tool.test.ts`
- `tests/home-threads-postgres.test.ts`

Deliverables:
- auth-store tests
- CLI tests
- service tests
- routing tests
- outbound tests
- media normalization tests

Notes:
- No live smoke testing in this phase.
- Test the boring edge cases now, not after pairing tomorrow.

## Task 11: Follow-Up, Not In This Slice

Status: `todo_later`

Items:
- `/reset`
- `/help`
- `/whoami` inside WhatsApp chat
- typing indicator equivalent if WhatsApp supports it cleanly
- groups
- `/btw`
- scheduler / heartbeat / reminders

## Build Order

1. Connector shell
2. Durable auth store
3. Pairing + operator CLI
4. Worker lifecycle
5. Inbound gate
6. Inbound normalization
7. Home routing
8. Outbound
9. Media pipeline
10. Tests

## Definition of Done

WhatsApp V1 is done when:

- a paired DM lands in Panda `home`
- an unpaired DM is dropped
- text/image/file go both ways
- `lastRoute` is remembered on `home_threads`
- the code matches Telegram’s patterns without copying its mess
