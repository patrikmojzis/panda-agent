# Panda Structure

The hard-cut refactor is done.

`src/features` is gone.
This file is the current shape, not a migration fantasy.

## Current Tree

```text
src/
  app/
    cli.ts
    runtime/

  kernel/
    agent/
    models/
    transcript/

  prompts/
    channels/
    contexts/
    runtime/
    templates/

  personas/
    panda/
      contexts/
      subagents/
      tools/

  domain/
    agents/
    channels/
      actions/
      cursors/
      deliveries/
    identity/
    scheduling/
      heartbeats/
      tasks/
    threads/
      conversations/
      home/
      requests/
      routes/
      runtime/

  integrations/
    channels/
      telegram/
      whatsapp/
    providers/
      shared/
    shell/

  ui/
    tui/

  index.ts
```

## What Lives Where

- `app`: CLI entrypoint and runtime assembly
- `kernel`: the inner agent loop and provider-neutral execution pieces
- `prompts`: editable model-facing text, wrappers, and default templates
- `personas`: Panda tool policy, contexts, subagents, and persona wiring
- `domain`: Panda concepts like identities, agents, threads, scheduling, and channel records
- `integrations`: Telegram, WhatsApp, provider adapters, and shell glue
- `ui`: terminal-facing chat surface

## Public Boundaries

These barrels still earn their keep:

- `src/index.ts`
- `src/app/runtime/index.ts`
- `src/kernel/agent/index.ts`
- `src/personas/panda/index.ts`
- `src/domain/agents/index.ts`
- `src/domain/identity/index.ts`
- `src/domain/sessions/index.ts`
- `src/domain/channels/index.ts`
- `src/domain/threads/index.ts`
- `src/domain/scheduling/index.ts`
- `src/domain/channels/actions/index.ts`
- `src/domain/channels/deliveries/index.ts`
- `src/domain/threads/requests/index.ts`
- `src/domain/threads/runtime/index.ts`
- `src/domain/scheduling/tasks/index.ts`
- `src/integrations/shell/index.ts`

The package entrypoints mirror those real boundaries:

- `panda`
- `panda/app/runtime`
- `panda/kernel/agent`
- `panda/personas/panda`
- `panda/domain/agents`
- `panda/domain/identity`
- `panda/domain/channels`
- `panda/domain/channels/actions`
- `panda/domain/channels/deliveries`
- `panda/domain/threads`
- `panda/domain/threads/requests`
- `panda/domain/threads/runtime`
- `panda/domain/scheduling`
- `panda/domain/scheduling/tasks`
- `panda/integrations/shell`

Everything else should prefer direct file imports.
We already deleted the bounce-only barrels. Do not bring them back.

Internal on purpose:

- `domain/credentials` is runtime plumbing for Panda itself, not a package surface
- `domain/threads/conversations` and `domain/threads/routes` stay behind `domain/threads`
- `prompts/**` is editable source-of-truth for model text, but still internal repo structure, not package surface
- persona leaf files like `tools/bash-tool.ts`, `tools/env-value-tools.ts`, and `tools/web-fetch.ts` stay behind `personas/panda`
- persona helpers like `subagents/service.ts` and `message-preview.ts` stay internal even though the `personas/panda` barrel stays public

## Repo Vs Store

`store.ts` now means a real behavior contract.

Keep these as stores:

- `AgentStore`
- `IdentityStore`
- `HomeThreadStore`
- `ThreadRuntimeStore`
- `ScheduledTaskStore`
- `ChannelActionStore`
- `OutboundDeliveryStore`

`repo.ts` now means a concrete persistence API with no fake flexibility.

These are repos:

- `DaemonStateRepo`
- `ChannelCursorRepo`
- `ConversationRepo`
- `RuntimeRequestRepo`
- `SessionRouteRepo`

If a second implementation becomes real later, earn the abstraction then.
Not before.

## Import Rules

- Prefer direct imports inside the same area.
- Use a barrel only when it is a real boundary or package surface.
- Do not add nested `index.ts` files for `tools`, `contexts`, `subagents`, or tiny leaf folders.
- Do not hide concrete Postgres code behind interface theater if nothing else implements it.
- If you are editing wording, go to `src/prompts`, not a runner or service file.

## Direction That Won

- `thread` is the durable unit
- `identity` is the person
- `agent` is the persona
- editable prompt text lives in `prompts`
- providers shape provider payloads
- `Thread` owns the inner loop
- runtime wiring stays in `app`
- connectors stay in `integrations`

## Verification Rule

After each structural pass:

- run `pnpm typecheck`
- run focused tests for the touched area
- run a live Panda smoke

Do not stack refactors and hope. That is how you end up excavating your own mess later.
