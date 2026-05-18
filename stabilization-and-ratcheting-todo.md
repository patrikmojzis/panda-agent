# Stabilization And Ratcheting TODO

This is the next phase after the broad architecture cleanup. The goal is not another open-ended refactor loop. The goal is to make the architecture reviewable, enforceable, and safe to merge.

Current local signal:

- `pnpm architecture:import-law` reports 30 dependency-direction violations.
- The broad refactor is already split for review in `docs/developers/architecture-review-chunks.md`.
- Durable decisions are recorded in `docs/developers/adr/0001-runtime-architecture-guardrails.md`.

Work one item at a time. Do not mix unrelated cleanup into these chunks.

## Ground Rules

- Keep each chunk small enough to review in one sitting.
- Prefer shrinking a module's interface over adding another seam.
- Preserve the ADR guardrails: session-owned delivery, public body admission, connector lifecycle locality, Postgres module responsibility split, explicit entrypoints, and behavior-focused tests.
- Public gateway, telepathy, and micro-app changes require security-minded review.
- Postgres schema changes require migration/backfill reasoning and focused tests.
- Import-law cleanup should reduce or freeze violations; it must not hide violations behind vague exceptions.

## 0. [x] Freeze Opportunistic Cleanup

**Scope**

- No code files unless the change directly supports one of the items below.
- Allowed edits: review notes, import-law ratchet, focused P0/P1 fixes, public-surface security fixes, and clear dead-code removals discovered during a focused chunk.

**Why**

The branch is already broad. More unrelated cleanup makes review worse, even when the individual changes are good.

**Why not**

Stopping cleanup feels slower, but it prevents the branch from turning into an unreviewable pile of good intentions.

**Done when**

- Every new edit can be assigned to one item in this file or one review chunk in `docs/developers/architecture-review-chunks.md`.

**Completed context**

- 2026-05-18: New edits are scoped to this ratchet list. Opportunistic cleanup is frozen; each chunk below must carry its own verification before the next chunk starts.

## 1. [x] Add An Import-Law Baseline Ratchet

**Scope**

- `scripts/import-law-report.mjs`
- `package.json`
- a small baseline file, for example `scripts/import-law-baseline.json`
- focused script tests if the repo has a suitable script-test pattern

**Problem**

The import-law check currently reports 30 violations but exits successfully. That is useful visibility, but it does not stop drift.

**Small steps**

- Capture the current 30 violations as an explicit baseline.
- Teach the script to fail only when a new violation appears outside the baseline.
- Keep the report readable: print baseline count, new violations, and fixed baseline entries.
- Add a command such as `pnpm architecture:import-law:ratchet` if preserving the report-only command is useful.
- Document how to update the baseline after a cleanup chunk reduces violations.

**Why**

This gives immediate protection without forcing all 30 violations to be fixed in one noisy patch.

**Why not**

Do not hard-fail on zero violations yet. That would turn one architectural cleanup into a giant forced migration.

**Verification**

- `pnpm architecture:import-law`
- ratchet command, if added
- `pnpm typecheck`

**Done when**

- New dependency-direction violations fail locally.
- Existing 30 baseline violations remain visible.
- Removing one baseline violation is reported as progress, not as noise.

**Completed context**

- 2026-05-18: Added `scripts/import-law-baseline.json`, kept `pnpm architecture:import-law` as a readable report, added `pnpm architecture:import-law:ratchet` for merge gating, and documented baseline shrinking in `docs/developers/architecture.md`.

## 2. [x] Remove Kernel Transcript Imports From Domain Runtime

**Scope**

- `src/kernel/transcript/compaction.ts`
- `src/kernel/transcript/inference-projection.ts`
- `src/domain/threads/runtime/types.ts`
- nearby transcript/kernel types as needed

**Problem**

`kernel` imports `domain/threads/runtime/types`. That points the wrong way. Kernel owns provider-neutral execution and transcript concepts; domain runtime should adapt persisted records to kernel concepts.

**Small steps**

- Identify the exact types imported from `src/domain/threads/runtime/types.ts`.
- Move provider-neutral transcript/message role types into `src/kernel/transcript` or `src/kernel/agent`.
- Keep Postgres row shapes and persistence-specific types in `domain/threads/runtime`.
- Update domain runtime to import the kernel-owned types.
- Keep persisted transcript compatibility intact.

**Why**

