# Cleanup cycles

The active objective is to commit the verified work, then repeatedly inspect,
simplify, test, review and commit the next useful change. Each cycle must remove
verified complexity or fix a concrete defect. Do not manufacture churn to keep
the loop busy. Production remains strictly read-only; pushes and deployments
are outside this objective.

## Cycle 0 — Commit the two verified passes

- Scope: D01–D14 plus the second simplification pass recorded in this folder.
- Evidence: 2,926 unit tests, 132 first-pass Postgres regression cases, current
  builds/contracts and second-pass local model smoke; details remain in the
  individual pass records.
- Review: independent durable-operation and public-surface reviews found no
  actionable issues. The surface review also passed 42 focused tests and confirmed
  exact before/after parity for all 131 default grants.
- Exclusions: unrelated image-generation and background-tool-job work, plus
  generated reporting artifacts. Preserve those files and their author's commits.
- Commit: `ca5a689d` — `refactor(core): consolidate durable ownership and remove obsolete paths`.
- State: committed locally; not pushed or deployed.

## Cycle 1 — Consolidate catalog-backed CLI help

The host CLI pre-registers handwritten help-only commands even though
`registerCommandRouteHelpCommands` already projects catalog routes and skips
existing operator commands. Inspect and remove the redundant registrars while
preserving native callbacks, option parsing and command discovery. Compare actual
help/JSON output before and after; do not create another command inventory.

- Result: deleted 13 help-only registrars and their app wiring: 834 fewer
  production lines, with 10 net test lines added. The existing catalog supplies
  their 60 routes; native operator callbacks and image CLI remain intact.
- Evidence: 180 before/after comparisons preserved leaf JSON help, text help and
  transport errors. All 239 focused command/package/schema tests passed. Fifteen
  real CLI help subprocesses passed against an unusable database URL, including
  generated help beneath operator groups. Typecheck, import law, shim generation,
  prompt contracts and diff checks passed.
- Review: independent final review found no blockers and reran 40 command/help
  and schema-gate tests successfully. Tests protect complete descriptor output,
  native callback/options retention through repeated registration, and DB-free
  generated help. No references to the deleted modules remain.
- Commit: `2e3aa496` — `refactor(cli): derive help-only routes from the command catalog`.
- State: committed locally; not pushed or deployed.

## Cycle 2 — Simplify browser action completion

Six browser page actions repeat baseline capture, settling and changed-snapshot
rendering. Consolidate that sequence locally while preserving each action's
Playwright calls, progress order, popup behavior, target validation and scope
invalidation. Reuse the existing timeout helper without weakening dirty-session
closure after timeout. Remove trivial naming adapters only where direct calls
remain clear.

- Result: 76 fewer production lines. The six action branches now share their
  existing completion tail; no new action framework or protocol was introduced.
  Three forwarding scope/path helpers and the duplicate deadline timer are gone.
- Evidence: all 51 browser tool/protocol/runner tests passed, including three new
  press/select/wait cases checking completed effects against the prior snapshot
  and the public progress sequence. Typecheck and import law passed.
- Review: independent review found no blockers and reran all 51 browser tests.
  It verified timer/error behavior, late promise handling, dirty-session removal,
  startup fencing, action ordering, popup and final-URL checks, and normalizer parity.
- Commit: `161ed329` — `refactor(browser): share page action completion and deadline handling`.
- State: committed locally; not pushed or deployed.

## Cycle 3 — Carry the latest stored run directly to terminal views

The store already reads only its latest run. Its UI snapshot nevertheless wraps
that nullable value in an array, which every consumer immediately unwraps. Carry
the actual nullable record through chat and observe instead. Collapse repeated
run-state calculations, preserving transition detection, error suppression,
started-at values and close-after-run behavior. Delete the private transcript
formatter's unreachable role branches and redundant tool-result cast.

- Result: 49 fewer production lines; persisted records and package exports are
  unchanged. Transcript cursor and session/reset handling remain in place.
