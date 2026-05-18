# Architecture Next Steps TODO

These are the next cleanup chunks worth doing after the recent architecture refactor. Work one item at a time; keep the interface small, preserve security-sensitive behavior, and verify through public seams.

## 1. [x] Split The Worktree Into Reviewable Architecture Chunks

- Reason: the current diff is too large to trust as one review unit.
- Do: separate runtime/session delivery, public surfaces, Postgres stores, channels, tests, and docs into reviewable chunks.
- Avoid: mixing unrelated cleanup into behavior-sensitive patches.
- Context: added `docs/developers/architecture-review-chunks.md` as the review manifest for this broad refactor. It splits the work into docs/entrypoints, session delivery, runtime daemon, Postgres stores, public surfaces, channels, Panda/browser cleanup, and test/import-law/ADR chunks with focused review questions and verification commands.

## 2. [x] Lock Down Supported Entry Points

- Reason: deleted barrels and fake exports can quietly come back if nothing enforces the intended package surface.
- Do: extend package/export tests around the supported entrypoint list in `docs/developers/architecture.md`.
- Avoid: freezing internal helper modules that should stay local.
- Context: `tests/package-exports.test.ts` now derives expected package exports from `docs/developers/architecture.md` and checks documented source barrels against documented package entrypoints. `src/domain/sessions/index.ts` remains source-supported but not package-exported by design.

## 3. [x] Finish Session-Owned Delivery Consolidation

- Reason: scheduled tasks, watches, heartbeats, email sync, gateway, telepathy, app wakes, and daemon request paths all need the same rule: resolve the session current thread at delivery time.
- Do: deepen the current-thread delivery module so callers get more leverage from one small seam.
- Avoid: building a generic delivery framework; keep the module boring and explicit.
- Context: `src/domain/sessions/current-thread.ts` now has direct behavior coverage for blank sessions, live daemon submission, and queued store delivery. `docs/developers/sessions.md` documents when to use `resolveCurrentSessionThread`, `submitCurrentSessionInput`, and `enqueueCurrentSessionInput`, so `/reset`-safe delivery stays concentrated in one explicit seam.

## 4. [x] Run A Public-Surface Security Pass

- Reason: gateway, telepathy, and micro-apps carry sensitive personal data and sit on public or semi-public ingress paths.
- Do: verify token handling, trusted proxy assumptions, body limits, CSRF/cookie locality, raw-content quarantine, and current-thread delivery.
- Avoid: speculative hardening churn; patch proven risk or unclear invariants.
- Context: reviewed gateway, telepathy, and micro-app HTTP seams against the public-surface architecture rules. The concrete patch tightened gateway body admission so OAuth token requests require `application/x-www-form-urlencoded` or `application/json`, event requests require `application/json`, and unsupported content types fail before body parsing.

## 5. [x] Delete Useless Tests

- Reason: implementation-detail tests make future refactors harder while adding little confidence.
- Do: delete tests that only assert private wiring, and replace valuable cases with behavior tests at the module interface.
- Avoid: deleting coverage around sensitive behavior without replacing the observable guarantee.
- Context: removed the redundant schema test that only mirrored `z.toJSONSchema()` and rewrote the remaining schema check around Panda's actual guarantee: intentionally open Zod object schemas must not be forced closed by the tool-schema wrapper.

## 6. [x] Continue Store-Slice Cleanup

- Reason: exported one-off `Pick<>` aliases look like intentional public seams even when only one module uses them.
- Do: keep narrow store slices local unless another real module consumes the seam.
- Avoid: hiding legitimate shared seams such as app or gateway session context.
- Context: private store slices were kept local in worker/session, scheduling, watch runner, email sync/outbound/send, watch tools, and execution-environment lifecycle code. Shared seams such as app/gateway session context and worker purge environment stopping stay exported because other modules genuinely consume them.

## 7. [x] Review Postgres Store And Schema Modules

- Reason: schema, row parsing, transaction, and LISTEN responsibilities have been split apart, so drift is easy.
- Do: inspect one domain store at a time and keep DDL, row parsing, and mutation logic in the documented modules.
- Avoid: broad DB rewrites; each chunk needs focused Postgres tests.
- Context: reviewed the gateway Postgres split. `postgres-schema.ts` now repairs missing `metadata` columns on older gateway event/strike tables, while `postgres.ts` keeps mutation logic and `postgres-rows.ts` keeps row parsing. `tests/gateway.test.ts` covers the migration repair path.

## 8. [x] Simplify Channel Worker Modules

- Reason: Telegram, WhatsApp, email, A2A, actions, and outbound delivery still have similar lifecycle and delivery patterns.
- Do: remove duplicated lifecycle glue where a shared module already earns depth and locality.
- Avoid: flattening provider-specific protocol behavior into fake shared abstractions.
- Context: `src/integrations/channels/worker-runtime.ts` now owns connector-wide outbound failure logging and Postgres notification listener failure handling. Telegram and WhatsApp keep their protocol-specific adapters/actions local, but no longer duplicate the identical outbound worker and LISTEN recovery glue.

## 9. [x] Add An Import Law Check

- Reason: `docs/developers/architecture.md` now defines dependency direction, but prose alone will not stop drift.
- Do: start with a report-only import check, then make it fail once the current code is clean.
- Avoid: blocking useful transitional work too early.
- Context: added `pnpm architecture:import-law`, a deterministic report-only checker for static relative imports under `src`. It currently reports remaining dependency-direction violations without failing the suite, so cleanup can proceed by area before hard enforcement.

## 10. [x] Final ADR And Context Pass

- Reason: some decisions now deserve durable documentation: session as wake anchor, public-surface security rules, drain loop reuse, supported barrels, and Postgres schema/store split.
- Do: write ADRs only for decisions future architecture reviews must not reopen casually.
- Avoid: writing commandments before the code has settled.
- Context: added `docs/developers/adr/0001-runtime-architecture-guardrails.md` to record the settled guardrails: session-owned delivery, public body admission, shared connector lifecycle glue, Postgres module responsibility split, explicit entrypoints, and behavior-focused tests. The developer docs index and architecture overview now point to it.
