# Desloppify: implementation simplification

- **Date:** 5 September 2026
- **Status:** committed as `ca5a689d`; historical implementation record
- **Base:** committed `2a483743` plus the existing uncommitted D01–D14 work
- **Scope:** the current codebase; focus on obsolete internals, unnecessary
  indirection and repeated implementation knowledge
- **Evidence:** current source/callers, accepted decisions and behavior tests;
  Harvard author–date citations for supporting repository documents

## Rationale

The first pass repaired durable-work correctness and removed retired machinery.
It reduced production code by 147 physical lines after adding migrations and
recovery behavior. This pass examines whether the remaining implementation is
as small and direct as its real contracts allow. Line reduction is an outcome,
not permission to delete supported behavior or honest error handling.

The accepted architecture favors deep modules, narrow interfaces, local policy,
explicit package entrypoints and tests of observable behavior (Panda Agent,
2026a; Panda Agent, 2026b). Generic Postgres primitives and connector lifecycle
glue are legitimate shared modules; protocol behavior remains local.

## Work inventory

| Area | Current work | State |
| --- | --- | --- |
| Domain and low-level helpers | Verify dead code and redundant internal interfaces | S01 implemented; 194 focused tests pass |
| Runtime assembly and command construction | Apply the deletion test to wrappers, guards and copied wiring | S02 implemented; 220 focused tests pass |
| Control UI and read modules | Verify unused hooks/exports and repeated implementation | S03 implemented; 43 focused tests and UI build pass |
| Integrations and kernel | Check obsolete seams, needless wrapping and orphaned internals | S04 implemented; integration tests pass; public kernel contracts retained |
| Documentation | Keep the complete discussion and active context in this folder | S05 implemented; old link forwards here |

## Evidence and decisions

No finding is accepted solely because it has one caller, looks defensive, or
contains a historical name. Each accepted finding must identify the current
caller contract, concrete simplification, affected files and verification.
Uncertain candidates remain explicit rather than being silently counted as done.

### S01 — Delete obsolete domain internals

Deleted `src/lib/claims.ts` and unsupported barrels at
`src/domain/mcp/index.ts`, `src/domain/connectors/index.ts` and
`src/domain/subagents/index.ts`. The claims helper and MCP barrel had no callers;
remaining barrel callers were tests, now using concrete leaf imports. None is
an intentional package entrypoint (Panda Agent, 2026b).

Removed unused runtime-context policy readers from
`src/domain/execution-environments/policy.ts`, six worker-path constants and an
unused request interface from its `setup.ts`, `sanitizeTraceString` from
`src/domain/model-call-traces/redaction.ts`, and unused input interfaces from
`src/domain/a2a/commands.ts` and `src/domain/mcp/management-service.ts`.
Current authorization, normalization and redaction behavior remains at its live
seams. This package removes 202 production lines and two test lines.

### S02 — Compose runtime tools and command dependencies once

`runtime-bootstrap.ts` already composes main tools first and deduplicates the
specialist additions. `create-runtime.ts` repeated that composition, then replaced
equivalent resolver arrays. Removed the second merge and reassignment. Bootstrap
now supplies the same arrays to definition resolution and the returned runtime.

Inlined the one-use subagent/A2A dependency wrappers at their registration phases,
with required-service type checks. `buildRuntimeCommandDependencies` forwards its
typed input directly and computes only its three derived fields. Retained the
channel adapter because it combines distinct conversation and delivery methods.
Tool ordering, command phases, credential injection and supported constructors
remain unchanged. This package removes 73 production lines and four test lines
(Panda Agent, 2026c).

### S03 — Delete unreachable Control UI and browser helpers

Removed the 493-line `SessionOverviewPanel`; current session tabs never rendered
it. Followed its dead dependency chain through `useSessionTargets`, its query key,
three browser target methods and `ExecutionTarget`. Removed unused browser
bootstrap, Telegram setup and old briefing methods, plus their dead types/keys.
Backend endpoints and the live failure snapshot remain available.

Deleted twelve unused UI primitives: accordion, button-group, collapsible, drawer,
item, pagination, popover, progress, radio-group, scroll-area, toggle-group and
toggle. The last was referenced only by the deleted toggle-group. Static imports,
JSX references, lazy route registries and dynamic loading were checked. Drawer
was the only `vaul` consumer; removed that dependency and its three lockfile records.
Frozen offline lockfile validation and the Control build passed.

Deleted the unsupported, unreferenced `src/domain/control/index.ts` barrel and
corrected the stale session-overview claim in `docs/users/remote-bash.md` to the
current target-discovery commands. This package removes 1,616 UI source lines,
15 backend lines and 19 package/lockfile lines (Panda Agent, 2026d).

### S04 — Remove dead integration paths

The streamed Gateway MIME validator is the active path. Deleted the unused
buffered validator, its sniffing/text helpers and the unused
`resolveGatewayServerOptions` assembly wrapper. Live content-type admission,
incremental UTF-8 validation and signature compatibility checks remain intact.

Also removed the unsupported MCP integration barrel, unused Brave endpoint/count
aliases and key probe, the unused OpenAI key probe, the Discord gateway URL
constant and attachment-parts wrapper, and two unused workspace-exec type aliases.
Source/test/script references, dynamic lookups and package exports were checked;
none of these names is a supported public entrypoint. This package removes 68
production lines. Existing HTTP/media/search/workspace behavior tests pass
(Panda Agent, 2026e).

