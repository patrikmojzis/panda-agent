# Watches

Watches are Panda's deterministic polling layer.

The LLM is not involved in detection.
It only runs after code has already observed a real change and persisted a durable event.

## Shape

Core files:

- `src/domain/watches/types.ts`
- `src/domain/watches/store.ts`
- `src/domain/watches/postgres.ts`
- `src/domain/watches/evaluator.ts`
- `src/integrations/watches/evaluator.ts`
- `src/domain/watches/runner.ts`
- `src/personas/panda/tools/watch-tools.ts`
- `src/prompts/runtime/watch-events.ts`

## Runtime Flow

The hot path is:

1. `WatchRunner` lists due watches
2. store claims one watch and creates a `watch_runs` row in `claimed`
3. runner resolves the watch session and reads `session.current_thread_id`
4. the integrations evaluator resolves the source and normalizes it into one of:
   - `collection`
   - `snapshot`
   - `scalar`
5. the domain evaluator compares that observation against stored watch state
6. if changed, store records a durable `watch_events` row
7. runner injects one synthetic `watch_event` input into the resolved thread with `wake`
8. Panda sees the structured watch-event prompt and decides whether to notify or act

That separation is the whole point.
Don't blur it.

## Persistence

Tables:

- `thread_runtime_watches`
- `thread_runtime_watch_runs`
- `thread_runtime_watch_events`

Readonly views:

- `panda_watches`
- `panda_watch_runs`
- `panda_watch_events`

The watch row stores config plus detector state.
Runs are execution history.
Events are durable emitted changes.

Watches are session-owned:

- `watches.session_id` is the durable anchor
- runs and events store both `session_id` and the resolved thread id used at fire time

## Security Boundaries

- watch config stores credential refs, never resolved secrets
- credentials resolve through the existing credential resolver at runtime
- HTTP adapters go through Panda's safe fetch path
- Mongo is JSON-configured only
- SQL is single-statement only and executes inside a read-only transaction
- IMAP opens the mailbox read-only

If you add a new adapter, keep it deterministic and code-only.
No pre-event LLM "classification" nonsense.

## Current V1 Scope

Adapters:

- `mongodb_query`
- `sql_query`
- `http_json`
- `http_html`
- `imap_mailbox`

Detectors:

- `new_items`
- `snapshot_changed`
- `percent_change`

Defaults:

- first successful run ignores existing state
- delivery is wake-only
- watch tools create watches for the current session automatically
- the runner resolves the current thread dynamically from that session

## Design Rules

- keep source resolution out of the runner
- keep source adapters in `src/integrations/watches`, not `src/domain/watches`
- keep detector logic pure and testable
- keep secrets out of rows, events, transcript metadata, and logs
- prefer extending the observation model over sprinkling adapter-specific comparisons everywhere
- if a feature needs arbitrary user code, that is a different runtime and should stay separate

## Known Intentional Omissions

Not in v1:

- custom probe runtime
- webhook ingestion
- browser automation adapters
- cron watch schedules
- queue or digest delivery modes
- model-visible watch listing

Those can come later without changing the core contract:
"code detects change first, Panda reacts second."
