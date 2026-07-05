# Watches

Watches are Panda's deterministic polling layer.

The LLM is not involved in detection.
It only runs after code has already observed a real change and persisted a durable event.

## Shape

Core files:

- `src/domain/watches/types.ts`
- `src/domain/watches/store.ts`
- `src/domain/watches/postgres.ts`
- `src/domain/watches/postgres-schema.ts`
- `src/domain/watches/evaluator.ts`
- `src/domain/watches/runner.ts`
- `src/domain/watches/commands.ts`
- `src/prompts/runtime/watch-events.ts`

## Runtime Flow

The hot path is:

1. `WatchRunner` lists due watches
2. store claims one watch and creates a `watch_runs` row in `claimed`
3. runner resolves the watch session and reads `session.current_thread_id` for evaluator/run context
4. the evaluator resolves the source and normalizes it into one of:
   - `collection`
   - `snapshot`
   - `scalar`
5. the domain evaluator compares that observation against stored watch state
6. if changed, runner re-resolves `session.current_thread_id` for delivery
7. store records a durable `watch_events` row for that delivery thread
8. runner injects one synthetic `watch_event` input into the delivery thread with `wake`
9. Panda sees the structured watch-event prompt and decides whether to notify or act

That separation is the whole point.
Don't blur it.

## Persistence

Tables:

- `runtime.watches`
- `runtime.watch_runs`
- `runtime.watch_events`

Readonly views:

- `session.watches`
- `session.watch_runs`
- `session.watch_events`

The watch row stores config plus detector state.
Runs are execution history.
Events are durable emitted changes.
Postgres schema creation, migrations, and integrity checks live in
`src/domain/watches/postgres-schema.ts`; `PostgresWatchStore` should stay focused
on watch behavior and row persistence.

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

- watch mutations preflight through the real evaluator before persistence
- enabled creates and enabled source/detector resets can seed state at write time
- first successful runner poll ignores existing state when no seed is present
- delivery is wake-only
- watch commands create watches for the current session automatically
- changed-event delivery resolves the current thread dynamically from the session after evaluation

## Schema Discovery

`panda watch create --help --json` and `panda watch update --help --json` expose
the detailed source and detector schema catalog. The old model-facing
`watch_schema_get` escape hatch is gone.

The command validators still need to enforce the same invalid-config rules as
the persisted domain parser in `src/domain/watches/config.ts`; otherwise bad
watch config can be written and only fail later when Postgres rows are read.

This is a command-help contract, not a second schema source:

- help exists because agents need discoverable branch schemas without dumping
  every watch schema into prompt context
- watches are unusually expensive because source and detector branches are large unions
- the real long-term fix is transport-level discovery or CLI-style help, not a family of `*_schema_get` tools

Do not copy this pattern for unrelated tools unless we revisit the transport design first.

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
