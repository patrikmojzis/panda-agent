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
- authorization is checked before media download or durable request creation, then checked again before thread delivery
- no raw message bodies in logs
- no history sync messages enter the transcript

That gate matters. Nothing reaches Panda before it.

## Worker Shape

The supervisor supports two explicit connector modes:

- absent `mode`: the existing long-lived Baileys messaging worker;
- `mode = "meta_cloud"`: the official Meta Cloud Calling webhook and WebRTC worker.

The Baileys worker has:

- account-owned, AES-GCM-encrypted auth state in Postgres
- reconnect handling
- TTL-based per-account connector leases

The supervisor runs one isolated protocol worker per enabled linked account. Those workers share one daemon-owned Postgres pool and notification listener; each account keeps its own Baileys socket and auth state.
The Cloud Calling worker deliberately uses Meta's signed webhook because that is the official call-signalling interface. It does not use Baileys or consumer WhatsApp's private VoIP protocol.
Pairing retry policy belongs in `src/integrations/channels/whatsapp/pairing.ts`;
the service should wire auth/socket creation and delegate reconnect semantics to
that module.

Docker stack support is profile-gated:

- set `WHATSAPP_ENABLED=true` to run `panda-whatsapp`
- set `CREDENTIALS_MASTER_KEY`; WhatsApp auth cannot be read or written without it
- leave `PANDA_WHATSAPP_VERSION` empty unless you need to pin a specific WhatsApp Web version
- keep the default 25 MiB media cap and 30-second deadline unless the host has a deliberately different budget
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

## Meta Cloud Calling

Inbound user-initiated calls use [Meta's official Calling flow](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls), phone-number `/calls` operations, and a signed webhook at:

```text
POST /webhooks/whatsapp/calls
```

Create a separate agent-owned connector, keep it disabled while preparing credentials, then configure it from private files so secrets never appear in the process list:

```bash
./scripts/docker-stack.sh panda whatsapp account create calls --agent clawd
./scripts/docker-stack.sh panda whatsapp account configure-calling calls \
  --phone-number-id <meta-phone-number-id> \
  --waba-id <whatsapp-business-account-id> \
  --graph-version v23.0 \
  --access-token-file /run/secrets/panda-core/meta-whatsapp-access-token \
  --app-secret-file /run/secrets/panda-core/meta-whatsapp-app-secret \
  --verify-token-file /run/secrets/panda-core/meta-whatsapp-verify-token
./scripts/docker-stack.sh panda whatsapp pair \
  --account calls \
  --identity <identity-handle> \
  --actor <caller-phone-or-bsuid>
```

Place those temporary files under the host's `PANDA_CORE_SECRETS_HOST_ROOT` with owner-only permissions, run the command, then remove them. The command encrypts `meta_access_token`, `meta_app_secret`, and `meta_verify_token` through the connector credential store and enables the account only after all three writes succeed. The account configuration contains identifiers, never secret values. Pairing an exact caller on a Meta Cloud connector also creates the authorization-stamped conversation binding to the owning agent's active main session.

Expose container port `PANDA_WHATSAPP_CALL_WEBHOOK_PORT` (default `8096`) through an operator-owned HTTPS reverse proxy. Meta must be configured with the public HTTPS URL ending in `/webhooks/whatsapp/calls` and the same verification token. The built-in listener is HTTP; TLS termination belongs at the edge.

Calls fail closed unless all of the following hold:

- `PANDA_LIVE_VOICE_ENABLED=true` reaches core and the WhatsApp worker;
- the WhatsApp caller has an exact identity binding on this connector;
- that identity is paired with the connector's owning agent;
- the exact caller id has an existing WhatsApp conversation binding to an active session; and
- Codex OAuth is readable from the read-only `CODEX_HOME` mount.

Phone callers reuse the canonical `<digits>@s.whatsapp.net` actor id. When Meta omits the phone number, pair the exact `bsuid:<id>` instead. Do not translate or guess between those identifiers.

The owning Panda session responds through:

```text
panda whatsapp call status [--connector <key>]
panda whatsapp call send --text <message> [--mode progress|final] [--call <id>] [--turn <id>]
panda whatsapp call hangup [--call <id>] [--turn <id>] [--connector <key>]
```

Raw audio, SDP, access tokens, app secrets, verification tokens, and caller phone numbers are not written to durable turns or routine logs. Delegated turns retain only the non-PII identity, agent, actor-binding ID, and authorization-version snapshot; the daemon revalidates that grant and the bound session immediately before delivery. Signed connect events, overflow rejections, RTP input, and dedupe state are all bounded. Calls are transient and are not restored after worker restart. Outbound dialling is not implemented.

Remote ICE candidates must be globally routable IP literals. Private, loopback, link-local, multicast, IPv4-mapped private, hostname, and mDNS candidates are rejected before Werift negotiation so a paired caller cannot turn the worker into an internal UDP probe.

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

- authorize the actor before downloading any bytes
- stream and decrypt WhatsApp media through a strict plaintext byte limit and deadline
- share one bounded media queue across every account in the supervisor
- push them through the existing filesystem media store
- attach stable local file paths and useful metadata for the model

Oversize, timed-out, and queue-saturated media is dropped as a message-local policy failure. It does not reconnect the WhatsApp account. Defaults are controlled by `PANDA_WHATSAPP_MAX_MEDIA_BYTES`, `PANDA_WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS`, `PANDA_WHATSAPP_MEDIA_CONCURRENCY`, and `PANDA_WHATSAPP_MEDIA_QUEUE_MAX`.

Conversation bindings created before the authorization-snapshot hardening do not contain actor-grant provenance and therefore fail closed. Remove the old WhatsApp conversation binding once in Control; the next authorized DM recreates it with current identity, agent, and actor-binding provenance.

Byte-based only. No URL download assumptions.

## Current Scope

The current messaging slice is intentionally narrow:

- DM only
- text inbound and outbound
- image inbound and outbound
- file inbound and outbound

Not in this slice:

- groups
- history sync ingest
- in-band session rebinding UX
- scheduler-specific special cases
- outbound WhatsApp call dialling

## Code Map

- [src/integrations/channels/whatsapp/config.ts](../../src/integrations/channels/whatsapp/config.ts)
- [src/integrations/channels/whatsapp/cli.ts](../../src/integrations/channels/whatsapp/cli.ts)
- [src/integrations/channels/whatsapp/auth-store.ts](../../src/integrations/channels/whatsapp/auth-store.ts)
- [src/integrations/channels/whatsapp/service.ts](../../src/integrations/channels/whatsapp/service.ts)
- [src/integrations/channels/whatsapp/calls/manager.ts](../../src/integrations/channels/whatsapp/calls/manager.ts)
- [src/integrations/channels/whatsapp/calls/webhook.ts](../../src/integrations/channels/whatsapp/calls/webhook.ts)
- [src/integrations/channels/whatsapp/calls/peer.ts](../../src/integrations/channels/whatsapp/calls/peer.ts)
- [src/integrations/channels/whatsapp/outbound.ts](../../src/integrations/channels/whatsapp/outbound.ts)
- [tests/whatsapp-runtime-cycle.test.ts](../../tests/whatsapp-runtime-cycle.test.ts)
- [tests/whatsapp-message-ingestion.test.ts](../../tests/whatsapp-message-ingestion.test.ts)
- [tests/whatsapp-connection.test.ts](../../tests/whatsapp-connection.test.ts)
- [tests/whatsapp-pairing.test.ts](../../tests/whatsapp-pairing.test.ts)
- [tests/whatsapp-outbound.test.ts](../../tests/whatsapp-outbound.test.ts)
