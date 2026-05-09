# Panda Structure

The hard-cut refactor is done.

`src/features` is gone.
This file is the current shape, not a migration fantasy.

## Current Tree

```text
src/
  app/
    health/
    runtime/
    smoke/
    cli.ts

  kernel/
    agent/
    models/
    transcript/

  panda/
    contexts/
    subagents/
    tools/

  prompts/
    channels/
    contexts/
    runtime/
    templates/

  domain/
    a2a/
    agents/
    apps/
    channels/
    connector-leases/
    credentials/
    email/
    gateway/
    identity/
    scheduling/
    sessions/
    telepathy/
    threads/
    watches/
    wiki/

  integrations/
    apps/
    browser/
    channels/
    gateway/
    providers/
    shell/
    telepathy/
    watches/
    wiki/

  ui/
    observe/
    shared/
    tui/

  lib/
  index.ts
```

## What Lives Where

- `app`: CLI entrypoint, process lifecycle, daemon/runtime assembly, smoke harness.
- `kernel`: the inner agent loop and provider-neutral execution pieces.
- `panda`: Panda tool policy, contexts, subagents, defaults, and persona wiring.
- `prompts`: editable model-facing text, wrappers, channel prompts, runtime prompts, templates.
- `domain`: Panda concepts like agents, identities, sessions, threads, credentials, scheduling, channels, apps, watches, gateway, and wiki bindings.
- `integrations`: external systems like providers, browser, shell, Telegram, WhatsApp, email, gateway HTTP, apps, wiki, and watch adapters.
- `ui`: terminal-facing chat, observe, and shared UI surfaces.
- `lib`: tiny pure helpers.

## Public Boundaries

These source barrels still earn their keep:

- `src/index.ts`
- `src/app/runtime/index.ts`
- `src/kernel/agent/index.ts`
- `src/panda/index.ts`
- `src/domain/agents/index.ts`
- `src/domain/identity/index.ts`
- `src/domain/sessions/index.ts`
- `src/domain/channels/index.ts`
- `src/domain/channels/actions/index.ts`
- `src/domain/channels/deliveries/index.ts`
- `src/domain/threads/index.ts`
- `src/domain/threads/requests/index.ts`
- `src/domain/threads/runtime/index.ts`
- `src/domain/scheduling/index.ts`
- `src/domain/scheduling/tasks/index.ts`
- `src/domain/watches/index.ts`
- `src/integrations/shell/index.ts`

The package entrypoints mirror the real public boundaries:

- `panda`
- `panda/app/runtime`
- `panda/kernel/agent`
- `panda/panda`
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
- `panda/domain/watches`
- `panda/integrations/shell`

Everything else should prefer direct file imports.
Do not bring back bounce-only barrels.

Internal on purpose:

- `domain/credentials` is runtime plumbing for Panda itself, not a package surface.
- `domain/sessions` has a source barrel for internal wiring, but it is not exported as a package subpath yet.
- `domain/threads/conversations` and `domain/threads/routes` stay behind `domain/threads` or `domain/sessions`.
- `prompts/**` is editable source-of-truth for model text, but not package API.
- Panda leaf files like `src/panda/tools/bash-tool.ts`, `src/panda/tools/env-value-tools.ts`, and `src/panda/tools/web-fetch-tool.ts` stay behind `src/panda/index.ts`.
- Panda helpers like `src/panda/subagents/service.ts` stay internal even though the `panda` barrel is public.

## Repo Vs Store

`store.ts` means a real behavior contract with meaningful consumers.

`repo.ts` means a concrete persistence API with no fake flexibility.

If a second implementation becomes real later, earn the abstraction then.
Not before.

Rules:

- Prefer `repo.ts` over `store.ts` plus `postgres.ts` when Postgres is the only real implementation.
- Keep concrete Postgres details out of `kernel`.
- Do not hide concrete Postgres code behind interface theater if nothing else implements it.

## Import Rules

- Prefer direct imports inside the same area.
- Use a barrel only when it is a real boundary or package surface.
- Do not add nested `index.ts` files for `tools`, `contexts`, `subagents`, or tiny leaf folders.
- If you are editing wording, go to `src/prompts`, not a runner or service file.

## Direction That Won

- `session` is the durable runtime unit.
- `thread` is replaceable backing history for a session.
- `identity` is the person/access principal.
- `agent` is the persona.
- editable prompt text lives in `prompts`.
- Panda persona/tool/context wiring lives in `src/panda`.
- providers shape provider payloads.
- `Thread` owns the inner loop.
- runtime wiring stays in `app`.
- connectors stay in `integrations`.

## Verification Rule

After each structural pass:

- run `pnpm typecheck`
- run focused tests for the touched area
- run a live Panda smoke when runtime behavior changed

Do not stack refactors and hope. That is how you end up excavating your own mess later.