This is the smallest high-leverage import-law cleanup. It improves locality around transcript semantics and makes the import law credible.

**Why not**

Do not redesign compaction or transcript persistence in this chunk. This is a direction fix, not a transcript rewrite.

**Verification**

- `pnpm vitest run tests/thread.test.ts tests/thread-runtime.test.ts tests/thread-runtime-postgres.test.ts tests/provider-runtime.test.ts`
- `pnpm typecheck`
- `pnpm architecture:import-law`

**Done when**

- No `kernel -> domain` import-law violations remain.
- Transcript tests still prove replay/compaction behavior.

**Completed context**

- 2026-05-18: Moved provider-neutral transcript record, projection, and auto-compaction state types into `src/kernel/transcript/types.ts`; domain runtime now re-exports those types instead of owning them. Removed both `kernel -> domain` import-law violations and shrank the baseline to 28.

## 3. [x] Move Domain CLI Assembly Toward App

**Scope**

- `src/domain/agents/cli.ts`
- `src/domain/agents/legacy-import.ts`
- `src/domain/gateway/cli.ts`
- `src/domain/sessions/cli.ts`
- later, other `src/domain/**/cli.ts` files if the pattern repeats
- app CLI composition files

**Problem**

Domain CLI files import `app` and sometimes `integrations`. That makes domain modules carry process bootstrap, env, DB setup, and server wiring. The module interface becomes dishonest: it looks like domain, but callers must understand app assembly.

**Small steps**

- Pick one CLI file first. Start with `src/domain/gateway/cli.ts` only if you are ready for gateway security review; otherwise start with `src/domain/agents/cli.ts`.
- Extract domain operations into a small domain-facing module if needed.
- Move command assembly, DB bootstrap, env options, and process wiring into `src/app`.
- Leave domain modules with business operations and record parsing only.
- Update command registration imports.

**Why**

This pays down many `domain -> app` violations while improving locality: app wires, domain models.

**Why not**

Do not move every CLI at once. CLI code touches operator commands and can hide behavior changes in noisy import churn.

**Verification**

- Focused CLI tests for the command moved.
- Relevant domain tests.
- `pnpm typecheck`
- `pnpm architecture:import-law`

**Done when**

- The chosen domain CLI no longer imports `app` or `integrations`.
- Command behavior and operator flags stay unchanged.

**Completed context**

- 2026-05-18: Completed the low-risk agent CLI slice. `src/domain/agents/cli.ts` and legacy import planning now depend on lower `lib` helpers for data-dir, DB option text, and CLI Postgres setup instead of app runtime modules. Agent command behavior stayed in place, and the import-law baseline shrank to 26.

## 4. [x] Split Gateway CLI Into Domain And App/Integration Assembly

**Scope**

- `src/domain/gateway/cli.ts`
- `src/integrations/gateway/http.ts`
- `src/integrations/gateway/http-config.ts`
- `src/integrations/gateway/worker.ts`
- app CLI command registration
- gateway tests

**Problem**

Gateway CLI currently crosses the most sensitive seams: domain records, app DB setup, HTTP server, guard model, and worker startup. That creates multiple import-law violations and makes a public surface harder to review.

**Small steps**

- Keep gateway domain records/stores in `src/domain/gateway`.
- Keep HTTP admission/server/guard adapters in `src/integrations/gateway`.
- Move the command that assembles DB pool, guard, HTTP server, and worker into `src/app`.
- Preserve public body admission rules from the ADR.
- Review logs and command output for accidental sensitive data exposure.

**Why**

Gateway is public-facing. Its module seams should make security review easier, not force a reader to bounce between layers.

**Why not**

Do not combine this with unrelated gateway behavior changes. If a security bug is found, fix it as its own clearly marked subchunk.

**Verification**

- `pnpm vitest run tests/gateway.test.ts tests/gateway-http-body.test.ts tests/gateway-event-request.test.ts tests/gateway-network-controls.test.ts tests/gateway-http-config.test.ts`
- `pnpm typecheck`
- `pnpm architecture:import-law`

**Done when**

- Gateway domain code does not import app or integration modules.
- Gateway command behavior is unchanged.
- Public request admission tests still pass.

**Completed context**

- 2026-05-18: Split `gateway run` into `src/app/gateway/cli.ts` so app owns pool, guard, HTTP server, worker, signal, and shutdown assembly. `src/domain/gateway/cli.ts` now owns only source/event management commands. Gateway public-surface tests passed and the import-law baseline shrank to 21.

