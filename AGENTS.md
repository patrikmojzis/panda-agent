# Panda Agent Notes

## Source Of Truth

- For current behavior, trust code, tests, generated contracts, and CI before prose.
- Accepted ADRs are decisions. Start with `docs/developers/vocabulary.md`, `docs/developers/architecture.md`, `docs/developers/adr/0001-runtime-architecture-guardrails.md`, and the relevant subsystem doc.
- Plans, review chunks, issue notes, and dated inventories are historical context. Reverify them against the current tree before acting.
- Do not copy a command inventory into docs or prompts. Discover the current agent-facing surface with `pnpm --silent dev commands --output json` or `panda <group> ... --help --json`.

## Working Style

- Have opinions. Pick the simple lane and explain the tradeoff only when it matters.
- Keep Panda small, readable, and modular. Negative code wins when behavior stays clear.
- Prefer deep modules with narrow interfaces and local knowledge over pass-through abstractions.
- Before adding a helper, search `src/lib` and the local subsystem. Keep subsystem-only helpers local.
- Do not add catch-all `utils.ts`, `common`, or broad `shared` junk drawers.
- New shared helpers need short doc comments. Keep other comments for real architectural nuance, not play-by-play narration.
- Tests should protect behavior at the same seam callers use. Do not pin private wiring for its own sake.

## Core Model

- An `agent` is the Panda persona/runtime owner. It owns sessions, tools, skills, credentials, and automation.
- An `identity` is a recognized human or external actor. It provides provenance and access through agent pairing; it does not own sessions or threads.
- A `session` is the durable runtime lane. Routes, runtime config, prompts, todos, heartbeats, watches, scheduled tasks, and execution environments follow it.
- A `thread` is the replaceable transcript and execution backing for a session.
- `/reset` keeps the session and swaps `session.current_thread_id`.
- Durable work must target a session and resolve its current thread at the last responsible moment. Never retain a thread id across a wait, claim, or delivery that can race with `/reset`.
- A runner that claims durable work owns completion, skip, or failure for that claim.
- Branch sessions are not private ACL boundaries. Use a separate agent for private mental space.
- Subagents are constrained durable `agent_sessions.kind = "subagent"` lanes created from profiles and tool groups. Do not revive worker-era semantics or nested durable spawning.

## Runtime And Delivery

- `src/kernel/agent/Thread` owns the provider-neutral inner loop: runs, tools, hooks, context, transcript replay, compaction, and turn control.
- `src/domain/threads/runtime` owns persisted thread coordination, input delivery, and `queue`/`wake` behavior.
- `src/app/runtime` assembles the daemon, runtime modules, workers, and process lifecycle. Keep product logic out of assembly code.
- Panda is wake-driven at the system level. Local drain and agent loops may loop while processing bounded work; they are not a reason to create a permanently hot runtime loop.
- `queue` persists input for later. `wake` also makes the target runnable now.
- Persisted reads come from Postgres. Live mutations and orchestration go through the daemon. Neither the TUI nor a channel worker is a source of runtime truth.
- Channel ingress resolves connector actor -> identity -> agent pairing -> conversation session -> current thread.
- Panda-to-Panda delivery uses the A2A seam. Human delivery uses channel-specific command and adapter seams. Do not reintroduce a generic outbound router.
- Connector workers may share lifecycle/drain glue, but protocol parsing, media, auth, and delivery policy stay local to each integration.

## Architecture Rules

- Respect the import law in `docs/developers/architecture.md`. Run `pnpm architecture:import-law:ratchet` for changes that move imports or module ownership.
- `app` wires processes and runtime modules; `kernel` stays provider-neutral; `domain` owns business concepts; `integrations` owns external systems; `panda` owns the configured brain and policy; `ui` owns human-facing surfaces.
- `prompts` is model-facing text and pure rendering. No DB reads, env probing, shell calls, or hidden side effects.
- `lib` contains small project-agnostic helpers and generic local adapters, including generic Postgres primitives. It must not own Panda domain concepts or app assembly.
- Keep Postgres, channels, concrete providers, and Panda persona policy out of `kernel`.
- Use concrete leaf imports inside `src`. Add or expand barrels only for intentional package entrypoints listed in `package.json` and `docs/developers/architecture.md`.
- Use a local `Pick<Store, ...>` or equivalent narrow method slice when a caller needs only part of a store. Do not export a duplicate one-off interface unless another module consumes the same seam.
- One adapter is not evidence that an abstraction must exist. Add a seam when behavior genuinely varies or when it contains meaningful policy.

## Commands, Prompts, And Providers

- Distinguish direct model `Tool`s from Panda CLI Tools invoked through `panda ...`, usually via `bash`.
- The command module/catalog is the source of truth for agent-facing operations, descriptors, policy capabilities, and shim routes. The host CLI and Agent Command Shim are adapters at that seam.
- Do not restore removed compatibility aliases or maintain a parallel allowlist when command-module policy can project it.
- Keep direct tool and default prompt surfaces compact. Context/tool bloat and cache churn are product bugs; prefer stable defaults plus explicit discovery.
- Keep editable model-facing text in `src/prompts`, not buried in tools, runners, or runtime modules.
- Providers own API-specific payload construction and response normalization. Keep provider-specific shaping out of the core thread loop.
- Treat `src/kernel/transcript` changes as shared runtime work. Preserve the current persisted transcript shape unless the user explicitly requests a hard cut.

## Data And Security

- Panda is Postgres-first. Do not add portability abstractions without a real second adapter.
- Domain Postgres code owns schema, rows, and persistence policy. Generic query, transaction, relation, listen, bootstrap, and value helpers belong in `src/lib`; concrete Postgres details stay out of `kernel`.
- Privacy comes from database roles, scoped views, and explicit authority checks, not prompt instructions.
- Readonly model access must use scoped `session.*` views through the restricted readonly role, not raw `runtime.*` tables.
- Stored credentials require `CREDENTIALS_MASTER_KEY`. Never put secrets in watch configs, prompts, logs, docs, transcripts, or command output.
- Budget Postgres pools explicitly. New long-lived workers, `LISTEN` clients, or lease pools require env and docs updates.
- Public surfaces must authenticate, validate content type and input shape, enforce limits, and reserve durable state before waking a session.

## Verification

- Code changes: run `pnpm typecheck` and focused tests for the touched seam.
- Import/module changes: run `pnpm architecture:import-law:ratchet`.
- Command catalog or shim changes: run `pnpm agent-command-shim:check` and focused command tests.
- Prompt/context changes: run `pnpm ci:prompt-contracts` and focused prompt tests.
- Control UI changes: run `pnpm control:typecheck`; run `pnpm control:build` when the built surface changes.
- Runtime, tool, channel, app, or provider behavior: run `pnpm smoke` against a disposable `TEST_DATABASE_URL` when feasible.
- On smoke failure, inspect `.temp/runtime-smoke/.../summary.json` before raw logs.
- Docs-only changes: run `git diff --check` and verify every named path, command, and link against the current tree.
