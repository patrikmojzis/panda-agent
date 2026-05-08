# A2A Messaging

A2A is live.

Panda-to-Panda messaging is implemented as session-to-session delivery with agent-aware sugar on top.

## Core Surface

- tool: `message_agent`
- CLI namespace: `panda a2a`
- binding table: `runtime.a2a_session_bindings`
- transport identity: `source = "a2a"`, `connectorKey = "local"`
- default rate limit: `300/hour` per `fromSessionId -> toSessionId`
- rate limit env: `A2A_MAX_MESSAGES_PER_HOUR`

## Mental Model

- the durable lane is the `session`
- `agentKey` is just a convenient way to resolve an agent's `main` session
- there is no thread targeting
- receive-time resolution always uses the recipient session's current thread
- `/reset` swaps the thread and keeps the A2A lane intact because the binding is session-scoped

That means:

- main-to-main is easy with `agentKey`
- anything involving a branch session should use `sessionId`
- same agent, different sessions can message each other
- same-session send is blocked

## File Map

- [src/panda/tools/message-agent-tool.ts](/Users/patrikmojzis/Projects/panda-agent/src/panda/tools/message-agent-tool.ts)
- [src/domain/a2a/service.ts](/Users/patrikmojzis/Projects/panda-agent/src/domain/a2a/service.ts)
- [src/domain/a2a/repo.ts](/Users/patrikmojzis/Projects/panda-agent/src/domain/a2a/repo.ts)
- [src/domain/a2a/cli.ts](/Users/patrikmojzis/Projects/panda-agent/src/domain/a2a/cli.ts)
- [src/integrations/channels/a2a/config.ts](/Users/patrikmojzis/Projects/panda-agent/src/integrations/channels/a2a/config.ts)
- [src/integrations/channels/a2a/outbound.ts](/Users/patrikmojzis/Projects/panda-agent/src/integrations/channels/a2a/outbound.ts)
- [src/integrations/channels/a2a/helpers.ts](/Users/patrikmojzis/Projects/panda-agent/src/integrations/channels/a2a/helpers.ts)
- [src/prompts/channels/a2a.ts](/Users/patrikmojzis/Projects/panda-agent/src/prompts/channels/a2a.ts)
- [src/app/runtime/daemon-requests.ts](/Users/patrikmojzis/Projects/panda-agent/src/app/runtime/daemon-requests.ts)

## Tool Contract

`message_agent` accepts:

```ts
{
  agentKey?: string;
  sessionId?: string;
  items: Array<
    | {type: "text"; text: string}
    | {type: "image"; path: string; caption?: string}
    | {type: "file"; path: string; filename?: string; caption?: string; mimeType?: string}
  >;
}
```

Rules:

- at least one of `agentKey` or `sessionId` is required
- `agentKey` resolves the recipient main session
- `sessionId` targets one exact session
- passing both makes Panda validate ownership
- delivery is always `wake`
- the tool is fire-and-forget
- the tool returns queued metadata, not a reply from the recipient

The current queued result includes:

- `status`
- `deliveryId`
- `targetAgentKey`
- `targetSessionId`
- `messageId`

## Attachments

V1 supports:

- text
- images
- arbitrary files

Attachment rules in the tool layer:

- max `10` items per send
- max `20 MB` per attachment
- max `50 MB` total attachment bytes per send
- paths are resolved from the runtime working directory/context

Attachment transfer is receiver-side durable media ingestion:

1. the sender tool validates and resolves paths
2. the A2A outbound adapter reads bytes from those sender-local paths
3. the adapter writes media into the recipient agent's media store
4. the runtime request carries receiver-local `MediaDescriptor` values

Raw sender paths do not cross the session boundary as the durable contract.

## Binding Model

Bindings are directional rows in `runtime.a2a_session_bindings`.

Actual row shape:

- `sender_session_id`
- `recipient_session_id`
- `created_at`
- `updated_at`

The primary key is `(sender_session_id, recipient_session_id)`.

The CLI creates both directions by default, but the table still stores two rows.

