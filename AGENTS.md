# Panda Agent Notes

## Working Style

- Have opinions. Pick the simple lane and explain the tradeoff only when it matters.
- Keep Panda small, readable, and modular. Negative code wins when behavior stays clear.
- Before adding a helper, search `src/lib` and the local subsystem. Reuse the boring thing that already exists.
- Put pure cross-domain helpers in focused `src/lib/*` files. Keep subsystem-only helpers local as narrow `shared.ts` files.
- Do not add catch-all `utils.ts` junk drawers.
- New shared helpers need short doc comments. Future-you is not magical.
- Keep comments for real architectural nuance, not play-by-play narration.
- If you are changing Panda internals, read the relevant doc under `docs/developers` first. Start with `docs/developers/architecture.md`.

## Core Model

- Panda has been deployed. Do not hand-wave compatibility or operator impact unless the user explicitly says this is throwaway work.
- `agent` = persona/brain.
- `identity` = person/access principal.
- `session` = durable runtime lane.
- `thread` = replaceable transcript/runtime backing for a session.
- The durable runtime anchor is the `session`, not identity and not raw thread.
- `/reset` keeps the session and swaps `session.current_thread_id`.
- Heartbeats, watches, scheduled tasks, channel bindings, route memory, and A2A binds follow sessions and resolve the current thread at fire/receive time.
- Branch sessions are not private ACL boundaries. Use a separate agent for private mental space.

## Runtime Boundaries

- `Thread` is the inner loop: runs, tools, hooks, context, transcript replay, compaction, and turn control.
- The outer wake-driven runtime lives in `src/app/runtime` and should stay separate from the kernel.
- Panda is wake-driven, not a hot `while (true)` loop. Inputs, resumes, heartbeats, watches, scheduled tasks, app actions, gateway events, and manual pokes wake a session/thread.
- `queue` and `wake` are different delivery modes. Queue persists for later; wake makes the session runnable now.
- Persisted reads should come from Postgres. Live orchestration should go through the daemon.
- Do not make the TUI or any channel worker the runtime source of truth.

## Source Layout

- `src/app`: entrypoints, process lifecycle, daemon/runtime assembly, CLI wiring.
- `src/kernel`: inner agent loop and provider-neutral execution primitives.
- `src/panda`: Panda persona/tool/context/subagent wiring.
- `src/prompts`: editable model-facing text, wrappers, channel prompts, runtime prompts, templates.
- `src/domain`: business concepts: agents, identity, sessions, threads, scheduling, channels, credentials, apps, watches, gateway, wiki.
- `src/integrations`: external systems: providers, Telegram, WhatsApp, email, Postgres-facing adapters, shell, browser, apps, gateway, wiki.
- `src/ui`: terminal and observe surfaces.
- `src/lib`: tiny pure helpers only.
- There is no `src/personas` lane now. Use `src/panda` and the `panda/panda` package subpath.

## Prompt And Provider Rules

- Keep model-facing prompt text in `src/prompts`, not buried in services, tools, or runners.
- Providers own API-specific payload construction and response normalization.
- Keep provider-specific request/response shaping out of the core thread loop.
- `src/kernel/transcript` exists now. Treat transcript/compaction/replay changes as shared runtime work and keep them compatible with current persisted transcript shape unless asked to do a hard cut.
- Prompt/tool context bloat is a product bug. Prefer compact defaults plus explicit lookup tools.

## Data And Security

- Panda is Postgres-first. Do not cosplay portability.
- Use one shared Panda database, one app role, and one restricted readonly role. Wiki.js gets its own role/database.
- `postgres_readonly_query` should read scoped `session.*` views through `READONLY_DATABASE_URL`, not raw `runtime.*` tables.
- Privacy comes from DB roles and scoped views, not prompt instructions.
- The app role must own or be able to create/alter the `runtime` and `session` schemas.
- Budget Postgres pools explicitly. New long-lived workers, `LISTEN` clients, or lease pools need env/docs updates.
- Stored credentials require `CREDENTIALS_MASTER_KEY`. Do not paste secrets into watch configs, logs, docs, or transcript text.

## Tool And Channel Rules

- Panda-to-Panda uses `message_agent`. Human/channel outbound uses `outbound`. Email uses `email_send`.
- Do not tunnel A2A through `outbound`; Panda blocks that for a reason.
- Channel ingress resolves actor -> identity -> agent pairing -> conversation session -> current thread.
- Watches are deterministic code probes. The model reacts only after code detects and persists a real change.
- For watches, use `watch_schema_get` when branch fields matter. Do not invent custom probes or a fake `watch_list` tool.
- Apps are filesystem-backed SQLite micro-apps under the agent home. Prefer `native+wake` for user-facing writes.
- Use `app_link_create` for public app opens. Do not paste raw identity ids/handles into public URLs.
- Gateway is the public server-to-server ingress, separate from core. Public gateway deployments need TLS termination, IP allowlist, trusted proxy handling, and `GATEWAY_GUARD_MODEL`.

## Verification

- For code changes, run `pnpm typecheck` and focused tests for the touched area.
- For runtime, prompt, tool, channel, app, or provider behavior, run a live smoke with `pnpm smoke` against `TEST_DATABASE_URL` when feasible.
- On smoke failure, inspect `.temp/runtime-smoke/.../summary.json` first. It usually beats spelunking raw logs.
- Docs-only changes do not need a live Panda smoke; use `git diff --check` and keep links/paths honest.

## Local Worktree Rules

- If you are in `/Users/patrikmojzis/.codex/worktrees/*/panda-agent`, do not install node modules. Use the main checkout at `~/Projects/panda-agent` for installed deps and `.env`.
- Source env from `~/Projects/panda-agent/.env` only when needed, and never print secrets.
- `.env.codex` has prod readonly DB access as `PROD_READONLY_DB_URL`. Treat it as read-only unless the user explicitly asks for a write.