## 5. [x] Move Generic Runtime Helpers Out Of App Runtime

**Scope**

- `src/app/runtime/data-dir.ts`
- `src/app/runtime/database.ts`
- `src/app/runtime/postgres-bootstrap.ts`
- `src/app/health/server.ts`
- importers under `src/integrations/**`, `src/panda/**`, and `src/domain/**`

**Problem**

Lower modules import app runtime helpers for path resolution, Postgres setup, and health server behavior. Some of those helpers are generic; some are truly app assembly. Right now the location blurs the interface.

**Small steps**

- Classify each helper before moving it:
  - generic path helper: move to `src/lib` or a focused filesystem helper
  - generic Postgres helper: move to `src/lib/postgres-*`
  - app process assembly: keep in `src/app`
  - connector health serving: consider an integration-local adapter if it is not app orchestration
- Move one helper family at a time.
- Update import-law baseline after each reduction.

**Why**

This removes `integrations -> app` and `panda -> app` pressure without inventing abstractions. The module's location should tell the truth about its role.

**Why not**

Do not create a new `utils.ts` dumping ground. A bad move from `app` to `lib` is still bad architecture.

**Verification**

- Focused tests around moved helper importers.
- `pnpm typecheck`
- `pnpm architecture:import-law`

**Done when**

- Generic helpers live below their consumers.
- Remaining `app` imports are real orchestration, not convenience.

**Completed context**

- 2026-05-18: Moved generic data-dir, DB pool/URL, CLI Postgres bootstrap, DB option text, and health-server helpers into `src/lib/*`, leaving app re-exports for compatibility. Rewrote lower modules to import the lower seams directly and documented the rule in `docs/developers/architecture.md`. Import-law baseline shrank to 4.

## 6. [x] Remove Connector Service Imports From App Runtime

**Scope**

- `src/integrations/channels/telegram/service.ts`
- `src/integrations/channels/whatsapp/service.ts`
- `src/integrations/channels/telegram/cli.ts`
- `src/integrations/channels/whatsapp/cli.ts`
- shared connector startup helpers if needed

**Problem**

Telegram and WhatsApp services still import app health, database, and schema bootstrap helpers. The connector modules should own protocol behavior and use lower-level adapters; app should own process assembly.

**Small steps**

- Decide whether DB pool creation belongs in app assembly or a lower reusable Postgres helper.
- Keep protocol-specific socket/polling/media/action behavior in connector modules.
- Move process health/server startup out of connector services if it is app orchestration.
- Avoid creating a generic connector framework unless a second real adapter proves the seam.

**Why**

The connector worker lifecycle is cleaner now. This item finishes the direction cleanup around connector process wiring.

**Why not**

Do not flatten Telegram and WhatsApp into one abstract connector service. The ADR explicitly keeps protocol behavior local.

**Verification**

- `pnpm vitest run tests/channel-worker-runtime.test.ts tests/telegram-service.test.ts tests/telegram-cli.test.ts tests/whatsapp-runtime-cycle.test.ts tests/whatsapp-connection.test.ts tests/whatsapp-health.test.ts tests/whatsapp-cli.test.ts`
- `pnpm typecheck`
- `pnpm architecture:import-law`

**Done when**

- Connector services no longer import app runtime assembly helpers.
- Protocol behavior stays local.
- Worker lifecycle tests remain green.

**Completed context**

- 2026-05-18: Connector CLI and service modules now use `src/lib/data-dir.ts`, `src/lib/postgres-database.ts`, `src/lib/postgres-bootstrap.ts`, and `src/lib/health-server.ts` instead of app runtime helpers. Telegram and WhatsApp protocol behavior stayed local; channel worker and connector tests passed.

## 7. [x] Decide And Normalize Panda Tool Access To App Runtime Context

**Scope**

- `src/panda/tools/artifact-paths.ts`
- `src/panda/tools/worker-tools.ts`
- `src/app/runtime/panda-session-context.ts`
- `src/app/runtime/panda-path-context.ts`
- worker/session/environment seams

**Problem**

Some Panda tools import app runtime context and worker services directly. Some of that may be legitimate configured-brain assembly; some may be misplaced app orchestration leaking into model-facing tools.

**Small steps**