### S05 — Keep the full context in the requested folder

Moved the complete Harvard-style first-pass plan here, rebased its relative links,
and retained a forwarding document at its former path so earlier chat links work.
This README and execution record are the active context. The plan index points
here. The complete first-pass discussion, corrections, production snapshot and
release conditions remain available rather than being replaced with this summary.

### Retained candidates and reasons

| Candidate | Evidence and disposition |
| --- | --- |
| Kernel model/context/transcript types with few references | Reachable through intentional exports or current type contracts; low reference count is not dead code |
| `src/domain/threads/index.ts` and scheduling barrels | Supported package entrypoints; the nested scheduled-command barrel is re-exported by its supported parent |
| `src/app/cli.ts` | Executable entrypoint, so lack of ordinary imports is expected |
| Runner legacy authentication and programmatic aliases | Supported runner compatibility; this pass provides no evidence authorizing a protocol cut |
| Connector-specific parsing/media behavior | Implements distinct external protocols; no generic replacement is justified |
| Shared data-table wrappers and exports in active UI primitives | Containing modules have live consumers and consistent composition patterns; not a verified dead chain |
| Duplicate cleanup-option literals around bootstrap success/failure | Protect meaningful cleanup ownership; a new helper would offer little simplification |
| Public context injections, environment lifecycle methods and depth metadata | First-pass compatibility decisions remain valid; no new evidence justifies removing them |

## Measured change

Against this pass's captured baseline, including newly created/deleted files:

| Area | Net physical lines |
| --- | ---: |
| Backend source | −358 |
| Control UI source | −1,616 |
| **Production source total** | **−1,974** |
| Tests | −6 |
| Dependency manifest and lockfile | −19 |

Counts include blank lines/comments and exclude documentation and unrelated
reporting artifacts. The source-hash snapshot changes no prompt/tool payload.
This pass adds no schema migration or replacement framework.

## Verification record

The local baseline inventory is `.temp/desloppify-pass2-baseline.json`, captured
before this pass's edits. It records hashes and physical line counts for source,
tests and supporting files. It is local evidence, not a generated project API.

Required gates follow the touched behavior: root typecheck and focused tests;
import-law ratchet for ownership/import changes; shim/prompt contracts for command
or prompt changes; Control typecheck/build for UI changes. Persistence races use
disposable local Postgres where needed. Production stays read-only.

- Full unit gate: **330 files, 2,926 tests passed**. Local report:
  `.temp/desloppify-pass2-unit-results.json`.
- Root typecheck, import-law ratchet, generated shim, prompt contracts, Control
  typecheck/build and diff checks passed. Frozen offline lockfile validation
  passed using the repository's pnpm 10.33.0 toolchain.
- The model smoke passed against the disposable local Postgres database:
  expected reply, no failed runs and an idle thread. Local report:
  `.temp/runtime-smoke/desloppify-pass2-20260905/summary.json`.
- No persistence algorithm changed in this pass. The first-pass 132 real-Postgres
  regression cases remain historical evidence; they are not presented as a fresh
  second-pass run. The second-pass smoke did bootstrap the current schema.
- Final build and all 19 compiled package imports passed, including matching
  root/subpath `Thread` identity. Context links and Harvard citations were checked
  against the current tree; the measured diff was reconciled with the captured
  baseline. The disposable local database is stopped after verification.

## Completion audit

The current-state audit covers all four source roles above, static import roots,
singleton exported integration declarations, Control route/component consumers,
and the strongest runtime indirection candidates. Every accepted finding is
implemented; retained candidates have explicit contractual or architectural reasons.
The claimed outcome is removal of verified unnecessary implementation, supported
by full tests and scoped runtime verification. It is not proof that no future
design improvement can exist in the repository.

## References

Panda Agent (2026a) *Architecture and vocabulary*. Available at:
[architecture](../../developers/architecture.md) and
[vocabulary](../../developers/vocabulary.md) (Accessed: 5 September 2026).

Panda Agent (2026b) *Runtime architecture guardrails*. Available at:
[ADR 0001](../../developers/adr/0001-runtime-architecture-guardrails.md)
(Accessed: 5 September 2026).

Panda Agent (2026c) *Runtime construction*. Available at:
[bootstrap](../../../src/app/runtime/runtime-bootstrap.ts),
[runtime facade](../../../src/app/runtime/create-runtime.ts) and
[command dependency assembly](../../../src/app/runtime/command-dependencies.ts)
(Accessed: 5 September 2026).

Panda Agent (2026d) *Control routes and browser operations*. Available at:
[session tab registry](../../../apps/control-ui/src/app/control-routes.ts)
and [browser operations](../../../apps/control-ui/src/lib/api.ts)
(Accessed: 5 September 2026).

Panda Agent (2026e) *Gateway streaming and integration behavior*. Available at:
[streamed MIME validation](../../../src/integrations/gateway/attachment-mime.ts),
[request tests](../../../tests/gateway-attachment-request.test.ts),
[Discord media tests](../../../tests/discord-media.test.ts) and
[web search tests](../../../tests/web-search-command.test.ts)
(Accessed: 5 September 2026).