That is deliberate. Revocation stays simple and one-way binds remain possible.

## CLI

Commands:

- `panda a2a bind`
- `panda a2a unbind`
- `panda a2a list`

Useful forms:

```bash
panda a2a bind --from-agent panda --to-agent koala
panda a2a bind <senderSessionId> <recipientSessionId>
panda a2a list --from-agent panda
panda a2a unbind --from-agent panda --to-agent koala
```

Notes:

- every command accepts `--db-url <url>`
- `--from-agent` and `--to-agent` resolve main sessions
- `--one-way` skips the reverse row
- if you care about a branch session, bind with explicit session ids

## Send Path

1. `message_agent` validates schema and resolves attachment paths
2. `A2AMessagingService` resolves the target session
3. same-session send is blocked
4. the directional allowlist is checked
5. the per-session-pair rate limit is checked
6. one stable `a2a:<uuid>` message id is minted
7. an outbound delivery is enqueued on channel `a2a`

Sender provenance lives in `delivery.metadata.a2a`:

- `messageId`
- `fromAgentKey`
- `fromSessionId`
- `fromThreadId`
- `fromRunId`
- `toAgentKey`
- `toSessionId`
- `sentAt`

## Delivery Worker Path

1. the A2A outbound worker claims the pending delivery
2. the adapter validates `connectorKey = "local"` and A2A metadata
3. recipient session ownership is verified again
4. attachments are copied into the recipient media store when present
5. an `a2a_message` runtime request is enqueued
6. the outbound delivery is marked sent

## Receive Path

1. the daemon validates the binding again
2. it verifies that `toSessionId` still belongs to `toAgentKey`
3. it dedupes by `messageId` at session scope
4. it resolves the recipient session's current thread
5. it submits one runtime input with `source = "a2a"`
6. it wakes that session immediately

Two important implementation details:

- A2A does not write generic `sessionRoutes`
- A2A does not write generic `metadata.route`

That keeps `outbound` fallback memory clean and avoids teaching Panda that an internal A2A lane is a human reply channel.

## Dedupe

Dedupe is session-scoped, not thread-scoped.

The generic runtime unique index is still thread-based, so A2A handles its own receive-side dedupe before `submitInput`.

Current implementation:

- sender mints one stable `a2a:<uuid>` id
- retries reuse that id
- receive path checks `runtime.inputs`
- the check joins `runtime.inputs` to `runtime.threads`
- the uniqueness boundary is effectively `recipientSessionId + senderSessionId + messageId`

That makes retries survive session resets cleanly.

## Prompting And Identity

Inbound A2A has its own wrapper in [src/prompts/channels/a2a.ts](/Users/patrikmojzis/Projects/panda-agent/src/prompts/channels/a2a.ts).

The model sees:

- `channel: a2a`
- `message_id`
- `from_agent_key`
- `from_session_id`
- attachment descriptions
- message body

Inbound A2A does **not** fake a human:

- `identityId` is absent
- provenance is agent/session provenance
- `actorId` is the sending agent key
- `channelId` is the sending session id

## Safety Rules

- `outbound` must not be used for A2A
- `message_agent` is the only supported Panda-to-Panda send tool
- same-session send is blocked
- allowlist is enforced both on send and on receive
- A2A is wake-only
- wake means "make the recipient runnable for the next turn boundary", not "preempt the current planned tool chain"
- A2A is fire-and-forget
- there is no request/response RPC behavior in v1
- there is no wildcard "any session on this agent" binding

## Verification

Current automated coverage includes:

- [tests/a2a.test.ts](/Users/patrikmojzis/Projects/panda-agent/tests/a2a.test.ts)
- [tests/message-agent-tool.test.ts](/Users/patrikmojzis/Projects/panda-agent/tests/message-agent-tool.test.ts)
- [tests/outbound-tool.test.ts](/Users/patrikmojzis/Projects/panda-agent/tests/outbound-tool.test.ts)

There is not yet a dedicated live `a2a.live.test.ts`.
The current live verification path is smoke-driven.