- Separate context data types from app runtime assembly.
- Keep model-facing tools dependent on narrow interfaces: session context, path context, worker spawn interface, environment lifecycle interface.
- Move pure context types/helpers down if they are not app-only.
- Keep actual daemon/process orchestration in `src/app`.

**Why**

Panda tools are product-facing model interfaces. Their module interfaces should stay small and testable.

**Why not**

Do not over-purify this area. `panda` is allowed to depend on narrow app runtime context helpers today; only move what reduces real friction.

**Verification**

- `pnpm vitest run tests/worker-tools.test.ts tests/spawn-subagent-tool.test.ts tests/media-tool.test.ts tests/workspace-readonly-tools.test.ts`
- `pnpm typecheck`
- `pnpm architecture:import-law`

**Done when**

- Remaining `panda -> app` imports are either gone or documented as intentional narrow seams.
- Tool tests do not fake broad runtime services.

**Completed context**

- 2026-05-18: `worker-tools.ts` now defines the narrow worker-session and execution-environment behaviours it needs locally, so model-facing tools no longer import app runtime service classes. Worker, spawn-subagent, media, and workspace readonly tool tests passed; import-law baseline shrank to 2.

## 8. [x] Public-Surface Security Review Gate

**Scope**

- `src/integrations/gateway/**`
- `src/integrations/telepathy/**`
- `src/integrations/apps/http-*`
- public URL/link creation helpers
- logs and error responses

**Problem**

The architecture refactor touched public and semi-public surfaces. These surfaces carry sensitive personal data, so they need a deliberate security review after structural cleanup.

**Small steps**

- Confirm accepted content types and body limits.
- Confirm trusted proxy and network controls.
- Confirm app links do not expose raw identity/session ids.
- Confirm telepathy websocket/device trust assumptions.
- Confirm public logs/errors do not leak secrets, tokens, local paths, identity ids, or session ids.
- Patch only proven risks or unclear invariants.

**Why**

Architecture cleanliness does not matter if the public edge accepts ambiguous input or leaks sensitive context.

**Why not**

Do not use this as a pretext for speculative hardening. Each change needs a concrete risk.

**Verification**

- `pnpm vitest run tests/gateway-http-body.test.ts tests/gateway-event-request.test.ts tests/gateway-network-controls.test.ts tests/app-http-body.test.ts tests/app-http-runtime.test.ts tests/telepathy-websocket.test.ts tests/telepathy-context-ingress.test.ts`
- `pnpm typecheck`
- Optional live smoke only if the environment is already configured.

**Done when**

- Public-surface assumptions are documented or tested.
- No new security-sensitive TODOs remain hidden in code comments.

**Completed context**

- 2026-05-18: Reviewed gateway, apps, and Telepathy public paths. Confirmed gateway content-type/body limits, IP allowlist/trusted proxy handling, Telepathy path/origin/payload/rate controls, and app launch-token/CSRF flow through focused tests. Patched app HTTP explicit-session errors so public responses no longer echo raw session ids or ownership details.

## 9. [x] Review Postgres Migration Safety By Domain

**Scope**

- `src/domain/**/postgres-schema.ts`
- Postgres tests for gateway, threads, runtime requests, watches, email, sessions, credentials, apps, wiki

**Problem**

Schema, row parsing, and store mutation responsibilities are now split. That is good architecture, but migration drift is easy.

**Small steps**

- Pick one domain schema at a time.
- Check that `CREATE TABLE`, `ALTER TABLE`, indexes, and backfill/repair statements are idempotent.
- Check row parsers reject invalid persisted state at the right edge.
- Add focused tests for repair migrations where old deployments may be missing columns or indexes.

**Why**

Panda is deployed. Schema cleanup has operator impact, not just code aesthetics.

**Why not**

Do not rewrite all stores again. This is migration safety review, not another store architecture pass.

**Verification**

- Domain-specific Postgres tests for the schema under review.
- `pnpm typecheck`
- `pnpm architecture:import-law`

**Done when**

- Each reviewed domain has a clear migration safety story.
- Any missing repair path is tested or explicitly deferred.

**Completed context**

- 2026-05-18: Reviewed the split Postgres schema files for gateway, threads/runtime, scheduled tasks, watches, sessions/routes, credentials, apps, wiki, and email. Added a focused legacy `session_routes` migration test for pre-surrogate-id deployments, including blank identity route repair and id backfill, and kept the pg-mem compatibility fallback local to schema introspection. Verified the Postgres-focused suite, typecheck, and the import-law ratchet.

