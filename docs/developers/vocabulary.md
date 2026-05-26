# Developer Vocabulary

This is the short shared vocabulary for Panda internals. Use these words when
naming code, docs, issues, and PRs. The goal is boring precision: do not mix a
security principal, a runtime lane, and a product feature just because they meet
in one flow.

For deeper background, follow the linked docs. This page is the boundary map,
not the essay.

## Agent vs identity

An **agent** is the Panda persona/runtime owner. It owns sessions, tools, skills,
credentials, and automation.

An **identity** is a recognized human or external actor. It provides speaker
provenance and gates access through agent pairings, but it is not the durable
owner of a session or thread.

Use `agentKey` for Panda ownership. Use `identityId` for human/external-actor
provenance and access checks. See [Identity](./identity.md) and
[Sessions](./sessions.md).

## Session vs thread

A **session** is the durable runtime lane. Routes, heartbeat, watches, scheduled
tasks, runtime config, prompts, todos, and execution environments attach to the
session.

A **thread** is the current backing transcript/history for a session. `/reset`
can replace the thread while the session stays the same.

Target sessions in durable state. Resolve `session.current_thread_id` only at
the last responsible moment for delivery or model execution. See
[Sessions](./sessions.md).

## Connector account vs actor

A **connector account** is the configured external account, bot, mailbox, device,
or source that lets Panda talk to a service. It owns connector settings, routing
policy, and credential references.

An **actor** is the external sender or participant observed through that
connector: a phone number, chat id, email address, gateway device, or
similar service-native participant.

Do not treat a connector account as the human. Resolve the actor to an identity,
then check that identity's pairing to an agent.

Provisional note for #24: generic connector-account and conversation language is
the direction, but Telegram still has legacy compatibility behavior in places.
Not every channel has completed that migration. For new routing, prefer an
explicit connector account plus conversation target/binding; do not rely on
remembered-route or default-account guessing. See
[Identity](./identity.md), [Email](./email.md), and [WhatsApp](./whatsapp.md).

## Gateway vs control plane

The **gateway** is public ingress for registered external sources and devices. It
authenticates, validates, stores, guards, queues, and delivers external events.

The **control plane** is the operator/admin surface that configures agents,
sessions, routes, sources, policies, credentials, and execution environments.
Today that mostly means CLI/runtime services, not the public gateway request
path.

Keep public event handling in gateway/integration code. Keep configuration and
policy mutation in control-plane code. See [Gateway](./gateway.md) and
[Architecture](./architecture.md).

## Runner vs execution environment

A **runner** is the process or endpoint that executes work, such as a bash server,
watch runner, heartbeat runner, delivery worker, or channel sync loop.

An **execution environment** is the session-scoped boundary that chooses where
bash runs and which cwd/root, credentials, and tool policy apply.

A runner can serve or use an environment, but it is not the environment itself.
See [Execution Environments](./execution-environments.md).

## Worker vs subagent (provisional)

A **subagent** is the product/delegation noun for scoped delegated agent work.
Issue #16 is still open while implementation naming is unified.

Today Panda has two mechanisms: `spawn_subagent` starts an in-memory specialist
child run, while `worker_spawn` creates a durable environment-backed `worker`
session.

Use **worker** for current implementation mechanics only: `agent_sessions.kind =
"worker"`, worker tool/API names, filesystem roots, allowlists, and
execution-environment behavior. Do not use it as the preferred product noun for
delegated agents. See
[Execution Environments](./execution-environments.md#worker-controls) and
[Sessions](./sessions.md).

## Heartbeat vs watch

A **heartbeat** is a session-owned periodic wake. It gives the agent a chance to
notice time passing and decide whether to act.

A **watch** observes an external source, compares detector state, records a
durable event only when a real change is found, and then wakes the session.

Use heartbeat for cadence. Use watch for change detection. See
[Heartbeat](./heartbeat.md) and [Watches](./watches.md).

## Delivery vs message

A **message** is content in a transcript or channel history: human input, agent
output, A2A text, email, or another model-visible communication record.

A **delivery** is the transport/routing attempt that moves or injects content: an
outbound delivery row, gateway delivery, A2A delivery worker pass, email send, or
wake into the session's current thread.

Messages can be durable history. Deliveries are operational work and must
re-resolve the current session thread at delivery time. See
[Sessions](./sessions.md#routing), [A2A Messaging](./a2a.md), and
[Email](./email.md).

## Runtime context vs durable session/thread state

**Runtime context** is assembled for a particular wake/run. It includes the agent
key, session id, resolved current thread id, cwd, current input, and tool/model
context for this turn.

**Durable session state** is stored on session-owned tables: routes, runtime
config, prompts, todos, heartbeat, watches, schedules, and environment bindings.

**Durable thread state** is transcript/history and thread lifecycle state. Do not
put session-scoped knobs on threads, and do not assume runtime context fields are
automatically durable just because tools can read them.

See [Sessions: Runtime Context](./sessions.md#runtime-context) and
[Execution Environments](./execution-environments.md).