- Evidence: all 75 terminal/observer tests passed across 10 files, including a
  check that a repeated refresh does not print a run failure again. Typecheck and
  import law passed. Independent review compared the old and new run-state
  function across 40 cases and found identical observable behavior and no blockers.
- Commit: `779e7647` — `refactor(tui): carry latest run directly through stored snapshots`.
- State: committed locally; not pushed or deployed.

## Cycle 4 — Remove copied help from mixed operator registrars

The remaining mixed operator registrars contain 53 descriptor-only help stubs,
plus one image help registrar. Their routes already exist in the command catalog.
Remove the stubs while preserving native callbacks, options and ancestor groups.
Also remove seven verified unused store constructions from CLI assembly; their
constructors only retain the pool and table names, with no startup side effects.

- Recon evidence: 108 text/JSON outputs match when the catalog supplies all 54
  leaves. Forty-nine transport errors also match; five Telegram sticker errors
  gain the standard help-discovery suffix. No image-generation behavior changes.
- Result: 1,061 fewer production lines and one fewer test line. Removed all 54
  stubs and seven unused store constructions. The descriptor help writer and two
  session store helpers are now private to their owning module.
- Evidence: all 108 help outputs still match, and all 59 native leaf definitions
  in the mixed registrars retain their callbacks, arguments and options. All 328
  focused CLI/channel/session/A2A/email/shim tests passed across 10 files, plus
  typecheck, import law, shim generation and prompt contracts. Four actual app
  help subprocesses passed beneath session/Telegram/WhatsApp/email ancestor groups
  with an unusable database URL.
- Review: no blockers. The independent reviewer confirmed all 68 native action
  registrations across the full scope are unchanged, including argument parsers,
  option defaults and callbacks. It reran 121 CLI/schema/session/channel tests,
  checked ancestor groups and final registration order, and verified the parity
  results against the previous commit.
- Commit: `8686d315` — `refactor(cli): remove copied help stubs from operator modules`.
- State: committed locally; not pushed or deployed.

## Cycle 5 — Make attachment no-overwrite behavior atomic

Email and Telegram attachment fetch both check the destination with `stat`, catch
their own refusal by comparing error-message strings, then copy separately. A
concurrent save can create the destination after that check and be overwritten.
Use exclusive copy when overwrite is disabled, mapping only the destination-exists
error to the existing refusal. Keep authorization and path resolution at their
current command boundaries; do not add another filesystem abstraction.

- Scope: the two attachment fetch implementations and caller-level tests using
  real temporary files; remove the internal test-only email auth parser wrapper
  and exercise the production parser directly.
- Required evidence: existing destination remains intact, explicit overwrite
  still succeeds, and competing saves without overwrite produce exactly one
  success. Preserve ownership checks, display paths and other filesystem errors.
- Result: 18 fewer production lines, with 134 lines of caller-level regression
  tests added. Both command boundaries use exclusive copy directly; the internal
  auth wrapper is gone and its existing tests call the production parser.
- Evidence: all 48 focused tests passed, plus typecheck and import law. Real-file
  cases cover existing targets, explicit overwrite, competing distinct payloads
  synchronized at path resolution, and source disappearance after resolution.
- Review: no actionable findings. Independent review passed 44 tests across six
  files, including file authority and path-context coverage, and verified unchanged
  authorization, path mapping, source checks and explicit overwrite semantics.
- State: reviewed and committed locally with this cycle; not pushed or deployed.

## Combined verification after cycles 1–5

The final combined source passed the TypeScript build, all three package-export
tests, import of all 19 compiled package entrypoints, and the shared root/subpath
`Thread` identity check. All 113 local links in this folder resolve. Focused test
counts above describe their particular seams; they are not a new full-suite run.
Production has not been modified by any of these cycles.

## Deferred after reconnaissance

The wiki crypto service and command-result validation protect real boundaries.
No worthwhile simplification was demonstrated in that bounded review; leave them
intact rather than adding churn.