## 10. [x] Convert Review Chunks Into Merge Chunks

**Scope**

- `docs/developers/architecture-review-chunks.md`
- local branch/diff organization
- PR description or review notes

**Problem**

The refactor is documented as review chunks, but the worktree is still one broad diff. Reviewers need a concrete merge path.

**Small steps**

- For each review chunk, list the exact files it owns.
- Identify files shared by multiple chunks and decide their primary review owner.
- Keep each PR or commit message aligned with one chunk.
- Include verification commands for that chunk.
- Keep public-surface and Postgres migration chunks separate from negative-code cleanup.

**Why**

The architecture can be good and still fail review if it lands as one massive patch.

**Why not**

Do not mechanically split by directory. Split by concept and risk.

**Verification**

- `git diff --stat` per chunk is understandable.
- Each chunk has focused tests.
- The final stack still passes `pnpm typecheck`.

**Done when**

- A reviewer can inspect one chunk without loading the entire refactor into their head.

**Completed context**

- 2026-05-18: Rewrote `docs/developers/architecture-review-chunks.md` into an eight-chunk merge stack with primary file ownership, shared-file ownership rules, review focus, exclusions, and focused verification commands for each chunk. Public-surface, Postgres migration, and negative-code cleanup now have explicit chunk boundaries.

## 11. [x] Remove Or Justify Remaining Import-Law Baseline Entries

**Scope**

- Whatever remains in `scripts/import-law-baseline.json` after items 2-7.

**Problem**

A ratchet baseline is a temporary safety rail. If it lives forever, it becomes a polite TODO nobody reads.

**Small steps**

- Group remaining violations by concept.
- For each group, choose one:
  - fix it
  - document it as a narrow transitional exception with a removal condition
  - update the architecture doc if the import law was wrong
- Keep the baseline shrinking.

**Why**

The import law should become a real architecture constraint, not a report everyone ignores.

**Why not**

Do not chase zero if a real seam is intentionally allowed. Fix the law when the law is wrong.

**Verification**

- `pnpm architecture:import-law`
- `pnpm typecheck`
- relevant focused tests for moved modules

**Done when**

- The baseline is empty or contains only explicitly documented transitional exceptions.

**Completed context**

- 2026-05-18: Removed the final two `domain -> app` import-law entries by moving daemon-backed `session reset` command assembly into `src/app/sessions/cli.ts`. `src/domain/sessions/cli.ts` now registers only domain session management commands, and `scripts/import-law-baseline.json` is empty with the architecture doc updated to treat that as the normal state. Verified focused session/runtime request tests, typecheck, and `pnpm architecture:import-law:ratchet`.

## 12. [x] Final Pre-Merge Verification Pass

**Scope**

- All architecture chunks.

**Small steps**

- Run each chunk's focused tests from `docs/developers/architecture-review-chunks.md`.
- Run `pnpm typecheck`.
- Run `pnpm architecture:import-law`.
- Run `git diff --check`.
- Review deleted tests and confirm each was useless or replaced by behavior coverage.
- Review public-surface changes one final time for secrets, ids, paths, and token leakage.

**Why**

This branch changes core runtime, public ingress, Postgres stores, model-facing tools, and tests. A single green command is not enough evidence.

**Why not**

Do not block on an unrelated flaky full-suite failure without isolating it. But do not hand-wave focused failures.

**Done when**

- Focused checks pass.
- Import-law baseline is stable or reduced.
- Public-surface review is complete.
- The PR/merge notes explain chunk scope, risk, and verification.

**Completed context**

- 2026-05-18: Ran the review-stack checks from `docs/developers/architecture-review-chunks.md` in focused batches: docs/public entrypoints, session delivery, daemon/request drain, Postgres schemas, public gateway/apps/Telepathy, channel workers/connectors, and Panda/browser/kernel tools all passed. Ran `pnpm typecheck`, `pnpm architecture:import-law`, `pnpm architecture:import-law:ratchet`, and `git diff --check`; all passed with zero import-law baseline violations. Reviewed the only deleted test file, `tests/whatsapp-service.test.ts`, and confirmed its monolithic private-service coverage is replaced by focused WhatsApp/runtime/message/connection/pairing tests. Ran a public-edge leak scan and confirmed the explicit-session app errors now use the sanitized `Requested session is not valid for this app.` response.
