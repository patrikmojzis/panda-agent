# Panda Architecture

Panda should be organized by role in the system, not by "stuff we share sometimes."

The target buckets are:

- `app`: entrypoints, process lifecycle, runtime assembly, CLI wiring
- `kernel`: the inner agent loop and provider-neutral execution primitives
- `personas`: persona packs like Panda prompt, tools, contexts, and subagent policy
- `domain`: business concepts like agents, identity, threads, scheduling, and channel records
- `integrations`: external systems like providers, Telegram, WhatsApp, Postgres, shell
- `ui`: terminal and other human-facing surfaces
- `lib`: small pure helpers

## Import Law

Keep the dependency direction boring.

- `lib` imports nothing project-specific
- `kernel` may import `lib`
- `domain` may import `kernel` and `lib`
- `integrations` may import `domain`, `kernel`, and `lib`
- `personas` may import `domain`, `kernel`, `integrations`, and `lib`
- `ui` may import `app`, `personas`, `domain`, `kernel`, and `lib`
- `app` may import anything

If a lower layer needs something from a higher layer, that is a design smell, not a cute exception.

## Bucket Rules

### `app`

Put startup and orchestration here.

- CLI entrypoints
- daemon bootstrap
- runtime composition
- process shutdown handling

Do not hide core logic here. `app` should wire parts together, not become the product.

### `kernel`

This is the engine room.

- thread loop
- run pipeline
- tool contract
- hook contract
- context contract
- provider-neutral runtime types

Keep `kernel` boring and reusable. No Postgres. No Telegram. No Panda persona details. No process env policy.

### `personas`

A persona is a configured brain, not the runtime.

Put here:

- prompt and persona defaults
- tool selection and policy
- persona contexts
- subagent policy

Do not put daemon wiring, DB pool setup, or connector boot code here.

### `domain`

This is Panda's actual business model.

Put here:

- agents
- identity
- threads
- scheduling
- channel records and queue semantics

This layer owns names and concepts. It should not know how Telegram polls or how Anthropic formats a request.

### `integrations`

Anything that touches the outside world lives here.

Put here:

- model providers
- Telegram and WhatsApp adapters
- Postgres plumbing
- shell and remote runner glue

Keep API-specific payload shaping here. Do not leak it into the thread loop.

### `ui`

Human-facing surfaces.

- TUI rendering
- chat commands
- view formatting

The UI can talk to the app layer, but it should not become the runtime source of truth.

### `lib`

`lib` is for tiny, pure, boring helpers.

- text helpers
- time helpers
- ids
- collections
- formatting
- parsing

If a file touches Postgres, process env, channels, providers, threads, or persona state, it does not belong in `lib`.

## Explicit Calls

These are not "maybe later" ideas. They are structure rules.

- No top-level `common`. It will become a junk drawer.
- Kill `pi` as a folder name. It says nothing.
- Keep barrel files only at real public boundaries.
- Do not promote code to shared/global just because two files use it.
- Prefer fewer files when an abstraction is fake.

## Supported Entry Points

These are the source barrels that still deserve to exist:

- `src/index.ts`
- `src/app/runtime/index.ts`
- `src/kernel/agent/index.ts`
- `src/personas/panda/index.ts`
- `src/domain/agents/index.ts`
- `src/domain/identity/index.ts`
- `src/domain/channels/index.ts`
- `src/domain/threads/index.ts`
- `src/domain/scheduling/index.ts`

`src/index.ts` is the package root.
Do not re-export domain repos, stores, channel integrations, or other internal plumbing from it unless we intentionally want that to become package API.

The supported package entrypoints are:

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
- `panda/domain/threads/home`
- `panda/domain/threads/requests`
- `panda/domain/threads/runtime`
- `panda/domain/scheduling`
- `panda/domain/scheduling/tasks`
- `panda/integrations/shell`

Use the root for the normal public API.
Use the subpath exports only when you intentionally need a secondary boundary.

Leaf-folder barrels are gone on purpose.
If you feel tempted to add `tools/index.ts` or `contexts/index.ts` again, don't.

## Postgres Rule

Panda is Postgres-first. Do not cosplay portability.

- If a repo abstraction is buying us nothing, collapse it.
- Prefer `repo.ts` over `store.ts` plus `postgres.ts` when there is only one real implementation.
- Keep concrete Postgres details out of `kernel`.

The short version:

- `store.ts` means a real contract with multiple meaningful consumers
- `repo.ts` means a concrete persistence API
- `postgres.ts` should survive only when the file is actually exposing a domain boundary that still wants that name

Pragmatism wins over purity here. The goal is less indirection, not prettier indirection.

## Smell List

Stop and rethink if you see one of these:

- `personas` importing `app`
- `kernel` importing provider or channel code
- `domain` importing Telegram or WhatsApp code
- folders named `common`, `shared`, or `utils` filling with mixed junk
- one-implementation interfaces surviving out of habit
- barrel files forcing readers to play import roulette
