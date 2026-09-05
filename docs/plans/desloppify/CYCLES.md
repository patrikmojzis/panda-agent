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
- Commit: `d33f96f7` — `fix(attachments): enforce no-overwrite with exclusive file copies`.
- State: committed locally; not pushed or deployed.

## Cycle 6 — Simplify provider auth and budget projections

Read the one supported Codex environment token directly, then validate the cache
fields at the point of use. Delete the intermediate cache object, parser and
one-element environment loop. Preserve token precedence, the ChatGPT mode gate,
public helpers and the original path-resolution exception boundary. Select the
exact or prefix model rule before constructing one budget result; inline the
sole-use tool mapping helper.

- Result: 61 fewer production lines; four net test lines added.
- Evidence: 103 focused tests passed. Independent review passed 74 tests and
  compared 605 auth-cache/environment cases and 846 model-policy combinations
  with the previous implementation. The reported catch-boundary difference was
  corrected and verified before freezing. Public exports and tool mapping remain
  unchanged. Typecheck and import law passed.
- Commit: `07cabc01` — `refactor(providers): remove redundant auth and context projections`.
- State: committed locally; not pushed or deployed.

## Cycle 7 — Use native MCP cancellation and relocate its test adapter

The HTTP fetch wrapper always combines two real signals. Replace its optional,
variadic listener helper with `AbortSignal.any`, retaining both the operation
deadline and the SDK request cancellation. Move the in-memory MCP registry from
the production store module into a specific test helper; retain the production
store contract, conflict error and Postgres implementation.

- Result: 91 fewer production lines, including 75 class lines relocated unchanged
  into tests. The repository is five lines smaller overall; relocation is not
  counted as deletion from the repository.
- Evidence: all 54 focused MCP tests passed, including shared-deadline expiry
  and successful SSE stream closure reaching the real fetch signal. Independent
  review verified identical class members and passed 30 transport/OAuth tests.
  Typecheck, import law and public-export checks passed.
- Commit: `598a7ef4` — `refactor(mcp): use native abort composition and isolate the test store`.
- State: committed locally; not pushed or deployed.

## Cycle 8 — Remove redundant runtime composition

Construct subagent tools directly from core tools plus browser. The old specialist
groups contributed only duplicates, browser or nothing. Reuse the existing
runtime command-catalog resolver in daemon bootstrap while retaining validation
before runtime/database initialization. Remove the unused internal readonly
bootstrap result member, preserving the live readonly command dependency.

- Result: 45 fewer production lines; 46 test lines added.
- Evidence: 35 focused tests passed, plus typecheck, import law and shim checks.
  Independent review passed 14 changed-file tests and checked actual tool order
  and shared object identity with and without background jobs, catalog identity,
  duplicate/conflicting module rejection, early validation and readonly wiring.
- Commit: `bd8382a7` — `refactor(runtime): simplify tools and share catalog resolution`.
- State: committed locally, including only the two bootstrap source-metadata
  records; not pushed or deployed.

## Cycle 9 — Let remote-start compensation own its outcome

The existing compensation helper now owns cancellation and propagation of the
original error, including ordered `AggregateError` details when cancellation
also fails. Its three callers retain their distinct diagnostics. Remove private
runner-config forwarding layers and import the owning modules directly, keeping
the supported shell package exports.

- Result: 33 fewer production lines; 75 test lines added.
- Evidence: 218 focused tests passed. Independent review compared 28 failure
  scenarios, all 50 named/type exports and 31 runtime export references. Its
  broader run passed 91 tests; one unchanged cancellation timing assertion passed
  on isolated retry. New compensation cases passed on their first run.
- State: reviewed and committed locally with this cycle, including only its
  thread-definition source-metadata record; not pushed or deployed. The three
  shared files include only this cycle's import changes in the cleanup commit.

## Isolated verification after cycles 6–9

Concurrent scheduling, storage, prompt and Docker-retention work appeared in the
shared checkout. A temporary checkout at `d33f96f7` received only these four
cleanup patches and their tests. The isolated TypeScript build, import law, shim
check and generated prompt/tool surfaces passed. Exactly three tracked source
metadata records changed: the two bootstrap files and thread definition.

The full isolated unit run passed 2,955 assertions across 332 files; one additional
suite could not load because the temporary checkout lacked the Control UI's
dependency link. After adding that local link, its two tests passed: 2,957 tests
verified across all 333 files, without a product-code change for the setup issue.
The initial smoke invocation omitted its required agent selector; after correcting
the harness input, a model plus bash smoke passed against disposable local
Postgres. That temporary database server was stopped afterward.

Preserve the unrelated edits. Commit source-metadata updates only for our files;
do not regenerate and include another task's prompt changes with this cleanup.
The concurrent storage work was committed separately as `89dfea95` and is excluded
from cleanup statistics. Cycles 6–9 remove 230 production lines, including 75
relocated to tests. The actual production-code deletion excluding relocation is
155 lines; the tests and cycle records account for additional repository lines.

## Combined verification after cycles 6–9

The committed checkout at `338893f2`, including the separately committed storage
work, passes root typecheck, import law, shim generation and prompt contracts.
All 76 focused environment/runtime/shell/package tests pass. The TypeScript
build and all 19 compiled package imports pass, including root/subpath `Thread`
identity. The earlier isolated test and smoke artifacts remain in `.temp`; the
disposable validation worktree was removed after preserving those artifacts.

## Cycle 10 — Remove the pretend web-research factory

- Finding: the private web-research factory accepted a descriptor, command name
  and label, but its only caller always supplied the same OpenAI constants.
- Change: the supported `createOpenAIWebResearchCommand` now owns the operation
  directly. It still snapshots constructor options and uses the same descriptor,
  input validation, thread-scope guard, background-job lifecycle and diagnostics.
- Result: 18 fewer production lines; no public export or command-surface change.
- Evidence: 203 web research/search/shim tests pass, plus 75 before/after cases
  covering malformed inputs, configured/default options, caller option mutation,
  missing thread scope and job-start errors. Typecheck, shim and prompt contracts
  pass. No new test was needed for this removal; the comparison harness is local.
- Review: independent inspection and rerun of all 75 comparison cases found no
  blockers.
- State: reviewed and committed locally with this cycle; not pushed or deployed.

## Cycle 11 — Keep Control session access policy in one place

- Finding: briefing, heartbeat, scheduled tasks, watches and runtime activity
  repeated the same grant/role/pairing query and session normalization.
- Change: `src/domain/control/session-access.ts` owns that query. The five services
  retain their authorization call sites and exact denial messages. The helper
  receives the caller's pool, rechecks every request and caches no access result.
- Result: 79 fewer production lines, including the new helper; 26 test lines added.
- Evidence: all 89 Control HTTP tests pass, including five new caller-level tests
  for pairing revocation and grant-role isolation. Independent review passed 36
  focused authorization tests and 70 before/after comparisons of exact SQL,
  parameters, validation order and errors. All 17 service method bodies and 15
  authorization calls are unchanged. Import law passes.
- State: reviewed and committed locally with this cycle; not pushed or deployed.
  No query semantics, schema, migration or authority policy changed.

## Cycle 12 — Share channel-history text handling

- Finding: Telegram, Discord and WhatsApp repeated the same tolerant text-block
  extraction and bounded previews. Protocol metadata and authorization differ.
- Change: `src/integrations/channels/history-text.ts` owns only text extraction
  and preview truncation. Native history commands retain all protocol shaping,
  authorization, filtering and ordering. Malformed/non-text blocks are still
  ignored; inbound previews keep 1,200 characters and outbound previews keep 500.
- Result: 61 fewer production lines, including the new helper; 45 test lines added.
- Evidence: 44 focused history/send/command tests and all three native history
  shim routes pass. Independent review passed 75 history/CLI tests and matched
  672 old/new extraction and preview outcomes, including malformed content,
  sparse arrays, Unicode whitespace and truncation boundaries. The remaining
  219 declarations/statements are unchanged. Import law and shim checks pass.
- State: reviewed and committed locally with this cycle; not pushed or deployed.
  The helper is internal, with no new package export or provider call.

## Cycle 13 — Share image filtering and construct replay segments directly

- Finding: user and tool-result messages duplicated image filtering, unchanged
  record handling and empty-message removal. A separate segment factory only
  recopied fields and cloned issue arrays already created by its callers.
- Change: supported roles feed one image-filtering path; user strings retain
  their original bypass. Replay grouping constructs the same segment literals
  directly, including ordinary-message empty issue arrays. Both projection stages
  around artifact rehydration remain in place.
- Result: 30 fewer production lines; 31 test lines added.
- Evidence: 76 focused transcript/compaction tests passed; after the final guard
  adjustment, all 17 affected inference/default tests and typecheck passed again.
  Root's independent review compared 6,900 output, identity, replay grouping and
  budget cases with the previous implementation. Review caught and corrected a
  guard that initially broadened malformed tool-result handling. No casts or
  persisted transcript changes were needed.
- State: reviewed and committed locally with this cycle; not pushed or deployed.

## Combined verification after cycles 10–13

All four source patches were frozen before the combined build, import law, shim
and prompt checks passed. All 19 compiled package imports and shared `Thread`
identity pass; all 113 local plan links resolve. The model/bash smoke passed against disposable local
Postgres: expected text/tool, no failed run, idle thread and no tool error. Its
summary is `.temp/runtime-smoke/desloppify-cycles10-13-20260905/summary.json`.
That temporary database server was stopped afterward. These cycles add no schema
migration and modify no production service. Their combined source reduction is
188 lines; all cleanup commits through cycle 13 remove 4,577 production lines,
including the previously recorded 75 lines relocated into tests.

Web, Control and channel commits are `1bcf1e67`, `f040e8b9` and `90aa0a8c`.
The kernel change and this combined verification record are committed with
cycle 13. Earlier unrelated commits remain excluded from cleanup measurements.

Further recon identified Control UI error parsing and a small thinking-diagnostic
formatter as possible later candidates; neither was accepted or changed here.
Channel token-redaction paths have different Error-identity behavior and remain
separate. Numeric app validators and Brave endpoint adapters retain meaningful
input/error differences; this pass did not justify a generic replacement.

## Cycle 14 — Share Whisper command execution

- Finding: transcribe and translate repeated input parsing, authentication, file
  resolution, request configuration and result wrapping; the private transcription
  factory added another forwarding hop. Endpoint and operation were redundant
  parameters of the private file runner.
- Change: both supported command factories use one operation-specific executor.
  The operation determines the endpoint. Their separate input schemas, descriptor
  objects, result fields, summaries and option-capture timing remain unchanged.
- Result: 42 fewer production lines; two net test lines added to pin endpoint
  selection and translation's removal of an irrelevant language input.
- Evidence: 40 audio/CLI tests pass. Independent review passed the two focused
  audio tests and all 192 before/after cases covering parsing, option mutation,
  multipart bodies, file resolution and failures. Typecheck, shim and prompt
  contracts pass. Existing cancellation/progress behavior was not changed.
- State: reviewed and committed locally with this cycle; not pushed or deployed.
  No provider request or production action was performed by the focused tests.

## Cycle 15 — Delete unused Panda tool helpers

- Finding: two tool-scope readers, their interfaces/input helpers, an explicit-text
  payload builder and an error wrapper had no live callers. None was exposed by
  the supported root, Panda or SDK package entrypoints; only one test exercised
  the obsolete scope readers.
- Change: delete those internals and their obsolete test. Correct the architecture
  paragraph that still directed callers to the removed scope readers.
- Result: 100 fewer production lines and 28 fewer test lines.
- Evidence: all 21 tool JSON, thinking, image-command and package/root export tests
  pass. Root independently confirmed zero remaining source/test/example/script
  references and byte-identical bodies for all three live helpers: JSON validation,
  JSON payload construction and background-result serialization. Typecheck and
  import law pass. The combined full-suite evidence is recorded below.
- State: reviewed and committed locally with this cycle; not pushed or deployed.
  No image-generation behavior or supported public export changed.

## Cycle 16 — Remove foreign Control form-error scaffolding

- Finding: the Control UI carried Pydantic location parsing, structured field
  errors and an unused field-name map. Its sole API transport targets Control,
  whose errors use `{error: string}`; version conflicts may add `currentVersion`.
  No caller supplies the removed field-name option or consumes those foreign
  payload formats.
- Change: remove the unreachable structured-error path. Keep message-to-field
  mapping, status-specific feedback and ordinary thrown errors. Null/non-JSON
  responses now reach visible fallback feedback instead of crashing on `body.data`.
- Result: 55 fewer production lines; 72 test lines added.
- Evidence: 14 new cases exercise the real `apiWrite`/response parser; all 21
  focused form/model tests and independent review pass. Control typecheck and
  production build pass using installed binaries, as do root typecheck/import law.
  The test mocks Sonner's ESM entry because the package-directory path selects
  CJS; the alternative was rejected and all 14 tests passed after restoration.
- State: reviewed and committed locally with this cycle; not pushed or deployed.
  The only intended behavior change is reliable feedback for malformed responses.

## Cycle 17 — Keep daemon worker startup in one ordered loop

- Finding: seven workers repeated the same awaited start, shutdown check and
  bounded cleanup for a worker whose start completed late. They already share
  the existing `StartStopService` contract.
- Change: replace those blocks with a local ordered tuple loop. Preserve A2A,
  email outbound, email sync, scheduled task, scheduled command, watch and
  heartbeat order, exact late-stop diagnostics and the existing parallel shutdown.
- Result: 46 fewer production lines; 80 test lines added.
- Evidence: all 41 lifecycle/options/request-drain tests pass, including 14 new
  cases covering each worker before/after bounded cleanup. They protect active
  resource cleanup, startup prefixes, request admission and lease/runtime release.
  Root independently compared all seven keys/order/labels; all source outside
  the replaced startup block is byte-identical. Typecheck and import law pass.
- State: reviewed and committed locally with this cycle; not pushed or deployed.
  No worker, pool, timer or durable-work policy was added.

## Combined verification after cycles 14–17

The frozen combined tree passes all 3,021 tests across 334 files with no failed
or skipped tests. Local report: `.temp/desloppify-cycles14-17-unit-results.json`.
The full run includes the verified Sonner ESM mock; its subsequent package-entry
experiment was reverted, and the 14 form tests passed again after restoration.
Root build, import law, shim and prompt contracts pass. Control typecheck/build
passed as recorded above. The model/bash smoke passed against disposable local
Postgres with all five assertions satisfied; report:
`.temp/runtime-smoke/desloppify-cycles14-17-20260905/summary.json`. The temporary
database server was stopped after verification.

The four cycles remove 243 production lines, taking the cleanup total to 4,820
including the previously recorded 75 lines relocated into tests. Audio, Panda
helper and UI commits are `544ad3ad`, `299c56be` and `2cb35981`; daemon startup and
this combined record are committed with cycle 17. Unrelated work and `output/`
remain untouched. Nothing was pushed, deployed, restarted or migrated in production.

Remaining recon candidates include unused Bash secret-candidate metadata, the
subagent-context projection, and repeated persisted-request polling. The polling
callers have different failure-ID diagnostics that need preserving. Whisper's
private runner also retains unused progress/caller-signal hooks; cancellation
behavior needs an explicit decision before touching those. No such follow-up
change is included in these cycles.

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

## Cycle 18 — Remove unused Bash secret metadata

- Finding: temporary secret candidates stored their source and environment key,
  but only their trimmed values were consumed.
- Change: collect strings directly. Keep nonblank-key/value checks, credential,
  prior-session, current-session and call-environment ordering, secret-key
  detection, longest-first deduplication and output-persistence policy.
- Result: 16 fewer production lines; 67 test lines added.
- Evidence: 146 Bash, background-job and remote-runner tests pass, along with
  typecheck and import law. Independent review passed all 61 Bash tests and
  6,561 before/after combinations of sources, blanks, overlaps and Unicode.
  Redaction, insertion order, secret-material detection and persistence gates
  match; the other 51 source declarations/statements are unchanged.
- State: reviewed and committed locally with this cycle. No public contract,
  credential policy or production service changed.

## Cycle 19 — Let the subagent prompt renderer own field selection

- Finding: context assembly copied six profile fields before calling a renderer
  that already explicitly selects those same fields.
- Change: pass the capped profile records directly. The pure renderer remains
  the single owner of model-visible field selection; private prompts, ownership
  and timestamps are never spread or serialized into the output.
- Result: 10 fewer production lines; two net test lines added. Generated prompt
  contracts change only this source file's byte count, line count and hash.
- Evidence: 14 focused tests, typecheck, import law and prompt contracts pass.
  Independent review confirmed exact output through the context caller, unchanged
  default/cap/omitted counts and optional model/thinking behavior. All 324
  before/after combinations match, including private profile metadata.
- State: reviewed and committed locally with this cycle. No model-facing text,
  tool catalog, tool set or subagent permission group changed.

## Cycle 20 — Honor Whisper command cancellation

- Finding: HTTP command disconnects supply an abort signal, and the dispatcher
  preserves it, but Whisper command assembly dropped it. The private runner's
  caller-cancellation branch was therefore unreachable. Its progress callback
  also had no caller.
- Change: forward the command signal into the existing timeout/cancellation
  composition and delete the unused progress callback and payload construction.
- Result: eight fewer production lines; 35 test lines added.
- Evidence: four new pre-abort/in-flight cases failed before the fix and pass
  afterward for transcribe and translate. All eight audio cases, including both
  timeout cases, pass; 76 audio/command tests pass. Independent review also
  exercised shim and HTTP-disconnect cancellation. All 192 before/after cases
  without caller cancellation match for schemas, option timing, file resolution,
  multipart requests, errors and output. Typecheck, import law and contracts pass.
- State: reviewed and committed locally with this cycle. Caller cancellation is
  the intentional behavior change. No provider request was made by these focused
  tests, and no production service was changed.

## Cycle 21 — Reuse the TUI usage accumulator

- Finding: collecting assistant usage repeated the same eleven additions already
  owned by the local accumulator used for paged transcript totals.
- Change: send normalized assistant usage to that existing accumulator with one
  response. Keep the latest-usage record and all paging/normalization behavior.
- Result: 10 fewer production lines; six net test lines added.
- Evidence: all 48 focused TUI tests pass, plus typecheck and import law. The
  existing two-response fixture now verifies every token/cost total and the latest
  sequence. Root's independent review confirmed identical addition order and
  unchanged source outside the replaced block; normalized inputs are fresh plain
  records, so the spread introduces no getter or alias behavior.
- State: reviewed and committed locally with this cycle. No transcript shape,
  stored usage, paging policy or user-facing formatting changed.

## Cycle 22 — Share persisted request-result polling

- Finding: the runtime client, session CLI and Control HTTP adapter repeated the
  same persisted-result polling loop. Their timeout limits and fallback error
  identifiers differ and belong to the callers.
- Change: `src/domain/threads/requests/wait-for-result.ts` owns polling through a
  narrow `getRequest` store slice. Callers retain their limits; the CLI explicitly
  selects its requested-ID failure diagnostic while other callers use the row ID.
- Result: 24 fewer production lines, including the new helper; 203 net test lines
  added across the three public caller seams.
- Evidence: all 117 runtime-client, session CLI and Control HTTP tests pass,
  including 24 new cases. Independent review passed 28 cases and checked the
  immediate first read, 100 ms polling, inclusive 30-second/15-minute deadlines,
  late-returning reads, nullish-only result fallback and stored/empty errors.
  Authentication and enqueue order are unchanged. Timeout neither cancels nor
  re-enqueues durable work. Typecheck and import law pass.
- State: reviewed and committed locally with this cycle. No query, claim, lease,
  session/reset policy, schema or migration changed.

## Combined verification after cycles 18–22

The frozen source passes all 3,053 tests across 334 files with no failures or skips:
`.temp/desloppify-cycles18-22-unit-results.json`. The TypeScript build, import law,
shim and prompt checks pass. All 19 compiled package imports and shared `Thread`
identity pass, and all 113 local plan links resolve. Prompt metadata changed only
for the subagent-context source; model-visible content and tool surfaces match.

The model/bash smoke passed all five assertions against disposable local Postgres:
`.temp/runtime-smoke/desloppify-cycles18-22-20260905/summary.json`. Its temporary
server was stopped afterward. Production received no writes, deployments,
migrations, restarts or message replays.

These five cycles remove 68 production lines, taking the cleanup total to 4,888,
including the previously recorded 75 lines relocated into tests. Bash, subagent
context, audio and TUI commits are `ee4c76f3`, `29b17c94`, `862832e4` and `998c2155`;
request polling and this combined record are committed with cycle 22. Unrelated
work and `output/` are excluded and preserved.

Further read-only recon identified two next areas:

1. `src/domain/threads/runtime/tool-job-service.ts` repeats starting-job removal
   and startup-settlement notification in five exits. A single `finally` may own
   that cleanup, but must preserve registration before awaits, immediate rejection
   observation, awaited late cancellation and aggregate-error ordering. Verify
   reservation rejection and combined start/settlement failures before accepting.
2. `src/integrations/control/http-server.ts` has an unreachable second connector
   GET handler plus eight private route matchers duplicated by existing helpers.
   Recon matched 960 old/new path cases. Preserve matcher evaluation positions,
   malformed-escape behavior, authorization and the first handler's complete DTO.

Neither follow-up was implemented in this batch. Other examined runtime parsers,
row/claim helpers and Control UI transports retain meaningful differences or live
callers; no further deletion was justified there.

## Cycle 23 — Reuse string normalization in the Bash audit reader

- Finding: a private helper accepted a field-name parameter with only one valid
  value and repeated the existing `trimToUndefined` behavior.
- Change: normalize `job.result?.code` directly with the existing string helper,
  removing the local wrapper and redundant result cast.
- Result: eight fewer production lines; no new test scaffolding.
- Evidence: all 14 command-dispatcher tests pass, including caller-visible audit
  summaries. Independent review matched 115 before/after caller outcomes and
  store arguments across missing/nonstring/whitespace codes and ordinal values.
  The missing-ordinal guard, projected fields and exported factory are unchanged.
  Typecheck, import law and diff checks pass.
- State: reviewed and committed locally with this cycle. No command execution,
  audit persistence or public package contract changed.

## Cycle 24 — Give background startup one cleanup exit

- Finding: five paths repeated removal from the starting-job map and resolution
  of the startup-settled promise.
- Change: one outer `finally` owns that bookkeeping, ending before promotion to
  the live-job map. Reservation registration still precedes the first await;
  handle rejection is observed immediately, and late cancellation is awaited.
- Result: 17 fewer production lines; 55 test lines added for three failure cases.
- Evidence: 100 focused runtime/background/image/web/daemon tests pass, plus
  typecheck and import law. Root independently ran all 68 runtime/background
  tests, reviewed return/throw/await order and confirmed all source outside
  `start()` is unchanged. Reservation and startup errors retain identity;
  combined startup/persistence errors retain their message and member order.
- State: reviewed and committed locally with this cycle. Durable ownership,
  reset and shutdown behavior are preserved; no claim or persistence SQL changed.

## Cycle 25 — Remove redundant Control routing

- Finding: a second connectors GET handler was unreachable because the earlier
  identical route always returned or threw. Eight other private matchers copied
  the behavior of existing resource/action matchers.
- Change: delete the unreachable handler and its sole-use matcher; call the
  existing matchers with literal resources at the original evaluation positions.
- Result: 69 fewer production lines; one test line added to assert the complete
  live connector response keys: `data`, `meta` and `connectors`.
- Evidence: all 92 Control HTTP tests pass, including authorization and privacy.
  Independent review matched 3,240 route results/errors across encoded IDs,
  malformed escapes/UTF-8, empty segments and suffixes. It confirmed the earlier
  decode already executes for every method, preserving decode-error precedence.
  The implementer also verified 106 other function bodies are unchanged.
  Typecheck, import law and diff checks pass.
- State: reviewed and committed locally with this cycle. Route availability,
  response shapes, authorization and protocol behavior are unchanged.

## Cycle 26 — Delete the obsolete orphaned-job row parser

- Finding: `RunningToolJobLossRow` and `parseRunningToolJobLossRow` had no callers.
  The current orphaned-job recovery path delegates to `postgres-run-claims.ts`
  and reads the SQL update count instead.
- Change: delete the unused interface and parser from `postgres-rows.ts`.
- Result: 14 fewer production lines; no test scaffolding added for dead code.
- Evidence: independent source/dynamic-lookup/export searches found no consumer
  or supported package exposure. All 36 retained top-level statements are
  byte-identical. The 29 runtime-Postgres/transcript-checkpoint tests, typecheck
  and diff check pass. The live coordinator/store/recovery SQL chain is unchanged.
- State: reviewed and committed locally with this cycle. No query, row format,
  migration, recovery behavior or public package contract changed.

## Cycle 27 — Construct the watch schema catalog directly

- Finding: six exported accessors were each used only by the catalog constructor
  in the same file. None was exposed through a supported package entrypoint.
- Change: construct the catalog with the existing schema formatter, example
  lookups and copied notes directly, removing those forwarding functions.
- Result: 24 fewer production lines; no new test scaffolding.
- Evidence: 217 command/CLI/shim tests pass, as do typecheck, import law and
  shim/prompt checks. Independent review verified the complete 12,154-byte catalog
  against the previous implementation and both real command descriptors. All 26
  repeated-call reference comparisons match: kinds, schemas and notes remain
  fresh, while examples remain shared. Source/detector order is unchanged.
- State: reviewed and committed locally with this cycle. No schema, example,
  note, model-facing text or command policy changed.

## Combined verification after cycles 23–27

All 3,056 tests across 334 files pass with no failures or skips:
`.temp/desloppify-cycles23-27-unit-results.json`. The frozen source also passes the
TypeScript build, import law, prompt/shim contracts, all 19 compiled package
imports and shared `Thread` identity. No generated contract changed.

The model/bash smoke passed all five assertions against disposable local Postgres:
`.temp/runtime-smoke/desloppify-cycles23-27-20260905/summary.json`. The temporary
server was stopped afterward. Production received no writes or operational changes.

These five cycles remove 132 production lines, bringing the cleanup total to
5,020, including the previously recorded 75 lines relocated into tests. Bash
audit, startup cleanup, Control routing and dead row-parser commits are
`39540ab9`, `3ac63511`, `c39f4244` and `5a7e3620`; watch catalog cleanup and this
record are committed with cycle 27. Unrelated commits and `output/` are excluded.

Read-only recon found a next bounded candidate: private string-parsing copies in
watch, scheduled-task and scheduled-command command modules can use existing
`lib/strings` helpers. Ninety value/error comparisons match; implementation still
needs caller-level validation checks, exact error labels and preservation of
cron's explicit null-to-clear behavior. No such change is included here.
Other inspected scheduling limit/claim/renewal paths, channel/provider helpers
and supported runtime context exports retain meaningful policy or public callers.

## Cycle 28 — Use one app HTTP service contract

- Finding: the API adapter duplicated the server's service interface exactly,
  although its sole runtime caller already passed that server contract.
- Change: replace the private duplicate with a type-only import of the existing
  `AgentAppHttpService`; remove unused result-type imports.
- Result: 30 fewer production lines; no test scaffolding added.
- Evidence: all 16 app-server/runtime tests pass, plus typecheck and import law.
  Root independently compared every interface member and emitted JavaScript:
  both are identical. The new type reference is erased, adding no runtime cycle.
- State: reviewed and committed locally with this cycle. Public types, HTTP
  behavior, authentication, input admission and app SQL isolation are unchanged.

## Cycle 29 — Construct terminal transcript entries directly

- Finding: a shared factory only copied four entry fields and returned an
  incremented counter to three callers that immediately unpacked both values.
- Change: construct explicit entry fields at the stored-message, Observe-command
  and TUI-local call sites; advance counters after rendering/construction.
- Result: 21 fewer production lines; no new test scaffolding.
- Evidence: 60 focused UI/shared/CLI tests, typecheck and import law pass.
  Independent review ran 57 affected tests and matched 174 old/new cases covering
  duplicates, pending-input acknowledgments, rendering failures, seen sets,
  counters, ordering and cache IDs. The helper was not a supported package export.
- State: reviewed and committed locally with this cycle. Transcript rendering,
  persisted shapes, UI output and entry-identity behavior are unchanged.

## Cycle 30 — Reuse command string validation

- Finding: watch, scheduled-task and scheduled-command modules copied required
  and optional string parsing already provided by `lib/strings`.
- Change: replace six private helpers with the existing functions at all 35 call
  sites, retaining complete error messages and validation positions.
- Result: 38 fewer production lines; 110 net test lines added for 42 cases.
- Evidence: all 109 focused command/CLI/service tests, typecheck, import law and
  prompt/shim checks pass. Independent review ran 86 cases and matched 138
  before/after value/error outcomes, including Unicode whitespace, nonstrings,
  nested labels and dynamic command names. Cron's `cwd: null` clearing remains
  explicit. Its test store now replaces cwd like the real Postgres adapter.
- State: reviewed and committed locally with this cycle. Command descriptors,
  authority, mutation order, null semantics and error behavior are unchanged.

## Cycle 31 — Fix streaming MCP secret redaction

- Finding: the backward match loop never terminated when a complete secret began
  at offset zero: `lastIndexOf` clamps a negative search position back to zero.
  A shorter overlapping secret could also move the cutoff inside a previously
  scanned longer secret, emitting its raw prefix.
- Change: scan cached regex matches forward using the same leftmost/longest-first
  precedence as whole-string redaction. Retain a bounded suffix and keep valid
  UTF-16 pairs together, including when secret values contain unpaired surrogates.
  A nonempty single-unit inventory now retains one unit for Unicode context;
  empty inventories retain their immediate passthrough behavior.
- Result: three production lines added; 78 net test lines added. Correctness takes
  priority over a negative line count for this defect.
- Evidence: four subprocess regressions timed out on the previous implementation
  and now finish without leaking buffered secrets. All 59 focused MCP tests pass.
  Root fuzzing found two Unicode boundary cases during review; both were fixed
  before acceptance. The 28,536 root comparisons plus 42,493 independent cases
  match whole-string redaction across overlaps, UTF-16/UTF-8 splits, malformed
  bytes, repeated finish and empty inventories. Review confirmed every emitted
  prefix is safe, regex state is stable and pending data stays bounded.
- State: reviewed and committed locally with this cycle. This intentionally fixes
  stderr hangs and partial-secret exposure. JSON redaction, transport lifecycle,
  provider calls and supported interfaces are unchanged; production is untouched.

## Combined verification after cycles 28–31

The frozen combined source passes all 3,107 tests across 335 files with no failures
or skips: `.temp/desloppify-cycles28-31-unit-results.json`. TypeScript build, import
law, prompt/shim contracts, all 19 compiled package imports and shared `Thread`
identity pass. No generated contract changed. All 113 local plan links resolve.

The model/bash smoke passed all five assertions against disposable local Postgres:
`.temp/runtime-smoke/desloppify-cycles28-31-20260905/summary.json`. The temporary
server was stopped afterward. Production received no writes or operational changes.

These four cycles remove 86 production lines net, bringing the cleanup total to
5,106, including the previously recorded 75 lines relocated into tests. App HTTP,
terminal entries and command parser commits are `f647451a`, `9559ed62` and
`36b47900`; MCP redaction and this record are committed with cycle 31. Unrelated
commits and `output/` are excluded and preserved.

MCP/browser recon was interrupted to fix the reproduced redactor defects and
remains an area for further inspection. Two private object-shape guards also
duplicate `lib/records` in WhatsApp auth storage and Bash-target context; any
follow-up must verify auth decoding and exact prompt output before removing them.
No additional implementation is included in this batch.

## Cycle 32 — Reuse object-shape guards

- Finding: WhatsApp auth storage and Bash-target context each copied the exact
  object-shape check already supplied by `lib/records`.
- Change: import the existing `isRecord` and remove both private copies.
- Result: six fewer production lines; no new test scaffolding.
- Evidence: independent review verified both bodies match the shared helper and
  all remaining source is byte-identical after import/removal normalization.
  All 11 auth-store/Bash-target tests pass, alongside typecheck, import law and
  prompt/shim checks. The generated snapshot changes only the Bash-target source
  hash, byte count and line count; tool catalogs, toolsets and other records match.
- State: reviewed and committed locally with this cycle. Auth decoding, generated
  prompt output, model-facing text and public contracts are unchanged.

## Cycle 33 — Reuse credential and environment string parsing

- Finding: credential and execution-environment commands repeated the required
  and optional string validators already supplied by `lib/strings`.
- Change: remove three private helpers and reuse the existing functions at all
  seven call sites, passing each complete original error message.
- Result: 22 fewer production lines; no new test scaffolding.
- Evidence: all 43 environment/credential/CLI tests pass, with typecheck, import
  law and prompt/shim checks. Independent review matched 39 value/error cases and
  proved the remaining source unchanged after helper/import/call normalization.
  Secret values remain raw: `env.set` validates the value before its key and
  returns the original untrimmed string.
- State: reviewed and committed locally with this cycle. Error precedence,
  descriptors, authority checks, mutation order and credential contents are intact.

## Cycle 34 — Remove the browser client singleton

- Finding: default `BrowserTool` instances shared the first constructed client's
  configuration. A second tool could silently use the first tool's runner URL,
  authentication and fetch implementation.
- Change: construct the default `BrowserRunnerClient` in each tool and delete the
  global cache/getter. Explicitly injected services still take precedence.
- Result: 12 fewer production lines; 27 test lines added.
- Evidence: the new caller-level regression failed before the fix and now passes.
  Independent review passed 65 browser/protocol/public-entrypoint/runtime tests,
  typecheck and import law. The client class and helpers are byte-identical; only
  the tool's import/construction and the unused cache/getter change. Lazy default
  environment resolution and public exports remain intact.
- State: reviewed and committed locally with this cycle. Per-tool configuration
  is intentionally corrected. The daemon still injects its owned shared client;
  remote browser-session ownership, explicit `close()` and TTL cleanup remain.
  No live Chromium or production checks were performed.

## Cycle 35 — Carry caller cancellation through MCP

- Finding: MCP commands discarded `CommandRequest.signal`; even a pre-aborted
  command spawned its stdio fixture and returned success. In-flight operations
  waited for their separate deadline instead of observing caller cancellation.
- Change: attach the optional caller signal after the existing config/credential
  resolution, compose it with the absolute deadline and check it before external
  work. Preserve HTTP session deletion under the deadline during caller abort,
  and retain stdio process-group cleanup. Track which cancellation happened first
  without relying on lazily resolved composed-signal reasons.
- Result: 21 production lines added and 177 net test lines added. This is a
  correctness repair, not a line-count reduction.
- Evidence: all 75 focused MCP tests pass. Public command regressions cover
  pre-aborted stdio/HTTP/SSE calls, in-flight cancellation, no replay, session
  deletion, descendant termination, sanitized reasons and unchanged timeout codes.
  Independent review reproduced a queued-OAuth caller-first attribution defect
  in the first patch; it is fixed before commit. Four real OAuth queue regressions
  now pass. Five additional independent cases verify first-abort ordering,
  pre-abort, absent signals, auth-create failure and zero retained caller listeners.
  Cancelled queue admission performs no reload, reauthorization write or fetch.
- State: reviewed and committed locally with this cycle. Caller aborts now report
  `aborted`/3; ordinary deadlines remain `timeout`/124. Authority/config ordering,
  protocol boundaries and required cleanup remain intact. The existing OAuth
  exclusive queue still waits for its predecessor before settling cancellation
  or timeout; this patch prevents late execution but does not guarantee immediate
  completion while queued. No production access was needed.

## Combined verification after cycles 32–35

All 3,120 tests across 335 files pass with no failures or skips on the corrected
source: `.temp/desloppify-cycles32-35-unit-results.json`. TypeScript build, import
law, prompt/shim contracts, all 19 compiled package imports and shared `Thread`
identity pass. Snapshot changes are limited to the Bash-target source metadata
record; model-facing contracts are unchanged. All 113 local plan links resolve.

The final model/bash smoke passed all five assertions against disposable local
Postgres: `.temp/runtime-smoke/desloppify-cycles32-35-20260905/summary.json`.
The temporary server was stopped afterward. Production received no writes or
operational changes.

These four cycles remove 19 production lines net, bringing the cleanup total to
5,125, including 75 lines previously relocated into tests. Object guards, command
parsers and browser client ownership are committed as `17cf72c2`, `0f191bdc` and
`64a0404e`; MCP cancellation and this record are committed with cycle 35.
Unrelated commits and `output/` remain excluded and preserved.

Recon found a duplicated 24-line post-assistant sequence in the normal and
streaming kernel paths; the existing private finalization method can own it.
Browser cancellation also needs further work: a pre-aborted public tool call
still sends its request, and runner/service disconnect behavior needs an end-to-end
review before changing it. Neither follow-up is implemented in this cycle.

Credential schema probes accept same-name tables/columns from any schema, but
the production baseline contains a frozen, checksum-pinned copy. Changing the
fixture alone would not repair production bootstrap. Leave this outside cleanup
until a migration/bootstrap change has cross-schema evidence. Sixteen unused
migration-constant reexports are optional future deletion; manifest/checksums and
schema behavior must remain unchanged. Trace/pool/lifecycle helpers inspected in
this pass retain meaningful policy and were left intact.

## Cycle 36 — Centralize assistant-turn finalization

- Finding: normal and streaming kernel paths duplicated the same 24-line
  post-assistant checkpoint/cancellation/tool-execution sequence.
- Change: deepen the existing private `finalizeAssistantTurn` into an async
  generator that owns the sequence and returns `ThreadStepResult`; both paths
  delegate after their original provider, abort and yield boundaries.
- Result: 23 fewer production lines; 109 net test lines for 20 additional cases.
- Evidence: all 23 targeted behavior cases passed on the unchanged implementation
  before the move. The patch passes 193 focused tests across nine suites and 97
  independent review cases. Root reconstructed the entire new source from the
  exact moved tails, signature and two call substitutions; all other source is
  byte-identical. The combined suite passes 3,140 tests across 335 files, with
  typecheck, import law, prompt/shim checks and 19 compiled package imports.
- State: reviewed and committed locally with this cycle. Normal/streaming hook,
  pipeline, checkpoint and tool order remains; interruption options, cancellation
  reasons, progress, early iterator closure and thinking restoration are covered.
  Provider retries, public APIs and persisted transcript formats are unchanged.

## Cycle 37 — Remove unused migration-constant reexports

- Finding: the schema verifier module reexported 16 migration constants with no
  consumers. Executable migrations already import their concrete summary files;
  runtime callers use the verifier or complete manifest.
- Change: remove those reexports and their trailing blank line. Keep the imports,
  manifest, baseline metadata and verifier implementation.
- Result: 17 fewer production lines; no test scaffolding added.
- Evidence: independent caller/export review found no supported package exposure.
  All remaining source is byte-identical. The complete 25-entry, 4,774-byte
  manifest matches, as do seven old/new verifier cases covering current, pending,
  missing, unknown, nonprefix and checksum-invalid ledgers. All 21 focused
  checksum/migration/boundary/package tests pass; root also ran the 15 primary
  migration/checksum tests. Executable migration bundle checksums remain pinned.
- State: reviewed and committed locally with this cycle. No schema, migration,
  SQL, startup verification or supported public contract changes.

## Combined verification after cycles 36–37

All 3,140 tests across 335 files pass without failures or skips:
`.temp/desloppify-cycles36-37-unit-results.json`. TypeScript build, import law,
prompt/shim contracts, 19 compiled package imports and shared `Thread` identity
pass. Generated contracts are unchanged.

Automatic approval review rejected the additional external-model smoke because
its outgoing runtime context/credential payload lacked sufficiently specific
authorization. That command did not run. A safer deterministic fixture instead
used the real migration catalog, Postgres stores, lease and runtime coordinator
with a fixed in-process echo tool and injected model responses. It discarded
inherited environment values and blocked fetch plus all sockets except the exact
loopback test database. All 25 migrations applied; two synthetic model responses
and one tool call produced a completed owned run, an applied input, four persisted
messages and idle state, with zero external requests. Evidence:
`.temp/desloppify-cycles36-37-offline-smoke-output.log`.

The fixture initially rejected PostgreSQL's address rendering (`127.0.0.1/32`)
before migrations; its query now uses `host(inet_server_addr())`. The corrected
fixture passed, and the isolated server was stopped afterward. This validates
the runtime/persistence path; it does not validate external providers or Bash.
No production operations or external-model calls occurred in this verification.

These two cycles remove 40 production lines, bringing the cleanup total to
5,165, including 75 lines previously relocated into tests. Kernel finalization is
committed as `11c7590d`; the export cleanup and this record are committed with
cycle 37. Unrelated commits and `output/` remain excluded and preserved.

The next material issue is documented in the pending
[browser cancellation plan](./2026-09-05-browser-cancellation.md). Recon established
missing client/service cancellation, incorrect HTTP disconnect observation,
dirty teardown blocked by storage persistence, and ownership risks in late
startup/fallback/write completion. Independent plan review added explicit
artifact/storage publication rules so old writes cannot overwrite replacement
state. No browser cancellation implementation is included in this batch.

## Cycle 38 — Own browser cancellation through cleanup

- Finding: the browser client ignored caller cancellation; the HTTP runner
  observed request closure too late; service timeouts closed by scope key after
  storage persistence. Late startup, fallback input and file writes could outlive
  the action and interfere with replacement work.
- Change: implement B01–B06 from the browser cancellation plan. The client carries
  a fixed caller error through fetch, body parsing and exact artifact cleanup.
  The runner observes aborted bodies and unfinished responses. The service owns
  admission, acquired resources and staged publication per session/device scope.
  Canceled waiters never acquire resources; dirty closure starts before admission
  release and does not wait for storage collection. Already-issued rename remains
  the commit boundary and settles before replacement admission.
- Result: 266 production lines added and 1,026 test lines added. This is a
  correctness repair, not a negative-code pass. Cumulative production reduction
  is now 4,899 lines, including 75 lines previously relocated into tests.
- Evidence: 39 new retained cases cover the public client, real loopback HTTP and
  service lifecycle. Independent review passed six additional public lifecycle
  probes and found no blockers. Root verified the composed public tool → HTTP →
  browser teardown path and exact preservation of all frozen source/test hashes.
  Review added post-acquisition and final-result cancellation guards. All 3,179
  tests across 338 files pass with zero failures or skips:
  `.temp/desloppify-cycle38-unit-results.json`. TypeScript build, import law,
  prompt/shim contracts, 19 compiled imports and shared `Thread` identity pass.
- Runtime verification: the inspected offline fixture migrated a fresh isolated
  Postgres database through all 25 migrations, executed one owned run with two
  deterministic model responses and one tool call, persisted the four-message
  transcript and reached idle with zero external requests. Evidence:
  `.temp/desloppify-cycle38-offline-smoke-output.log`. The cluster was stopped.
  The prior automatic rejection of external-model smoke remains respected.
- State: reviewed and committed locally with this cycle. Wire/action/auth and
  navigation policy remain; normal persistence, explicit close, independent
  device scopes and public options remain. Cancellation cannot roll back issued
  external effects, HTTP abort does not acknowledge completed Chromium teardown,
  and a never-settling launcher cannot be interrupted through its current seam.
  Browser tests use fake Chromium; the offline runtime smoke does not validate
  external providers or Bash. No production access, push or deployment occurred.

## Cycle 39 — Remove fixed-argument skill-command factories

- Finding: four private `createSkill*CommandWithDescriptor` factories each had one
  caller, which supplied fixed command-name and descriptor constants. Their
  parameters did not represent supported variation.
- Change: put each existing body directly in its exported skill-command factory
  and substitute those same constants. Keep list/show, descriptors, exported
  names, parsers, authorization checks and mutation helpers intact.
- Result: 32 fewer production lines; no new tests or abstractions. Cumulative
  production reduction is 4,931 lines, including 75 relocated into tests.
- Evidence: exact whole-file reconstruction from `719074d1` allows only the four
  body/header substitutions and wrapper removals; every other byte is unchanged.
  Independent AST review confirms unchanged execution bodies after substitution,
  all 50 other top-level statements and the exported names. Author verification
  passed 720 old/current execution comparisons; independent review passed 2,176
  cases across inputs, scopes, present/missing records and store failures. Results,
  errors, descriptor identity and store-call traces match. Retained local proof:
  `.temp/desloppify-cycle39-parity.mjs` and
  `.temp/desloppify-cycle39-structural-proof.json`.
- Checks: 69 focused CLI/module/package and skill/shim tests pass. Independent
  review also passes 204 command-authority/module/shim tests, including the full
  shim file. The author's filtered shim run skips 172 unrelated cases. Typecheck, import law,
  generated shim, prompt contracts and diff checks pass. The cycle-38 full suite
  and isolated runtime smoke remain historical evidence for that earlier tree;
  this structurally identical command-factory move received focused verification.
- State: independently reviewed and committed locally with this cycle. Public
  command factories, command discovery, validation/authority order, delete
  confirmation and store effects are preserved. No production access, push or
  deployment. Browser cancellation is committed as `719074d1`.

## Cycle 40 — Reuse channel, email and app string validation

- Finding: five command modules repeated required/optional string parsers already
  supplied by `lib/strings`: ten private helpers across explicit channel sends,
  apps, email, Telegram and WhatsApp.
- Change: use the existing helpers at all 101 call sites with the exact complete
  error text. Preserve null/undefined absence, whitespace trimming and rejection
  of present empty or non-string values. Numeric and domain-specific parsers stay.
- Result: 80 fewer production lines; cumulative reduction 5,011, including 75
  lines previously relocated into tests. No new helper or test scaffolding.
- Evidence: root passed 1,300 old/new helper outcomes and 46 focused public-command
  tests. Independent review passed 1,150 comparisons and 131 focused tests,
  including transport, history, attachment, authority and CLI behavior. Reversing
  only the 101 calls/error suffixes and helper/import changes makes every remaining
  AST node identical. Descriptors, exports, validation and side-effect order match.
  Local proof: `.temp/desloppify-cycle40-string-parity.mjs`.
- State: reviewed and committed locally with this cycle. Typecheck, import law,
  prompt/shim contracts and diff checks pass. No production access or deployment.

## Cycle 41 — Use one mailbox/UID email lookup

- Finding: two private mailbox/UID lookups repeated the same SQL, parameter order
  and row parser; only their missing-row behavior differed.
- Change: keep one nullable lookup and put the existing missing-row error at its
  sole insert-conflict caller. Preserve nullable lookup inputs from that caller.
- Result: 31 fewer production lines; cumulative reduction 5,042, including the
  75 lines previously relocated into tests.
- Evidence: 24 old/new public `recordMessage` cases match exact query/parameter,
  result/error and transaction traces, including conflict-found/conflict-missing,
  malformed rows and lookup failures. Root independently reconstructed the whole
  file from only these changes, verified identical query/parameter statements and
  passed all eight email Postgres/schema tests. Local proof:
  `.temp/desloppify-cycle41-email-structural-proof.mjs`.
- State: independently reviewed and committed locally with this cycle. No SQL,
  schema, row mapping, commit/rollback or release behavior changes. Typecheck and
  diff checks pass. No production access, migration, push or deployment.

## Cycle 42 — Delete the unused Control filter-patch format

- Finding: the Control data table carried a `filterPatch` factory, patch type and
  set/keepSource/unset interpreter with no producer. Its four configured setter
  sites return ordinary booleans, strings or undefined. Zustand persists only
  column visibility, so there is no stored filter-patch state to migrate.
- Change: remove the dead factory/type, dispatch branch and internal reexports.
  Keep ordinary filter setters, normalization and column/global filter order.
- Result: 38 fewer production lines and 69 test lines for six behavior cases.
  Cumulative production reduction is 5,080, including 75 relocated into tests.
- Evidence: all six new caller/API tests passed before deletion; 47 focused
  Control tests pass afterward. Author verification matched 2,500 old/new filter
  projections; independent review matched 3,872 parameter/query-string cases
  using actual boolean/visibility setters and query encoding. There is no public
  package exposure or dynamic producer. Root and Control typechecks, Control
  build, import law and diff checks pass.
- State: independently reviewed and committed locally with this cycle. False,
  scalar/list values, empty-value removal, global override order and final API
  query strings remain. Cycle-16 form-error behavior is untouched. No production
  access, push or deployment.

## Combined verification after cycles 40–42

All 3,185 tests across 339 files pass without failures or skips:
`.temp/desloppify-cycles40-42-unit-results.json`. The root TypeScript build, Control
build/typecheck, import law, prompt/shim contracts, all 19 compiled package imports
and shared `Thread` identity pass. All nine frozen source/test hashes still match;
generated contracts and executable migration checksums remain unchanged.

The inspected deterministic runtime fixture passed against a fresh isolated
Postgres database: 25 migrations, one owned completed run, two injected model
responses, one tool call, four persisted messages, an applied input and idle state,
with zero external requests. The cluster was stopped afterward. Evidence:
`.temp/desloppify-cycles40-42-offline-smoke-output.log`. This verification does not
exercise an external provider, Bash or real Chromium. The earlier automatic
rejection of external-model smoke remains respected; production was untouched.

The three cycles remove 149 production lines net, bringing the total to 5,080.
String-parser reuse is committed as `f899dffd`; email lookup deduplication as
`07f78739`; Control cleanup and this record are committed with cycle 42. Unrelated
commits and untracked `output/` remain excluded and preserved.

Further recon found four equivalent private Postgres binary decoders and a
matching pair of wiki-locale normalizers. Those remain candidates for a separate
reviewed cycle; integer decoders differ and must not be merged casually. A TUI
callback-dispatch consolidation also needs an explicit test-seam review before
acceptance. None of these candidates is implemented in this batch.

## Cycle 43 — Share Postgres binary decoding

- Finding: credentials, connectors, wiki bindings and MCP OAuth repeated four
  private binary decoders with the same Buffer, typed-array and string behavior.
- Change: move that behavior into `requirePostgresBuffer` in the existing generic
  `src/lib/postgres-values.ts` module. Each of the 12 row-field calls supplies its
  original validation error; integer and encrypted-envelope parsers stay local.
- Result: 48 fewer production lines; cumulative reduction 5,128, including the
  75 lines previously relocated into tests. No new test scaffolding.
- Evidence: independent review passed 36 tests across seven suites and 128
  old/new decoder comparisons. Buffer identity, typed-array copying and offsets,
  UTF-8 strings, lowercase hex prefixes, permissive malformed-hex handling and
  exact errors match. Whole-file reconstruction confirms that SQL, field order,
  envelope handling and all other caller behavior remain unchanged.
- State: independently reviewed and committed locally with this cycle. Typecheck,
  import law and diff checks pass. No package entrypoint expansion, migration,
  production access, push or deployment.

## Cycle 44 — Reuse the Wiki locale normalizer

- Finding: Wiki commands and the Wiki client duplicated the same optional-locale
  normalization and default value.
- Change: use the existing `normalizeWikiLocale` at all ten command-service call
  sites and remove `normalizeWikiInputLocale`. Namespace policy now imports its
  two remaining types directly from `types.ts`.
- Result: nine fewer production lines; cumulative reduction 5,137, including the
  75 lines previously relocated into tests. No test scaffolding added.
- Evidence: 78 Wiki tests pass; independent review passed 52 focused tests and
  16 old/new locale cases. Whole-file reconstruction proves that call positions,
  arguments and the two explicit defaults are unchanged. The helper bodies are
  identical after renaming and resolve the same constant. Path normalization and
  namespace authority remain separate and unchanged.
- State: independently reviewed and committed locally with this cycle. Typecheck,
  import law and diff checks pass. No supported export or request-contract change,
  production access, push or deployment. Binary decoding is committed as `4e389844`.

## Cycle 45 — Dispatch TUI commands at their existing host seam

- Finding: the TUI created a 13-callback object solely to forward one dispatcher's
  calls to private command handlers. That dispatcher had one caller, no direct
  tests and no supported package export.
- Change: move its parsing and switch into `runChatActionsCommandLine` and call
  the existing handlers directly. Keep `ChatCommandHost`, the actual ChatApp
  adapter, command handlers, help text and unknown-command rendering unchanged.
- Result: 45 fewer production lines and 68 test lines for ten behavior cases.
  Cumulative production reduction is 5,182, including 75 relocated into tests.
- Evidence: all 53 ChatApp tests passed before and after the source change;
  independent review passed the same suite. New cases cover busy/idle exit and
  quit, picker waiting/rejection, resume whitespace, idle/active abort outcomes,
  case sensitivity and empty/leading-whitespace input. Structural review proves
  every retained declaration is unchanged and each switch branch is the exact
  substitution of its former callback body, including awaits and error handling.
- State: independently reviewed and committed locally with this cycle. The
  existing caller/service seam remains testable; no replacement callback layer,
  command alias, input format or public contract is added. No production access,
  push or deployment. Wiki locale reuse is committed as `153279f4`.

## Combined verification after cycles 43–45

All 3,195 tests across 339 files pass without failures or skips:
`.temp/desloppify-cycles43-45-unit-retry-results.json`. The initial sandboxed run
could not use fixture sockets, DNS or macOS PDF previews; the permitted rerun
passed. The root TypeScript build/typecheck, import law, prompt/shim contracts,
all 19 compiled package imports and shared `Thread` identity pass. All ten frozen
source/test hashes still match; generated contracts and migrations are unchanged.

The inspected deterministic runtime fixture passed against a fresh isolated
Postgres database: 25 migrations, one owned completed run, two injected model
responses, one tool call, four persisted messages, an applied input and idle state,
with zero external requests. The cluster was stopped afterward. Evidence:
`.temp/desloppify-cycles43-45-offline-smoke-output.log`. This does not exercise an
external provider, Bash or real Chromium. The earlier automatic rejection of
external-model smoke remains respected; production was untouched.

These three cycles remove 102 production lines net, bringing the total to 5,182
across 46 cleanup commits. Binary decoding is committed as `4e389844`; Wiki locale
reuse as `153279f4`; TUI dispatch and this record are committed with cycle 45.
Unrelated commits and untracked `output/` remain excluded and preserved.

Further recon and independent assessment found two subagent-profile upsert
methods whose SQL differs only in the fixed partial-index conflict target. A
single query is a supported next candidate, provided transaction/advisory locking,
cross-scope rejection and validation order remain. Existing tests emulate those
upserts and skip the partial indexes; exact emitted-SQL/parameter comparisons and
a disposable real-Postgres check of both scopes are required before acceptance.
That candidate is not implemented in this batch.

## Cycle 46 — Use one subagent-profile upsert

- Finding: two private profile-store methods repeated an insert/update query;
  only the global versus agent-scoped partial-index conflict target differed.
- Change: put one query in the existing public `upsertProfile` method, selecting
  its conflict target from two fixed literals. Remove the private duplicates.
  Preserve normalization, transaction, advisory slug lock, cross-scope guard,
  parameter preparation, row validation and transaction completion order.
- Result: 41 fewer production lines and 116 live-test lines for seven cases.
  Cumulative production reduction is 5,223, including 75 relocated into tests.
- Evidence: 205 old/new public-upsert comparisons preserve every SQL token and
  all 11 parameters, return values, validation/query errors, rollback and release.
  Only uniform query indentation changes. All 33 focused subagent tests pass.
  Local comparison: `.temp/desloppify-cycle46-parity.mjs`.
- PostgreSQL coverage: the existing in-memory fixture intercepts upsert SQL and
  skips the partial indexes. New `tests/live/subagent-profiles.live.test.ts` uses
  real migrations and public store calls to verify inserts/updates in both scopes,
  shared custom slugs across agents, both conflict directions, a global/custom
  creation race, and recovery after a foreign-key failure. All seven cases pass
  on a fresh isolated database; evidence:
  `.temp/desloppify-cycle46-profiles-live-results.json`.
- State: independently reviewed and committed locally with this cycle. Root
  typecheck, import law and diff checks pass. The deterministic runtime fixture
  also passed against a separate fresh database: 25 migrations, one completed
  owned run, an applied input and zero external requests. Evidence:
  `.temp/desloppify-cycle46-offline-smoke-output.log`. The isolated cluster was
  stopped afterward. No production access, migration, push or deployment.

## Cycle 47 — Reuse remaining matching command string parsers

- Finding: A2A, subagent, Wiki and session-prompt commands carried seven private
  copies of required/optional string validation already supplied by `lib/strings`.
- Change: reuse those existing helpers at all 78 call sites with complete original
  error text, including indexed and interpolated labels. Keep numeric, object,
  enum and subsystem-specific validation local. Skill/todo whitespace behavior
  and MCP structured errors are outside this change.
- Result: 52 fewer production lines; cumulative reduction 5,275, including the
  75 lines previously relocated into tests. No test scaffolding added.
- Evidence: 4,212 old/new value-and-label comparisons match; all 217 retained
  top-level statements reconstruct byte-for-byte after reversing only permitted
  imports, helper removal and call/error substitutions. All 248 focused tests
  pass, including the complete 177-test agent command shim suite. Local proof:
  `.temp/desloppify-cycle47-parity.mjs`.
- Independent review: 85 focused tests, 567 helper comparisons and 180 public
  session-prompt command comparisons pass. Recording stores confirm descriptors,
  parsed calls, validation/effect order, envelope unwrapping, results and errors.
- State: independently reviewed and committed locally with this cycle. Public
  factories/descriptors, validation and authority order, null/undefined absence,
  rejection of present empty/non-string values and stored results remain.
  Typecheck, import law, shim generation and diff checks pass. No production
  access, push or deployment. Profile upserts are committed as `dd89f05a`.

## Cycle 48 — Delete runtime database/path forwarding modules

- Finding: `app/runtime/data-dir.ts` and `app/runtime/database.ts` only reexported
  helpers already owned by `lib`. Neither file was a supported package entrypoint;
  runtime package exports remain at its intentional `index.ts` boundary.
- Change: delete both forwarding files and redirect 34 module specifiers across
  33 caller files to their existing leaf owners. Correct the architecture document's
  stale path-ownership statement. Keep import/export names, ordering and all caller
  bodies unchanged.
- Result: 18 fewer production lines; cumulative reduction 5,293, including the
  75 lines previously relocated into tests. No new test scaffolding.
- Evidence: exact whole-file reconstruction verifies only those module strings,
  the two deletions and the one architecture token change. All 33 supported runtime
  type/value exports retain their declaration origins; the 14 runtime values and
  all ten old-facade values preserve identity. All 40 focused author tests and
  24 independent database/path/package tests pass. An AST scan of 1,152 source,
  test and script files found no remaining references to the deleted modules.
  Local proof: `.temp/desloppify-cycle48-proof.mjs`.
- Generated metadata: the prompt snapshot tracks four affected runtime source
  files. Regenerate only their SHA/byte counts; line counts, prompt text, tool
  catalog, toolsets and subagent groups are unchanged. The contract check passes.
- State: independently reviewed and committed locally with this cycle. Pool
  configuration, environment lookup, directory policy and initialization remain
  in the same `lib` implementations. No public export expansion, production
  access, push or deployment. Command validation is committed as `95d78159`.

## Combined verification after cycles 46–48

All 3,195 unit tests across 339 files pass without failures or skips:
`.temp/desloppify-cycles46-48-unit-results.json`. The root TypeScript build,
import law, prompt/shim contracts, all 19 compiled package imports and shared
`Thread` identity pass. All 42 frozen file states still match, including the two
deletions and regenerated snapshot metadata. Migration definitions are unchanged.

The seven new profile-store tests also pass on the final import tree against
a fresh isolated database: `.temp/desloppify-cycle48-profiles-live-results.json`.
A separate fresh database passed the inspected deterministic runtime fixture:
25 migrations, one owned completed run, two injected model responses, one tool
call, four persisted messages, an applied input and idle state, with zero external
requests. Evidence: `.temp/desloppify-cycle48-offline-smoke-output.log`. The cluster
was stopped afterward. These checks do not exercise an external provider, Bash or
real Chromium; the earlier external-model smoke rejection remains respected.

These three cycles remove 111 production lines net, bringing the total to 5,293
across 49 cleanup commits. Profile upserts are committed as `dd89f05a`; command
validation as `95d78159`; facade removal and this record are committed with cycle
48. Unrelated commits and untracked `output/` remain excluded and preserved.

Further bounded recon found identical required/nullable ISO timestamp conversion
pairs in three Control read services, with 31 callers. Reuse in the existing
generic date module is a candidate for the next cycle. Preserve timestamp-string
acceptance, null output, exact field errors and out-of-range `RangeError` behavior;
the stricter Postgres timestamp decoder is not equivalent. This candidate remains
unimplemented and needs caller-level service/HTTP verification.

## Cycle 49 — Share Control timestamp conversion

- Finding: scheduled-task, watch and runtime-activity services duplicated the same
  required/nullable ISO timestamp conversion at 31 call sites.
- Change: use two documented generic helpers in the existing `lib/dates.ts`, with
  each caller supplying its complete original error. Date objects, millisecond
  numbers and date strings remain supported; nullish optional values remain null.
- Result: 17 fewer production lines; cumulative reduction 5,310, including the
  75 lines previously relocated into tests. No persistent test scaffolding added.
- Evidence: all 97 focused Control HTTP/time/package tests pass in author and
  independent review. Whole-file reconstruction preserves all caller declarations
  and existing date helpers. 1,860 helper comparisons, 138 public runtime-activity
  comparisons and 272 public task/watch update comparisons preserve outputs,
  SQL/parameters, authority/validation order and errors, including the existing
  finite-out-of-range `RangeError`. Local proof:
  `.temp/desloppify-cycle49-runtime-parity.mjs`.
- Documentation audit: correct the obsolete database compatibility-facade sentence
  in the architecture overview and mark the initial simplification pass committed
  as `ca5a689d`. A bounded audit found no unresolved accepted implementation step
  in the sampled legacy-runner, model-boundary, session/reset, claim and receipt
  paths. Explicit compatibility/schema/MCP-affinity dispositions remain in place;
  this audit does not claim that all possible cleanup is complete.
- State: independently reviewed and committed locally with this cycle. Typecheck,
  import law, prompt contracts and diff checks pass. No SQL, schema, public package
  export, production access, push or deployment change.

## Cycle 50 — Use the existing SQL task lifecycle for display

- Finding: scheduled-task reads classified lifecycle twice: SQL for filters and
  sorting, then a separate TypeScript classifier for displayed rows.
- Change: project the existing SQL lifecycle expression into the selected row and
  remove the duplicate classifier and its two intermediate projections. Keep the
  distinct mutation-record classifier, authority checks and query scope unchanged.
- Result: 21 fewer production lines; cumulative reduction 5,331, including the
  75 lines previously relocated into tests. The existing HTTP test adapter also
  loses four lines. Its sort detection now reads the outer `ORDER BY CASE`, and
  mixed once/recurring schedule keys compare as text, matching the actual query.
- Evidence: 88 old/new public-service query comparisons preserve results, query
  scope, counts, ordering and parameters. Four service-to-adapter comparisons
  cover schedule/lifecycle sorting in both directions. All 92 Control HTTP tests
  pass in both author verification and independent review. Literal reconstruction
  confirms unchanged lifecycle precedence, latest-run tie order and mutations.
  Local proof: `.temp/desloppify-cycle50-proof.mjs`.
- PostgreSQL verification: real migrated fixtures cover all six lifecycle states,
  conflicting active/terminal states, epoch completion/cancellation timestamps,
  failed history without completion, tied run timestamps and displayed/filter/sort
  agreement. The shared persistent live tests are added with cycle 51 below.
- State: independently reviewed and committed locally with this cycle. The final
  combined tree passes all 3,195 unit tests, build, import law and prompt/shim
  contracts. Timestamp conversion is committed as `bc95aa1b`. No migration,
  production access, push or deployment.

## Cycle 51 — Select one latest run per watch in PostgreSQL

- Finding: a Control watch page fetched every historical run for its page IDs,
  then kept only the first row per watch in JavaScript.
- Change: use `DISTINCT ON (watch_id)` with the existing `watch_id ASC,
  created_at DESC, id ASC` order. Build the result map directly from those rows.
  Preserve page/session predicates, separate counts and all DTO conversion.
- Result: four fewer production lines; cumulative reduction 5,335, including the
  75 lines previously relocated into tests. Returned latest-run rows are bounded
  by the number of watches on the page. This does not guarantee bounded database
  scans or sorting work.
- Evidence: literal whole-file reconstruction permits only the SELECT change and
  removal of the first-row reducer. Eight focused watch HTTP tests and five
  rendered-query comparisons pass. Independent review verified non-null keys,
  deterministic ties, missing runs, scope and nullable run timestamps.
- PostgreSQL coverage: `tests/live/control-work-reads.live.test.ts` adds four
  tests using real migrations and scoped Control services. They cover the task
  lifecycle cases from cycle 50, mixed schedule sorting, timestamp ties, watch
  pagination/counts, no-run watches and private-session access. Fixtures retain
  the actual claim, lineage, stable-input and foreign-key constraints.
- Direct before/after comparison: the same migrated fixture returns 602 latest-run
  query rows from baseline `bc95aa1b`, and two from this implementation, with
  identical public results on both populated and no-run pages. Evidence:
  `.temp/desloppify-cycle51-postgres-parity-output.log`. All four live tests pass:
  `.temp/desloppify-cycles50-51-control-live-results.json`. The isolated local
  PostgreSQL cluster was stopped afterward.
- State: independently reviewed and committed locally with this cycle. Task
  lifecycle reuse is committed as `21c54dc4`. No schema, migration, production
  access, push or deployment change.

## Combined verification after cycles 49–51

All 3,195 unit tests across 339 files pass without failures or skips:
`.temp/desloppify-cycles49-51-unit-results.json`. All four new PostgreSQL tests
pass on the final source tree. Build/typecheck, import law, prompt/shim contracts,
all 19 compiled package imports and shared `Thread` identity pass. Frozen source
hashes still match independent review; the live fixture was reviewed again after
correcting its initial setup to satisfy the existing lifecycle constraints.

These three cycles remove 42 production lines net, bringing the total to 5,335
across 52 cleanup commits. Counts exclude unrelated work, tests and documentation;
75 source lines were previously relocated into tests. Timestamp conversion is
committed as `bc95aa1b`, task lifecycle reuse as `21c54dc4`, and watch selection
with this cycle. Earlier runtime smoke evidence remains historical; this batch
validates the changed Control queries directly against PostgreSQL and makes no
new external-provider or production-deployment claim. Untracked `output/` remains
preserved. The inspect/review/commit loop remains active.

## Cycle 52 — Represent transcript protection as a suffix and checkpoint

- Finding: every projection rule materialized a set of protected message indexes
  and, for user-turn floors, an array of every user index. These protections are
  always a suffix plus the latest compact checkpoint.
- Change: retain the suffix start and checkpoint index. Find the requested newest
  ordinary user turns by scanning backward. Keep rule order, cutoff precedence,
  checkpoint recognition, tool pairing/pruning and message replacement unchanged.
  Window bookkeeping now takes constant space; other projection work still
  materializes its existing result arrays and tool-pairing collections.
- Result: 12 fewer production lines; cumulative reduction 5,347, including the
  75 lines previously relocated into tests. Five public projection cases protect
  the union of both floors, insufficient/no ordinary users and compact summaries
  that must not count as user turns.
- Evidence: 101,184 old/new public projection comparisons across 96 immutable
  transcripts and 486 rule configurations preserve results and original object
  references. Sixteen other declarations remain byte-identical. Independent
  review adds 57,330 comparisons over short role/checkpoint sequences and all
  four rule paths. All 95 focused projection/default/checkpoint/thread tests pass.
  Local proof: `.temp/desloppify-cycle52-parity.mjs`.
- Runtime verification: the deterministic fixture enables all four projection
  rules and runs against fresh isolated PostgreSQL. All 25 migrations apply;
  an owned run completes after two injected responses and one tool call, with an
  applied input, four persisted messages and idle state. No external request was
  attempted. Evidence: `.temp/desloppify-cycle52-offline-smoke-output.log`.
  The cluster was stopped afterward.
- State: independently reviewed and committed locally with this cycle. The
  combined source passes all 3,199 unit tests, build/typecheck, import law,
  prompt/shim contracts and all 19 compiled package imports. No persisted
  transcript shape, schema, production access, push or deployment change.

## Cycle 53 — Delete the unused HTML-only web reader

- Finding: `fetchReadableWebPage` survived as an HTML-only predecessor to the
  current web command. Its only remaining caller was a stale test labelled
  watch-facing; actual watch evaluation already used `fetchSafeHttpResource`.
- Change: delete that function and its exclusive options/result/progress types,
  content limit, error formatter and content-type parser. Remove the stale test
  and import. Keep the HTTP resource reader and current command/watch extraction
  implementations unchanged. Correct the architecture document's extraction
  ownership sentence and remove its stale reference to the retired subagent runner.
- Result: 146 fewer production lines and 15 fewer test lines; cumulative source
  reduction 5,493, including the 75 lines previously relocated into tests.
- Evidence: exact reconstruction preserves all retained source/test declarations
  after only the allowed deletions and import/export cleanup. The four live
  caller/extraction files are byte-identical. Author verification passes all
  266 focused web command, pinned HTTP, watch, Discord GIF, CLI and shim tests.
  Independent review resolves 1,021 exports across all 19 supported entrypoints:
  none expose the deleted reader or its module. It also verifies unchanged SSRF
  handling and passes 51 focused tests. Local proof:
  `.temp/desloppify-cycle53-proof.mjs`.
- State: independently reviewed and committed locally with this cycle. The HTTP
  target checks, DNS pinning, redirects, cancellation, byte limits and current
  extraction policies remain. Transcript protection is committed as `243983a3`.
  No production access, migration, push or deployment.

## Combined verification after cycles 52–53

All 3,199 unit tests across 339 files pass without failures or skips:
`.temp/desloppify-cycles52-53-unit-results.json`. Build/typecheck, import law,
prompt/shim contracts, all 19 compiled package imports and shared `Thread`
identity pass. The projection-enabled runtime smoke applies all 25 migrations
to a fresh isolated database and completes one owned run with an applied input,
one tool call, four persisted messages and idle state. Its model responses are
injected; external requests are prohibited and none were attempted. The cluster
was stopped afterward. Source/test hashes still match independent review.

These two cycles remove 158 production lines net, bringing the total to 5,493
across 54 cleanup commits. Counts exclude unrelated work, tests and docs;
75 source lines were previously relocated into tests. Untracked `output/`
remains preserved. The inspect/review/commit loop remains active.

### Next recon findings

- Prioritize a narrow agent-visibility read in `src/domain/control/read-service.ts`.
  Operator and MCP authorization currently call `listAgents`, which computes
  session counts and loads/normalizes MCP configuration for every visible agent
  just to check one agent key. Preserve active-agent, admin/scoped grant and
  pairing policy, errors and mutation order; verify denied/revoked access and
  absence of configuration reads at public service methods.
- Runtime activity still fetches all session runs before local filtering/sorting/
  pagination. A proper replacement must preserve complete counts, the unfiltered
  summary, clamped pages, natural sorting, null order and sanitized-error search.
  Do not substitute a bare SQL limit for that contract.
- Actor-pairing reads repeat identity lookups before pagination. Bulk reads must
  retain the different Discord and Telegram/WhatsApp pairing scopes.
- Two smaller runtime candidates were verified but left unimplemented:
  `src/app/runtime/execution-environment-service.ts` can unify lease grant/clear manager calls
  while preserving omitted `commandAccess` on clear (1,440 proposed-method parity
  cases); `src/app/runtime/subagent-session-service.ts` has unreachable no-operation replay
  branches after an operation guard (192 parity cases). Pool-observation sharing
  remains deferred because ownership is published at different times on failure.

## Cycle 54 — Separate single-agent authorization from listing enrichment

- Finding: 57 operator checks and MCP actor resolution called the full agent list
  to test one key. That read joins session counts and parses MCP configuration
  for every visible agent, coupling permission checks to unrelated configuration.
- Change: `ControlReadService.assertAgentVisible` owns normalization, a targeted
  active-agent query and the existing visibility error. Scoped access retains the
  active scoped grant and same-identity pairing joins; authenticated admin access
  retains its existing active-agent rule. Remove the private operator duplicate
  and use the read-service operation directly at all 57 callers and in MCP.
- Result: 17 additional production lines; cumulative reduction becomes 5,476,
  including the 75 lines previously relocated into tests. This trade removes
  unbounded listing/enrichment work from each single-agent authorization check.
  Enriched `listAgents` SQL/DTOs remain byte-identical, including duplicate-grant
  aggregate behavior. Bulk key-only callers remain separate pending work.
- Unit evidence: all 97 Control HTTP tests pass in author and independent review.
  Five new cases cover bounded reads, invalid input before queries, unrelated
  malformed MCP configuration, denial before mutation/validation, and raw query
  errors. Exact reconstruction preserves remaining method bodies and call order.
- PostgreSQL evidence: six new `tests/live/control-agent-visibility.live.test.ts`
  cases pass on real migrations. They cover both roles, inactive/missing agents,
  cross-identity grants/pairings, duplicate grants, revocation, the scoped login
  privilege ceiling, enrichment counts and actual MCP management reads. A direct
  baseline/current comparison across 34 checks preserves normalized results and
  errors while reducing returned rows from 168 to 12; each new check executes at
  most one query returning at most one row. Enriched listings also compare equal.
  Evidence: `.temp/desloppify-cycle54-visibility-live-results.json` and
  `.temp/desloppify-cycle54-postgres-parity-output.log`.
- State: independently reviewed and committed locally with this cycle. The
  malformed unrelated MCP configuration no longer blocks an authorized target
  operation; target visibility and mutation ordering remain unchanged. Typecheck,
  import law and prompt/shim contracts pass. The isolated test cluster was stopped.
  No schema, package export, production access, push or deployment change.
- Combined gate: the first full run passed 3,203 tests and failed the unchanged
  remote-job cancellation test at `tests/bash-remote-runner.test.ts:2486`.
  The isolated case and all 80 tests in that file then passed. A single full-suite
  rerun passes all 3,204 tests across 339 files with no failures or skips. The
  cancellation endpoint has a bounded wait; the original report omits the actual
  response, so the precise cause remains unproven. Preserve both reports:
  `.temp/desloppify-cycles54-56-unit-results.json` and
  `.temp/desloppify-cycles54-56-unit-rerun-results.json`. No cancellation code or
  test was changed to obtain the passing result.

## Cycle 55 — Share command-access grant and clear handling

- Finding: `refreshSessionCommandAccess` in
  `src/app/runtime/execution-environment-service.ts` duplicated the same bound
  disposable-environment manager check and refresh call for lease grant and clear.
- Change: build optional command access once and use one manager branch. Clearing
  access still omits the `commandAccess` property entirely; an unsupported manager
  retains precedence over the no-allowed-commands result. Transport resolution,
  lease refresh, manager calls and raw failures keep their existing order.
- Result: 17 fewer production lines; cumulative reduction returns to 5,493,
  including the 75 lines previously relocated into tests. No tests were rewritten
  to accept a different contract.
- Evidence: author comparison of the actual old/new method passes 1,440 cases
  and 138 focused tests. Independent review passes 2,880 comparisons and 77
  environment/lease tests, including omitted properties, optional URL/socket
  fields, error identity and returned/manager command-access object identity.
  Source outside this method remains byte-identical.
- State: independently reviewed and committed locally with this cycle. The
  combined tree passes all 3,204 unit tests on the recorded rerun, build/typecheck,
  import law and prompt/shim contracts. The earlier cancellation failure and its
  limits remain recorded under cycle 54. Cycle 54 is committed as `2aaa7744`.
  No schema, production access, push or deployment change.

## Cycle 56 — Inline guarded subagent creation replay

- Finding: `createSessionAndThread` in
  `src/app/runtime/subagent-session-service.ts` defined an async replay closure
  before creation, although its only caller was guarded by a durable operation.
  The closure retained unreachable no-operation checks and a nullable result.
- Change: validate replay directly after the failed-create operation guard.
  Keep atomic creation first, the existing session/thread checks and receipt
  recording after successful validation. An exact unknown-session read retains
  the original create error as its retryable cause; other read failures retain
  their own causes. Receipt-write failures remain unwrapped. Replay still does
  not mutate runtime configuration.
- Result: 21 fewer production lines; cumulative reduction becomes 5,514,
  including the 75 lines previously relocated into tests. No persistent test
  edits or transcript/schema changes.
- Evidence: 192 actual old/new method cases and all 37 focused public tests pass.
  Independent review passes 768 comparisons and the same 37 tests, covering
  success, operation absence, replay validation, receipt writes, ordered calls,
  object identity and Error/string/null/record failures. Source outside the method
  remains byte-identical. Evidence: `.temp/desloppify-cycle56-parity.mjs` and
  `.temp/desloppify-cycle56-frozen.json`.
- State: independently reviewed and committed locally with this cycle. Build,
  typecheck, import law and prompt/shim contracts pass. Command-access cleanup
  is committed as `7323be65`. No production access, push or deployment.

## Combined verification after cycles 54–56

The full rerun passes all 3,204 unit tests across 339 files with no failures or
skips. The initial unchanged cancellation-test failure, passing isolated/file
checks and unresolved cause are recorded under cycle 54; both full-suite reports
are retained. Build/typecheck, import law, prompt/shim contracts, all 19 compiled
package imports and shared `Thread` identity pass. Frozen source/test hashes
match independent review.

Six real-PostgreSQL Control visibility tests and 34 baseline/current comparisons
verify role/grant/pairing policy, one-target query bounds and unchanged enriched
listings. The offline runtime smoke applies all 25 migrations to a fresh isolated
database and completes an owned run with two injected model responses, one tool
call, four persisted messages, applied input and idle state. External requests
are blocked and none were attempted. Evidence:
`.temp/desloppify-cycle56-offline-smoke-output.log`. This smoke covers shared
runtime persistence and completion; it does not call either changed lifecycle
method in cycles 55–56. Their focused public tests and actual-method comparisons
provide that coverage. The isolated cluster was stopped afterward.

These cycles remove 21 production lines net, bringing the total to 5,514 across
57 cleanup commits. The targeted visibility seam adds 17 lines to remove
unnecessary listing/enrichment work; the two lifecycle simplifications remove
38. Counts exclude unrelated work, tests, docs and configuration; 75 production
lines were previously relocated into tests. Untracked `output/` remains preserved.

### Next recon findings

- Add a narrow visible-agent-key read for the seven key-only calls in Control
  overview, audit, credential, identity, A2A-binding and work-failure reads.
  Keep database ordering, unique scoped keys despite duplicate grants, current
  pairing policy and admin-wide overview/credential scope. Admin credential
  listing needs no visibility query. Preserve the enriched agent list and the
  bounded single-target assertion; avoid a generic SQL builder or cache.
- Actor-pairing listings repeat identity reads. Discord includes identities on
  owned connector accounts even without a current agent pairing; Telegram and
  WhatsApp require that pairing. Preserve these distinct scopes and error/order
  behavior when replacing the fanout. Runtime-activity pagination and pool
  observation ownership remain pending as described after cycle 53.

## Cycle 57 — Read visible agent keys directly

- Finding: seven key-only reads still loaded enriched agent summaries for
  overview, credentials, audit, identity visibility/counts, A2A visibility and
  work-failure scope. Admin credential listing discarded the entire agent list.
- Change: `ControlReadService.listVisibleAgentKeys` returns active agent keys in
  database order, using the current scoped grant and same-identity pairing rules.
  Scoped `DISTINCT` preserves the old grouped key uniqueness with duplicate
  grants. Replace the seven key-only calls; skip visibility reads entirely for
  admin credentials. Preserve the enriched list and single-target assertion
  byte-for-byte. Keep existing admin-wide data scope, pairing-read failures,
  repeated visibility reads and downstream pagination behavior.
- Result: 23 additional production lines; cumulative reduction becomes 5,491
  across 58 cleanup commits, including the 75 lines
  previously relocated into tests. The explicit query seam earns its cost by
  removing unrelated enrichment and queries; it adds no SQL framework or cache.
- Unit evidence: author and independent review pass all 106 focused tests
  (102 Control HTTP and four work-failure tests). Five new caller cases cover
  malformed MCP isolation, inactive-agent admin scope, identity counts, both A2A
  endpoints and empty failure pages without opening a snapshot. A scoped session
  count anomaly in `pg-mem` also reproduces with the unchanged baseline query;
  the real-PostgreSQL tests assert the exact expected counts instead of encoding
  that emulator result as the production contract.
- PostgreSQL evidence: all 11 visibility tests pass, including five new cases for
  ordered unique keys, admin/scoped counters and credential/audit scope, malformed
  unrelated MCP data and complete scoped revocation. Fixtures retain duplicate
  grants, inactive-agent rows, cross-identity grants/pairings, audit redaction and
  visible MCP audit events from another identity. Root's first fixture setup
  omitted ownership fields on synthetic running rows and failed before any test
  ran; the corrected fixture satisfies the existing constraints. No production
  code changed for this setup error. Evidence:
  `.temp/desloppify-cycle57-visibility-live-results.json` and retained
  `.temp/desloppify-cycle57-visibility-fixture-initial-results.json`.
- Parity evidence: 102 real-PostgreSQL baseline/current comparisons preserve
  public results, retained dependency order and error identity/causes, including
  29 error outcomes. Both roles' enriched listings remain equal. In this fixture,
  overview uses four queries instead of five, admin credentials one instead of
  three, scoped credentials/audit two instead of three. These are query counts,
  not latency claims. A2A records are injected while session resolution is real;
  work-failure comparisons use actual failed rows for visible agents, agents
  without a scoped grant, and inactive agents. Admin sees two failures and scoped
  sees one; inactive-agent failures stay excluded from both. Evidence:
  `.temp/desloppify-cycle57-read-parity-output.log`.
- State: source and fixture changes independently reviewed; build/typecheck,
  import law, prompt/shim contracts, all 19 compiled package imports and shared
  `Thread` identity pass. All 3,209 unit tests across 339 files pass without
  failures or skips: `.temp/desloppify-cycle57-unit-results.json`. Committed
  locally with this cycle; reviewed source/test hashes remain unchanged.
  The isolated PostgreSQL cluster was stopped. No schema, production access,
  push or deployment change. Cycle 56 is committed as `4c80f29e`.

### Remaining recon

Actor-pairing fanout remains a separate design task. A `pg-mem` public-method
fixture with 12 identities and two pairings performs 27 Discord reads and nine Telegram reads
despite requesting one row. Discord includes all identities bound to owned
accounts, including deleted identities and actors without current agent pairing;
Telegram/WhatsApp require pairing. Control catches individual identity failures,
whereas the Discord CLI propagates them. A proposed bulk reader must preserve
these scopes, sorting ties, search/page totals, metadata redaction and failure
handling. The supported `listIdentityBindings` identity-existence check stays.
This is not yet a verified deletion opportunity. Runtime-activity pagination and
pool observation ownership remain unresolved.

## Cycle 58 — Reuse runtime text comparison and its filtered array

- Finding: runtime activity text sorting passed collation settings to
  `localeCompare` on every comparison, then copied an already-owned filtered
  array before sorting it. Other Control tables use different comparison and
  pagination rules, so a shared sorting abstraction would obscure policy.
- Change: one module-local `Intl.Collator` retains the default locale, numeric
  ordering and base sensitivity. Sort the fresh filtered array directly.
  Equality, null/empty handling, numeric comparison, stable ties, search,
  clamped pages, SQL, DTOs and the original summary input remain unchanged.
- Result: one additional production line and 30 test lines; cumulative reduction
  becomes 5,490 production lines across 59 cleanup commits, including the 75
  lines previously relocated into tests. The change removes repeated collation
  setup and one full filtered-array copy; it does not reduce database reads or
  improve the default timestamp comparison.
- Evidence: author and independent review pass all 104 Control HTTP tests.
  Two new caller cases cover numeric text, case/accent ties, both null directions,
  filtered page clamping and unchanged unfiltered summaries. Exact source
  reconstruction permits only the constant, string comparison and array-copy
  removal. Author public-method parity passes 490 result/error/SQL comparisons;
  independent comparison covers 2,025 value pairs.
- Root verification: 5,718 actual public-method comparisons across English,
  Slovak and Turkish locales preserve complete results, queries, errors and
  frozen input rows. The adapter is synthetic and opens no database or network
  connection. Evidence: `.temp/desloppify-cycle58-runtime-parity-results.json`.
  All 3,211 unit tests across 339 files pass without failures or skips:
  `.temp/desloppify-cycle58-unit-results.json`. Build/typecheck, import law,
  all 19 compiled package imports and shared `Thread` identity pass.
- State: independently reviewed and committed locally with this cycle. No
  schema, production access, push or deployment change. The earlier Control
  PostgreSQL evidence remains scoped to cycle 57 (`31dd155d`); this cycle changes
  only local sorting and leaves its queries and authorization unchanged.

### Runtime read decisions

Defer SQL pagination until its contract is explicit: summaries use the full
unfiltered inventory, durations may be negative, high pages clamp, descending
nulls come first, text sorts use natural ordering with stable ties, and unknown
sort fields retain query order. Failure-category priority scans raw errors and
can classify running rows; sanitized search still works when stored
`error_summary` is null. A bare SQL limit or different collation would change
the public result. Rewriting the duration summary into a manual accumulation
loop adds four lines and more state; retain the existing expression. Redundant
finite-duration checks at the already-normalized private boundary are a separate
candidate under verification.

## Cycle 59 — Use validated runtime durations

- Finding: `publicRun` checked the finiteness of a duration already derived from
  validated ISO timestamps; the private summary repeated the type/finite checks.
  Its only caller supplies the records produced by `publicRun`.
- Change: inline the duration calculation and exclude only null durations from
  the average. Keep timestamp normalization, field-validation order, numeric
  accumulation order and the existing summary expression. Successful JavaScript
  dates are bounded by ±8.64×10¹⁵ milliseconds, so their difference remains finite.
- Result: one fewer production line and 42 added test lines; cumulative reduction
  returns to 5,491 production lines across 60 cleanup commits, including the 75
  lines previously relocated into tests. The cycle 58 collator and owned-array
  sort remain byte-identical.
- Evidence: eight new public-service cases passed against the baseline before
  implementation; author and independent review then pass all 112 tests in the
  Control HTTP suite. These cases use a controlled query adapter with the actual
  date helpers, covering date limits, negative/zero/missing durations, zero in
  the average and timestamp/status/id/abort validation precedence.
- Parity: 4,830 actual public-method comparisons preserve results, errors and
  query order: 2,458 successful reads and 2,372 error outcomes. They cover real
  Date/string/number timestamp inputs, valid extremes, fractions, invalid values
  and mixed-run pagination. No claim relies on malformed private DTOs that the
  public mapping cannot produce. Evidence:
  `.temp/desloppify-cycle59-duration-parity-output.log`.
- State: independently reviewed and committed locally with this cycle. All
  3,219 unit tests across 339 files pass without failures or skips:
  `.temp/desloppify-cycle59-unit-results.json`. Build/typecheck, import law,
  all 19 compiled package imports and shared `Thread` identity pass. Exact source
  reconstruction permits only the three duration substitutions; timestamp helpers,
  SQL and authorization are unchanged. No schema, production access, push or
  deployment change. Cycle 58 is committed as `94e20aea`.


## Cycle 60 — Batch actor identity reads at the Postgres boundary

- Finding: Discord actor listings repeated identity existence and binding reads
  for every identity; Telegram/WhatsApp repeated them for every agent pairing.
  Fetching only connector-matching rows would change persisted-key normalization
  and hide malformed unrelated bindings that currently invalidate a whole group.
- Change: one internal `readIdentityBindingGroups` reader performs two queries
  for requested identities and all their bindings, then reuses the existing row
  parsers. It restores requested identity order and preserves each group's
  binding order. Equal `created_at` ties have no guaranteed SQL order in either
  implementation. Empty input performs no query. Control omits missing/malformed
  groups; the Discord CLI remains strict and emits no partial output.
- Scope: Discord still includes deleted and unpaired identities bound to owned
  accounts and renders its initial identity snapshot. Telegram/WhatsApp still
  require agent pairing. Disabled owned accounts remain listable. Source and
  connector filtering happen after whole-group parsing; opaque actor values,
  metadata sanitation, stable sorting, search totals and empty high pages remain.
  `IdentityStore`, supported exports, the original `listIdentityBindings`
  existence check and database schema remain unchanged.
- Query result: the identity portion of Discord Control/CLI falls from `1 + 2N`
  reads to three; Telegram/WhatsApp falls from `3P` to two. Here `N` is the full
  identity inventory and `P` is the agent's pairing count. The real-PostgreSQL
  Control fixture uses five total reads for either surface, including unchanged
  authorization/account/pairing reads, as twelve more identities are added.
- Explicit behavior changes: a whole batch-query failure now produces fixed
  HTTP 500 `{error: "internal_error"}` rather than fabricated partial/empty data.
  The mapping includes Telegram setup status, which calls the actor reader.
  Independent review caught and corrected its old HTTP 400 catch. Only
  batch-reader failures receive that mapping; initial authorization,
  connector and Discord inventory failures keep their previous handling.
  Fewer SQL statements change concurrent-update observation and simultaneous
  failure precedence. Successful stable-state results and individual CLI errors
  remain preserved; the two reads do not claim a transaction snapshot.
- Result: 70 production lines added and 25 deleted, net **45 added**. The fixed
  query count earns this cost. Cumulative reduction becomes **5,446 production
  lines across 61 cleanup commits**, including the 75 lines relocated into tests.
  Tests add 539 net lines, including a narrow pg-mem array-query workaround.
- Verification: independent source reviews found no blockers. All **3,247 unit
  tests across 341 files** pass, including 28 new reader/HTTP/CLI cases. Eight
  new real-PostgreSQL caller cases pass after all 25 migrations. They cover text
  array SQL, normalization, whole-group omission, deleted/unpaired/vanishing
  identities, ownership, ordering, pagination, admission and constant query count.
  Evidence: `.temp/desloppify-cycle60-unit-results.json` and
  `.temp/desloppify-cycle60-actors-live-results.json`. The HTTP harness translates
  pg-mem's incorrect `text = ANY(text[])` result; live tests run the actual SQL.
- Gates: root build/typecheck, import law, shim/prompt contracts, all 19 compiled
  package imports and shared `Thread` identity pass. The inspected offline
  common-runtime smoke also passes with 25 migrations, one owned completed run,
  applied input, two injected model responses, one tool call, four messages,
  idle state and zero external requests. That smoke does not exercise actor
  listings; the caller tests above cover this change. Evidence:
  `.temp/desloppify-cycle60-offline-smoke-output.log`.
- State: reviewed and committed locally with this cycle. The isolated test
  cluster was stopped. No production access, push or deployment; the schema
  remains unchanged. Cycle 59 is committed as `25f5690c`.

### Next candidates and rejected reuse

`listIdentities` still repeats binding reads merely to count actors. Reuse of
this reader can remove that fanout while keeping the original identity rows,
visibility and pairing counts. Invalid groups must retain a zero count; global
query failures should reach the existing safe HTTP 500 fallback. Verify these
contracts before changing the caller. Do not reuse this reader for
`listAgentPairings`, which needs no bindings: doing so would over-fetch and hide
valid pairings when unrelated bindings are malformed. The paired-identity
session directory already uses three bounded reads with different scope and
windowing; leave it alone. Runtime-activity pagination and pool observation
ownership remain unresolved.


## Cycle 61 — Reuse batch reads for identity-directory counts

- Finding: `listIdentities` still performed an identity existence read and a
  binding read for each visible identity merely to count actor bindings. The
  preceding cycle's complete-group reader already owns the required parsing.
- Change: send only visible identity IDs to that reader and derive counts from
  valid groups. Preserve the original inventory rows, visibility queries,
  agent-pairing counts, all-source/all-connector counting, status/search filters,
  sorting and pagination. Missing or malformed groups retain their identity row
  with count zero. Empty visibility makes no batch query. No new helper, schema,
  interface or HTTP branch is required; only the six-line count block changes.
- Failure policy: `/identities` now returns the existing sanitized HTTP 500 when
  either batch query fails, rather than inventing zero counts. Global search
  retains its existing best-effort category policy: HTTP 200 with identity hits
  omitted and other categories available. Previously a binding-query failure
  could leave identity hits visible with zero counts. Recon initially overlooked
  the `searchTableRows` catch; direct caller inspection corrected that assumption
  before implementation. No broader search-error rewrite was made.
- Result: six production lines added and six removed; cumulative reduction stays
  **5,446 production lines across 62 cleanup commits**, including 75 lines moved
  into tests. Tests add 188 net lines, with seven new HTTP/service cases and four
  new PostgreSQL cases plus expanded growth coverage.
- Evidence: independent source reconstruction permits only the count-block
  replacement. Author and independent review pass all 125 Control HTTP tests.
  The expanded PostgreSQL suite passes all 12 cases after 25 migrations on a
  fresh disposable database. It covers scoped IDs, all-source/unowned binding
  counts, original rows after an invalid reread, malformed/deleted identities,
  empty visibility, ordering, filters, paging and fixed query count as IDs grow.
  Evidence: `.temp/desloppify-cycle61-actors-live-results.json`.
- Parity: 50 actual baseline/current public-method comparisons match complete
  results, filtering and pagination in one PostgreSQL readonly snapshot. Two
  additional checks establish the deliberate binding-outage policy change.
  In this fixture, admin reads fall from 17 to seven for six identities; scoped
  reads fall from 15 to seven for five visible identities. The binding portion
  is two queries instead of `2M`, or zero for no visible identities. These are
  query counts, not production latency measurements. Evidence:
  `.temp/desloppify-cycle61-directory-parity-output.log`.
- Gates: all 3,254 unit tests across 341 files pass without failures or skips;
  root build/typecheck, import law, all 19 compiled package imports and shared
  `Thread` identity pass. Evidence: `.temp/desloppify-cycle61-unit-results.json`.
  Actor reader, HTTP handlers, CLI, prompt/shim surfaces and runtime lifecycle
  remain unchanged from cycle 60; its offline smoke is earlier evidence, not a
  new smoke run for this cycle. The isolated PostgreSQL cluster was stopped.
- State: reviewed and committed locally with this cycle. No production access,
  push or deployment. Cycle 60 is committed as `0304a002`.

### Pool ownership recon

The observer's optional `getSnapshot` method has no current consumer and is a
separate deletion candidate; verify intentional exports before removal. Defer a
broader observed-pool factory: the readonly pool is created lazily from eagerly
captured settings and is stored for cleanup before observer/log creation.
Combining those paths carelessly changes environment-read timing and loses
ownership if observation setup throws. Existing observer-stop-before-pool-end
ordering remains necessary. Runtime-activity pagination also remains open.

## Cycle 62 — Remove obsolete helpers and a duplicate runtime contract

- Findings: the private bootstrap result repeats 45 fields from the explicit
  public runtime contract. A pool-observer snapshot, HTML snippet helper and
  asynchronous readable-path resolver have no production callers. The daemon
  imports its health implementation through a seven-line forwarding file.
- Changes: derive the private bootstrap result from `RuntimeServices`, excluding
  the four services created later and retaining three bootstrap-only members.
  Keep the public interface and runtime return object explicit. Delete the
  unused observer snapshot (8 lines), HTML helper (11), asynchronous path helper
  and resolver (42), and health facade (7); redirect the daemon to the unchanged
  library implementation. The bootstrap type/import cleanup removes 54 lines.
  Update current architecture prose to require direct internal leaf imports.
- Contract evidence: independent compiler checks compare all 48 private field
  types and optionality, all 19 supported entry declarations and the public
  runtime declaration with `eb34f7b9`. All match. Bootstrap JavaScript is identical
  with source maps excluded. Caller and export checks find no supported surface
  for the removed helpers. The daemon changes only one import specifier; retained
  path, HTML, pool observation and health implementations remain byte-identical.
  Pool logging, query wrappers, cleanup ordering and lazy ownership stay intact.
- Tests: replace five obsolete/direct helper cases with seven command-file
  resolver cases. Six cover file and parent-directory symlink escapes across
  agent-home, shared-workspace and disposable-artifact mounts, preserving
  `ToolError` classification and the live error messages. The seventh verifies
  shared-workspace authorization and an immutable snapshot after source
  replacement. These cases exercise the caller seam; they do not establish
  protection against every possible mid-read race. Test code shrinks by 21 lines.
- Result: 10 production lines added and 132 deleted, net **122 fewer**.
  Cumulative reduction becomes **5,568 production lines across 63 cleanup
  commits**, including 75 lines relocated into tests. Tests, documentation and
  generated metadata are excluded from that production count.
- Verification: all **3,256 unit tests across 341 files** pass with no failures
  or skips, including the retained daemon lifecycle and security cases. Earlier
  focused verification passed 43 pool/runtime, 11 runtime and 21 path/command
  cases. The first web selection hit sandbox `listen EPERM` in three HTTP cases;
  the unchanged selection passed all 41 cases with local socket access. Evidence:
  `.temp/desloppify-cycle62-unit-results.json` and
  `.temp/desloppify-cycle62-web-results.json`.
- Gates: root build/typecheck, import law, shim/prompt contracts, all 19 compiled
  package imports and shared `Thread` identity pass. Prompt snapshot differences
  are restricted to bytes, lines and hashes for `panda-path-context.ts` and
  `runtime-bootstrap.ts`; toolsets, catalog and model-facing text are unchanged.
  Independent review confirms the nine frozen source/test/snapshot states and
  finds no blockers. No fresh PostgreSQL or runtime smoke was needed for these
  unconsumed paths and type-only changes; cycle 60 remains earlier smoke evidence.
- State: reviewed and committed locally with this cycle. No production access,
  push, deployment or schema changes. Cycle 61 is committed as `eb34f7b9`.
  The unused observer snapshot finding is resolved; broader pool-factory changes
  remain deferred for the ownership constraints recorded above.

## Cycle 63 — Delete test-only session and ingress leftovers

- Findings: `enqueueCurrentSessionInput` forwards to the atomic store operation
  but has only a mock-based test caller. Discord's unused default bound handler
  only logs and drops a message; the real service defaults to durable runtime
  request admission. Gateway's unused effective-delivery calculator duplicates
  policy already evaluated from the current stored event type during admission.
- Changes: remove the session wrapper, its exclusive type import and stale
  guidance (24 production lines), Discord's dropping helper (8), and Gateway's
  duplicate calculator (7). Update session documentation to name
  `ThreadRuntimeStore.enqueueSessionInput` and the transaction-client admission
  seam. Retain current-thread resolution, daemon submission, store writes,
  protocol parsing, policy SQL and durable-request handlers byte-for-byte.
- Export evidence: whole-tree caller searches and TypeScript resolution of all
  1,021 exports across 19 supported entrypoints find none of these helpers in a
  supported contract. The session author also compares actual baseline/current
  exported declarations. No public retirement or persistence change is involved.
- Tests: remove exactly three cases that preserve the dead helpers; test code
  shrinks by 73 lines. Existing Discord tests cover real bound callbacks and
  service admission. Gateway's v1/v2 cases change event policy before durable
  admission and verify that queue-only policy wins. Retained session/runtime
  tests exercise actual store and coordinator paths; no replacement mock-only
  or absence tests are added.
- Result: **39 fewer production lines**, bringing the cumulative reduction to
  **5,607 production lines across 64 cleanup commits**, including 75 lines moved
  into tests. Documentation, tests and generated files remain excluded.
- Gates: all **3,253 unit tests across 341 files** pass without failures or skips,
  including the retained ingress tests. The session author's 32 focused tests,
  root build/typecheck, import law, prompt/shim contracts, all 19 compiled package
  imports and shared `Thread` identity pass. The prompt snapshot is unchanged.
  Evidence: `.temp/desloppify-cycle63-unit-results.json`. The six source/test
  hashes match `.temp/desloppify-cycle63-source-freeze.json` after verification.
  No fresh PostgreSQL or smoke run is claimed for these unused-path deletions.
- State: independently reviewed and committed locally with this cycle. No
  production access, push or deployment. Cycle 62 is committed as `227a94c6`.

### Rejected deletion and next recon

Keep `createGatewayDeviceCommandWaiter`: although its factory is used only by
tests, it exposes the same waiter implementation production starts with a
Postgres listener. Removing it would make behavioral tests depend on listener
construction without deleting a second runtime algorithm. The Control UI's
legacy runtime-response fallback and readonly-pool failure ownership are under
separate review; neither is considered resolved by this cycle.

## Cycle 64 — Remove the runtime panel's obsolete response fallback

- Finding: the runtime panel locally filters, sorts, pages and summarizes a
  legacy `{runs}` response even though its only producer returns required
  `summary`, `data` and `meta`. The private UI type incorrectly marks those
  fields optional and advertises the retired response member.
- Change: require the actual response fields, remove `runs`, delete seven
  private fallback helpers, and project the server table and summary directly.
  Preserve empty/loading defaults, nullable duration/latest-run display, all
  controls, query keys, error rendering, authorization links and DOM layout.
  The backend keeps ownership of filtering, ordering, pagination and summaries.
- Compatibility: the same-origin API is the only query producer. QueryClient
  stores responses in memory; persisted table state stores column visibility,
  not responses. The recorded production checkout `8336db3` already returns the
  required fields. This is historical checkout evidence, not a fresh production
  audit. No supported older-backend contract or alternate producer was found.
- Evidence: 705 actual-service baseline/current UI projection comparisons cover
  32 inventories, 11 filter/sort/page inputs, undefined activity, nullable summary
  fields, empty filtered pages, extreme valid dates and different requested
  parameters. Complete values and data/metadata reference identities match.
  Evidence: `.temp/desloppify-cycle64-runtime-ui-parity.mjs` and
  `.temp/desloppify-cycle64-runtime-ui-parity-output.log`.
- Result: 12 UI production lines added and 136 removed, net **124 fewer**.
  Cumulative reduction becomes **5,731 production lines across 65 cleanup
  commits**, including 75 lines moved into tests. Backend source and persistent
  tests are unchanged by this cycle.
- Verification: 30 additional baseline/current comparisons render the actual
  `RuntimePanel` through React server rendering with mocked query, table and
  presentation boundaries. They compare output/props for loading, initial and
  cached errors, fetching with previous data, admin/scoped roles, nullable fields
  and the Show failed runs filter action. This is component parity, not browser
  interaction or a real React Query transition test. Evidence:
  `.temp/desloppify-cycle64-runtime-ui-render.mjs` and
  `.temp/desloppify-cycle64-runtime-ui-render-output.log`.
- Gates: installed Control TypeScript checks and production build pass; Vite
  transforms 3,315 modules. Independent source and documentation reviews find
  no blockers, and both frozen source hashes match after verification. The
  preceding backend suite passed 3,253 tests across 341 files at cycle 63;
  there is no new backend or PostgreSQL claim for this UI-only commit.
- State: reviewed and committed locally with this cycle. No production access,
  push or deployment. Cycle 63 is committed as `49c428ca`.

### Backend read-model boundary

This deletion does not solve full-history hydration. The endpoint performs two
queries rather than an N+1 loop, but reads the full run inventory for unfiltered
summary and error search. Moving paging to SQL must first preserve sanitized
error/category semantics, null ordering, locale-aware text collation, stable
ties, high-page clamping and summary arithmetic. Stored error summaries can be
null for historical rows and are not a proven substitute for current parsing.
There is no configured UI polling interval and no measured production latency
claim. Keep that larger persistence change open until those contracts and
isolated PostgreSQL measurements support it.

## Cycle 65 — Retain ownership after lazy pool initialization rejects

- Finding: shutdown captures a null readonly-pool handle and an in-flight
  initialization promise. That promise can allocate the pool, then reject during
  observation or ready logging. The old catch ignores the rejection without
  refreshing owned handles, so cleanup closes only the three eager pools and
  clears the state that still owns the readonly pool.
- Change: recover the pool and observer from the existing owned state in the
  initialization await's `finally` block. Preserve the caller's original
  rejection, successful initialization, observer-stop-before-pool-end ordering,
  other cleanup steps, lazy allocation, captured configuration and retry policy.
  No factory, new abstraction or public contract is introduced.
- Regression evidence: two tests call the actual `bootstrapRuntime` dependency,
  start its captured readonly command pool acquisition and close bootstrap in the
  same turn. Injected observer-registration and ready-log failures both reproduce
  the old `[1, 1, 1, 0]` pool-end counts and pass with `[1, 1, 1, 1]` after the
  repair. They verify exact error identity and stop-before-end for available
  observers. The independent four-case source probe also checks failure before
  shutdown and during shutdown. Permanent tests do not extract private functions.
- Result: three production lines added and one removed, net **two added**.
  Tests add 49 lines. Cumulative reduction becomes **5,729 production lines
  across 66 cleanup commits**, including 75 lines moved into tests. The resource
  ownership repair earns the small source increase.
- Gates: both new regression tests fail before the fix, all 18 focused tests
  pass afterward, and the final **3,255 unit tests across 341 files** pass without
  failures or skips. Root build/typecheck, import law, prompt/shim contracts,
  all 19 compiled package imports and shared `Thread` identity pass. Independent
  review verifies the frozen source/test hashes and the exact narrow change.
  Evidence: `.temp/desloppify-cycle65-before-results.json`,
  `.temp/desloppify-cycle65-focused-results.json`,
  `.temp/desloppify-cycle65-unit-results.json` and
  `.temp/desloppify-cycle65-frozen.json`.
- Smoke: the inspected offline common-runtime check applies all 25 migrations
  to a fresh isolated PostgreSQL database, completes an owned run with applied
  input, two injected model responses, one tool call and four messages, and
  reaches idle with zero external requests. The cluster is stopped afterward.
  This smoke deliberately avoids application bootstrap; the regression tests
  above establish the shutdown fix. Evidence:
  `.temp/desloppify-cycle65-offline-smoke-output.log`.
- State: reviewed and committed locally with this cycle. Only the bootstrap
  source-file bytes/lines/hash change in the generated prompt snapshot; model
  text and tool contracts remain unchanged. No production access, push or
  deployment. Cycle 64 is committed as `d16ff3d2`.

### Remaining observer initialization ownership

`observePostgresPool` installs a listener, method wrappers and a timer before
its startup log. If that log throws before the function returns its stop handle,
bootstrap can recover and close the pool but cannot stop an observer it never
received. This is a separate initialization rollback gap, not fixed by recovering
already-owned handles. Preserve normal logging/wrapper behavior and original
failure identity when addressing it; do not hide it inside a broad pool factory.
The actual public-observer probe reproduces the retained timer, listener and
wrappers in `.temp/desloppify-observer-startup-rejection-before.json`; its own
resources were cleaned in `finally`, and it made no database or network calls.

## Cycle 66 — Roll back observation when startup logging fails

- Finding: `observePostgresPool` installs an error listener, connect/query
  wrappers and an unref timer before calling its startup logger. If that logger
  throws, the caller receives no stop handle while observation remains active.
- Change: name the existing stop operation locally and reuse it when startup
  logging throws. Keep listener/wrapper/timer/log setup order and all four stop
  statements unchanged. Rethrow the original value even if rollback throws;
  ordinary successful callers receive the same stop behavior.
- Regression evidence: five new cases fail against the unchanged baseline and
  pass after the fix. Actual observer tests verify timer/listener removal,
  retention of an existing listener, no subsequent observer logging, and intact
  promise/callback query behavior. Error, string, null and undefined startup
  failures survive a secondary cleanup failure unchanged. Independent checks also
  retain a prior observer while removing only the failed new observer.
- Result: 17 production lines added and nine removed, net **eight added**.
  Tests add 78 lines. Cumulative reduction becomes **5,721 production lines
  across 67 cleanup commits**, including 75 lines moved into tests. The extra
  lines establish cleanup ownership before the observer can escape its caller.
- Gates: all 45 author-focused tests and 28 independent focused tests pass.
  The final **3,260 unit tests across 341 files** pass with no failures or skips.
  Root build/typecheck, import law, prompt/shim contracts, all 19 compiled package
  imports and shared `Thread` identity pass. Source/test hashes remain frozen;
  source reconstruction permits only the startup-log/stop ownership change.
  Evidence: `.temp/desloppify-cycle66-before-results.json`,
  `.temp/desloppify-cycle66-focused-results.json`,
  `.temp/desloppify-cycle66-unit-results.json` and
  `.temp/desloppify-cycle66-frozen.json`.
- Probe: actual public-observer before/after evidence preserves the complete
  healthy result. Failed startup now leaves no observer timer/listener or later
  observer logging. Restored methods use the existing bound-original semantics;
  identity with the pool's original unbound function is not asserted. Evidence:
  `.temp/desloppify-observer-startup-rejection-after.json`.
- Smoke: the offline common-runtime check passes on a fresh isolated PostgreSQL
  database with 25 migrations, two injected model responses, one tool call, four
  messages, owned completion, applied input, idle state and zero external
  requests. The cluster is stopped afterward. This smoke does not invoke
  observer initialization; focused observer tests establish the fix. Evidence:
  `.temp/desloppify-cycle66-offline-smoke-output.log`.
- State: independently reviewed and committed locally with this cycle. Generated
  prompt metadata is unchanged. No production access, push or deployment.
  Cycle 65 is committed as `7c5c8889`.

### Remaining initialization boundaries

This fixes startup logging after observer installation. Earlier setup exceptions
remain outside this change. A failing cleanup primitive can prevent full
restoration, although it can no longer replace the original startup failure.
Eager bootstrap allocates its pools before its broader cleanup boundary; that
ownership path is under separate review. Do not treat these scoped fixes as
evidence that every possible initialization failure is now covered.

## Cycle 67 — Pass required paginated responses directly to tables

- Finding: Automations and Watches copy already-paginated responses while
  fabricating fallback metadata and array aliases. Gateway adds the same
  fallback through a memo and synthesizes an unused `devices` alias. The actual
  producers require and return `data` and `meta`.
- Change: use the fetched responses directly in all three panels. Read page
  metrics from their existing data arrays. Remove only the response wrappers
  and the unused Gateway response-type import; keep API types, backend task/watch
  aliases, all queries, metrics, forms, filters, authorization and rendering.
- Contract evidence: current producers and recorded checkout `8336db3` return
  required pagination fields. This is historical compatibility evidence, not a
  refreshed production audit. Queries have no persisted response cache or manual
  cache writer. The sole table consumer uses the original inner data array and
  metadata; no effect observes the discarded outer wrapper's identity. Passing
  the fetched object preserves those array/metadata references during refetch.
- Verification: 72 actual baseline/current React component render comparisons
  use 13 DTOs produced by the scheduled-task, watch and operator services.
  They cover undefined/loading data, initial and cached errors, kept previous
  pages with different pending parameters, filtered totals versus page metrics,
  empty/high pages, roles, Gateway source availability and session gating, and
  the source-filter/page-reset callback. Query, presentation and external store
  boundaries are mocked; this proves component parity, not browser lifecycle or
  SQL behavior. Evidence: `.temp/desloppify-cycle67-ui-parity.mjs` and
  `.temp/desloppify-cycle67-ui-parity-output.log`.
- Gates: Control app/node typechecks, production build and scoped diff checks
  pass. Independent review verifies all three hashes and exact whole-file
  reconstruction outside the deleted wrappers. The preceding backend suite at
  cycle 66 passed 3,260 tests across 341 files; no backend source, persistent
  tests, schemas or generated contracts change in this cycle.
- Result: five production lines added and 52 removed, net **47 fewer**: 13 each
  from Automations and Watches, and 21 from Gateway. Cumulative reduction becomes
  **5,768 production lines across 68 cleanup commits**, including 75 lines moved
  into tests.
- State: independently reviewed and committed locally with this cycle. No
  production access, push or deployment. Cycle 66 is committed as `4243972e`.

## Cycle 68 — Own eager pools before initialization can fail

- Finding: `bootstrapRuntime` allocated three observed pools before entering its
  cleanup boundary. Failure on a later startup or ready log left earlier pools
  and observers open. Cycle 66 rolled back the failing observer's startup log,
  but did not own its pool or earlier handles. The actual `createRuntime` probe
  records six failure cases and healthy startup/shutdown in
  `.temp/desloppify-eager-bootstrap-before.json`.
- Change: `src/app/runtime/runtime-bootstrap.ts` records each allocated pool and
  returned observer immediately in private ownership records. Its existing
  `try` now covers eager initialization, and the existing cleanup accepts
  nullable partial handles. No asynchronous factory or general pool framework
  is introduced. The successful return shape, synchronous setup order, readonly
  configuration capture and lazy getter remain unchanged.
- Behavior: a failed initialization closes each allocated pool and stops each
  returned observer. The original rejection is preserved, including `undefined`
  when a later pool close also rejects. Healthy shutdown still stops observers
  before ending pools, in the existing order. A constructor that never returns
  a handle, a throwing observer-stop primitive, or a failing cleanup-error logger
  remains outside the complete-recovery claim.
- Regression evidence: seven new caller-level cases in
  `tests/panda-runtime.test.ts` fail against `51e40c8d`: startup statistics and
  ready logging at each of three pools, plus a secondary cleanup failure.
  The existing healthy case now checks stop/end ordering. The author passed
  35 focused tests; an independent reviewer passed 34 across a different
  three-file set and verified the frozen source and test hashes.
- Gates: **3,267 tests across 341 files** pass with no failures, skips or todo
  cases. Root build/typecheck, import-law ratchet, prompt/shim contracts and all
  19 compiled package imports pass, preserving shared `Thread` identity. All
  981 compiled declaration files match the baseline. Only bootstrap bytes, lines
  and hash change in `scripts/ci/prompt-contracts.snapshot.json`; prompt and tool
  payloads remain unchanged. The source/test freeze is
  `.temp/desloppify-cycle68-frozen.json`; red and full-suite reports are
  `.temp/desloppify-cycle68-before-results.json` and
  `.temp/desloppify-cycle68-unit-results.json`.
- PostgreSQL: the offline common-runtime smoke applies all 25 migrations to a
  fresh disposable local database, completes one owned run with applied input,
  one tool call and four transcript messages, then reaches idle. Model responses
  are injected and external requests are blocked. The cluster is stopped. This
  smoke avoids application bootstrap; focused caller tests verify the actual
  ownership failure paths. Evidence:
  `.temp/desloppify-cycle68-offline-smoke-output.log`.
- Result: 102 production lines added and 91 removed, net **11 added**; most of
  the diff is the earlier `try` boundary's indentation. Tests add 50 lines.
  Cumulative reduction becomes **5,757 production lines across 69 cleanup
  commits**, including 75 lines moved into tests.
- State: independently reviewed and committed locally with this cycle. No
  production access, push or deployment. Cycle 67 is committed as `51e40c8d`.

### Finding carried into cycle 70: subagent-command registration ownership

After bootstrap returns, `src/app/runtime/create-runtime.ts` registers commands
for `runtime.subagent` before its notification-listener cleanup boundary. An
actual caller-supplied `CommandCatalogModule` whose factory throws reproduces
three allocated pools with zero end calls, three remaining observer listeners,
four active intervals and no coordinator stop. The original factory error is
returned. The local probe uses the existing runtime fixture and cleans up its
fake resources afterward; it does not contact a database or production.
Evidence: `.temp/desloppify-subagent-registration.test.ts` and
`.temp/desloppify-subagent-registration-before.json`.

Extend runtime assembly's ownership boundary to cover this supported command
phase, preserving synchronous command registration order, the lazy definition
callback and the existing successful runtime surface. Do not wrap or suppress
the command factory error. Cycle 70 below addresses this separate boundary.

## Cycle 69 — Delete the unused confirmation switch

- Finding: `ConfirmSwitch` in
  `apps/control-ui/src/features/control/confirm-actions.tsx` has no caller.
  The module's only consumer is
  `apps/control-ui/src/features/control/session/briefing-panel.tsx`, which
  imports `ConfirmButton` by name. No namespace import, dynamic lookup, module
  discovery or supported package export exposes the unused component. Control
  UI is a private application; it is absent from the 19 package entrypoints.
- Change: delete `ConfirmSwitch` and its exclusive `Switch` import. Keep
  `ConfirmButton` and `isPromise` byte-for-byte unchanged, preserving their
  synchronous/asynchronous confirmation and retry behavior. Keep the shared
  `apps/control-ui/src/components/ui/switch.tsx`, which remains used by
  `apps/control-ui/src/components/common/form/fields/switch-field.tsx`.
- Verification: exact whole-file reconstruction permits only the two deletions.
  A scan of 1,304 tracked source files verifies the remaining consumer and
  absence of component references or UI module discovery. The primitive,
  briefing caller and package files match the baseline. Independent review
  confirms the frozen hash and reruns the bounded proof. Evidence:
  `.temp/desloppify-cycle69-proof.mjs` and
  `.temp/desloppify-cycle69-proof-output.log`.
- Gates: Control app/node typechecks, TypeScript/Vite production build and scoped
  diff check pass. No persistent absence-only test is added. The preceding
  backend gate remains 3,267 passing tests across 341 files; this cycle changes
  no backend source, schema, API response, generated contract or test file.
- Result: **83 fewer production lines**, with zero added. Cumulative reduction
  becomes **5,840 production lines across 70 cleanup commits**, including 75
  lines moved into tests.
- State: independently reviewed and committed locally with this cycle. No
  production access, push or deployment. Cycle 68 is committed as `eef33f2a`.
  Runtime-activity history reads and custom subagent-command registration
  ownership remain open as recorded above.

## Cycle 70 — Own runtime resources through command registration

- Finding: after `bootstrapRuntime` returned, `createRuntime` assembled the
  coordinator and registered `runtime.subagent` commands outside its cleanup
  boundary. An actual caller-supplied command factory could throw while leaving
  three pools, their observers and the recorder timer alive. The public caller
  reproduction is `.temp/desloppify-subagent-registration-before.json`.
- Change: `src/app/runtime/create-runtime.ts` moves its existing `try` to cover
  post-bootstrap assembly through the successful return. A private nullable
  cleanup reference owns the coordinator immediately after construction. On
  failure, cleanup releases any returned notification listener, then stops the
  coordinator and closes runtime resources. The original rejection survives a
  cleanup rejection. No general resource framework or provider-cache shutdown
  is added to failed assembly.
- Preserved behavior: command registration remains synchronous and ordered by
  its existing phases. The normal close function, timeouts, idempotence,
  provider-cache ordering, definition callback and returned runtime remain
  unchanged. The owner covers Panda's acquired resources; arbitrary external
  side effects inside custom factories are not owned or reversed here.
- Regression evidence: three new cases in `tests/panda-runtime.test.ts` fail
  against `2be8a0dd`: a factory throws, a required factory returns null, and a
  factory throws `undefined` while coordinator cleanup also rejects. The
  enhanced successful case passes on both versions and checks mixed-phase
  command creation and dispatch. The author passes 56 focused tests; independent
  review passes 39 across a different three-file set. It also verifies that all
  15 successful-path statements and 70 other top-level statements are unchanged.
- Gates: **3,270 tests across 341 files** pass with no failures, skips or todo
  cases. Root build/typecheck, import-law ratchet, prompt/shim contracts and all
  19 compiled package imports pass, retaining shared `Thread` identity. All 981
  compiled declarations match the baseline. Only create-runtime bytes, lines
  and hash change in `scripts/ci/prompt-contracts.snapshot.json`. Evidence:
  `.temp/desloppify-cycle70-frozen.json`,
  `.temp/desloppify-cycle70-before-results.json` and
  `.temp/desloppify-cycle70-unit-results.json`.
- PostgreSQL: the offline common-runtime smoke applies 25 migrations to a fresh
  disposable local database and completes one owned run, with applied input,
  one tool call, four messages and idle state. Model responses are injected,
  external requests are blocked, and the cluster is stopped afterward. This
  smoke avoids application bootstrap; focused caller tests cover the repaired
  registration boundary. Evidence:
  `.temp/desloppify-cycle70-offline-smoke-output.log`.
- Result: 164 production lines added and 161 removed, net **three added**;
  most of the diff is indentation. Tests add 65 lines net. Cumulative reduction
  becomes **5,837 production lines across 71 cleanup commits**, including 75
  lines moved into tests.
- State: independently reviewed and committed locally with this cycle. No
  production access, push or deployment. Cycle 69 is committed as `2be8a0dd`.

### Finding carried into cycle 72: cleanup reporting

`src/lib/cleanup.ts` awaits its error reporter inside the cleanup catch. A
reporter rejection stops the remaining cleanup loop. Through the actual
`stopConnectorWorkerRuntime` in `src/integrations/channels/worker-runtime.ts`,
an action-worker stop failure followed by a throwing reporter skips outbound
worker stop and connector-lease release. Healthy shutdown and an ordinary
worker-stop failure with a successful reporter complete the sequence. The
reporter error currently reaches the caller; preserve its observability while
finishing the remaining cleanup steps.

The helper's nullish/truthiness error sentinel also makes `rethrow: true`
silently fulfill after `undefined`, `null`, `false`, zero or an empty string is
thrown. A tagged failure record can retain these values without changing the
ordinary default policy of swallowing reported cleanup errors. Retain current
exception precedence: after completing the sequence, throw the first reporter
failure if present; otherwise `rethrow: true` throws the first cleanup failure.
Keep the exact values without aggregation or wrapping. Caller regressions must
verify that policy before implementation is accepted. The three connector cases
and five falsy-value checks are recorded in
`.temp/desloppify-cleanup-reporting-before.json`; they use supplied local
workers and callbacks with no database, network or persistent resources.

Keep the existing serial cleanup order. Delaying a reporter rejection means
later cleanup must settle first; an already hanging step can delay that
rejection. This repair should not introduce a new timeout framework or change
how an outer default cleanup loop handles a rejected inner cleanup operation.
Cycle 72 below implements that policy.

## Cycle 71 — Delete the orphaned detail-tabs implementation

- Finding: `DetailTabsList` in
  `apps/control-ui/src/components/common/shared/page-layout.tsx` has no caller.
  Its exported `DetailTabInput` type and local `titleCase` function serve only
  that component. Seven consumers import the module's other exports by name;
  no namespace/dynamic import, module discovery, test or supported package
  entrypoint exposes the orphan. Control UI remains a private application.
- Change: delete those three declarations and their separators. All 15 retained
  statements, including six imports, remain byte-for-byte identical. Active
  `DetailPageContent`, its private `DetailContentTabsList`, `PageHeader` and
  breadcrumb/count rendering remain intact. The seven callers and the separate
  `titleCase` in `apps/control-ui/src/components/layout/app-head.tsx` are unchanged.
- Verification: exact whole-file reconstruction and a 1,304-file tracked source
  scan verify the deletion, consumers and absence of module discovery. Root's
  independent AST comparison and a separate reviewer confirm the frozen hash
  and unchanged live statements. Evidence:
  `.temp/desloppify-cycle71-proof.mjs` and
  `.temp/desloppify-cycle71-proof-output.log`.
- Gates: Control app/node typechecks, TypeScript/Vite production build and scoped
  diff check pass. No persistent absence-only test is added. The preceding
  backend gate remains 3,270 passing tests across 341 files; this cycle changes
  no backend source, schema, API response, generated contract or test file.
- Result: **81 fewer production lines**, with zero added. Cumulative reduction
  becomes **5,918 production lines across 72 cleanup commits**, including 75
  lines moved into tests.
- State: independently reviewed and committed locally with this cycle. No
  production access, push or deployment. Cycle 70 is committed as `ca4e803c`.
  Runtime-activity history reads and cleanup-error reporting remain open.

## Cycle 72 — Finish cleanup after error reporting fails

- Finding: `src/lib/cleanup.ts` allowed a failing reporter to abort the remaining
  steps. The actual connector shutdown probe skipped outbound worker stop and
  lease release after an action-worker failure and reporter rejection. Its
  truthy/nullish sentinel also lost falsy failures with `rethrow: true`.
  Before evidence: `.temp/desloppify-cleanup-reporting-before.json`.
- Change: one local tagged failure record retains exact thrown values and the
  distinction between cleanup and reporter failures. Each declared step still
  runs serially. The first reporter failure takes precedence and is thrown
  after remaining steps settle, regardless of `rethrow`. Without reporter
  failure, the default still swallows cleanup errors and `rethrow: true` throws
  the first cleanup error. Errors are neither aggregated nor wrapped; public
  signatures and callback arguments stay unchanged.
- Scope: all 13 source call sites were inspected. Reporters log errors or call
  the supplied reporting callback; none intentionally aborts shutdown. The
  guarantee covers remaining declared steps. A hanging step can delay rejection,
  and sibling operations inside a single failed step are not retried or resumed.
  No timeout policy changes. Inventory:
  `.temp/desloppify-cycle72-cleanup-callers.json`.
- Regression evidence: 25 new cases in `tests/cleanup.test.ts` and
  `tests/channel-worker-runtime.test.ts` cover falsy errors, reporter precedence,
  synchronous/asynchronous and repeated reporting failures, nested default
  cleanup, serial order, callback arguments and actual connector lease release.
  Twenty fail against `ec884cd4`; the compatibility cases already pass there.
  The author passes 84 focused tests across five files after retrying socket
  fixtures outside the sandbox's `listen EPERM` restriction. Independent review
  passes 54 focused tests and verifies the frozen hashes. Root's original public
  probe now releases the lease while returning the same reporter error; its
  healthy/default results remain identical. Evidence:
  `.temp/desloppify-cycle72-frozen.json`,
  `.temp/desloppify-cycle72-before-results.json`,
  `.temp/desloppify-cycle72-independent-results.json` and
  `.temp/desloppify-cycle72-public-probe-after.json`.
- Gates: **3,295 tests across 341 files** pass without failures, skips or todo
  cases. Root build/typecheck, import-law ratchet, prompt/shim contracts and all
  19 compiled package imports pass, retaining shared `Thread` identity. All 981
  compiled declarations and the prompt/tool snapshot remain unchanged.
  Full-suite report: `.temp/desloppify-cycle72-unit-results.json`.
- PostgreSQL: the offline common-runtime smoke applies 25 migrations to a fresh
  disposable local database, completes an owned run with applied input, one
  tool call and four messages, then reaches idle. Model responses are injected
  and external requests are blocked. The cluster is stopped afterward. This
  smoke does not inject cleanup failures; focused helper/connector tests prove
  the repaired failure behavior. Evidence:
  `.temp/desloppify-cycle72-offline-smoke-output.log`.
- Result: 11 production lines added and five removed, net **six added**. Tests
  add 98 lines. Cumulative reduction becomes **5,912 production lines across
  73 cleanup commits**, including 75 lines moved into tests.
- State: independently reviewed and committed locally with this cycle. No
  production access, push or deployment. Cycle 71 is committed as `ec884cd4`.
  Runtime-activity history hydration remains open at the read-model boundary
  recorded after cycle 64; a larger persistence change needs its own evidence.

## Cycle 73 — Delete three unused custom UI components

- Finding: a bounded audit of 98 custom Control/common UI files identifies
  unused `DetailSection` and `DetailSectionLabel` in
  `apps/control-ui/src/features/control/detail-primitives.tsx`, plus unused
  `ProviderModel` in
  `apps/control-ui/src/features/control/model-calls/model-call-context.tsx`.
  The declarations have no caller, dynamic lookup or supported package export.
  Reusable general-library primitive exports are excluded from this audit.
- Change: delete only the three declarations and their separators. All 17
  retained statements, including nine imports, remain byte-for-byte unchanged.
  Live field/loading/error rendering and trace/session links remain intact.
  Provider/model labels already render directly in the list and detail views;
  those views do not call the deleted component.
- Verification: exact whole-file reconstruction and a 1,304-file tracked source
  scan verify the deletion and absence of dynamic/module discovery. Six callers
  import other detail-primitives exports by name; two callers import
  `TraceContext`. Every caller file is unchanged. Root's independent AST check
  and a separate reviewer confirm both frozen hashes and retained statements.
  Evidence: `.temp/desloppify-cycle73-proof.mjs` and
  `.temp/desloppify-cycle73-proof-output.log`.
- Gates: Control app/node typechecks and the TypeScript/Vite production build
  pass once for the complete batch. Scoped diff check passes. No persistent
  absence-only test is added. The preceding backend gate remains 3,295 passing
  tests across 341 files; this cycle changes no backend source, schema, API
  response, generated contract or test file.
- Result: **33 fewer production lines**, with zero added: 24 from the detail
  primitives and nine from model-call context. Cumulative reduction becomes
  **5,945 production lines across 74 cleanup commits**, including 75 lines moved
  into tests.
- State: independently reviewed and committed locally with this cycle. No
  production access, push or deployment. Cycle 72 is committed as `4defcf71`.
  Runtime-activity history hydration remains open; the next recon pass examines
  that larger boundary instead of assuming that a limited SQL page preserves
  the current summary, filtering and ordering contracts.

## Cycle 74 — Remove a channel-input forwarding layer

- Finding: `submitDurableRuntimeRequestInput` copies arguments, renames
  `enqueueOptions` to `options` and delegates to `submitCurrentSessionInput`.
  Its two callers can use that existing operation directly. The wrapper owns
  no route, authority, persistence or reset policy.
- Change: delete the forwarding declaration in
  `src/integrations/channels/inbound-delivery.ts`; retarget remembered-channel
  delivery and `src/integrations/channels/a2a/request-handler.ts`. Retain the
  remembered-route helper and the domain coordinator/store unchanged. Omitted
  options, supplied object identities, queue/wake defaults and route overrides
  retain their behavior.
- Evidence: exact reconstruction permits only the deletion and corresponding
  import/call/property replacements. Seventy-two baseline/current exported
  caller comparisons preserve route and identity handling, authority/drop/
  duplicate ordering, input identity, reset routing and thrown errors. The
  author passes 64 focused tests across four files; independent review passes
  18 current-thread/A2A tests and verifies the same source hashes. All 19
  package entrypoints and 1,021 resolved export symbols exclude the wrapper;
  no dynamic or namespace consumer was found. Reports:
  `.temp/desloppify-inbound-forwarder-tests.json` and
  `.temp/desloppify-inbound-forwarder-parity.json`.
- Gates: root build/typecheck, import law, prompt/shim contracts and all 19
  compiled package imports pass, with shared `Thread` identity. Of 981 compiled
  declaration files, only the deleted internal helper's declaration changes.
  The prompt snapshot is unchanged. The combined frozen worktree passes 3,306
  tests across 341 files, including the separately scoped following shim cases;
  see `.temp/desloppify-cycle74-75-unit-results.json`. No persistent
  implementation-shape test is added.
- PostgreSQL: the offline common-runtime smoke applies all 25 migrations to a
  fresh disposable database, completes an owned run with applied input, one
  tool call and four messages, and reaches idle with zero external requests.
  Injected model responses keep the smoke offline; the cluster is stopped
  afterward. This smoke exercises the unchanged runtime persistence path;
  focused caller tests cover the removed forwarding layer. Evidence:
  `.temp/desloppify-cycle74-offline-smoke-output.log`.
- Result: **16 fewer production lines**; no persistent test changes. Cumulative
  reduction becomes **5,961 production lines across 75 cleanup commits**,
  including 75 lines moved into tests.
- Production recon: the independent
  [runtime-history measurement](./2026-09-05-runtime-history-measurement.md)
  records anonymous read-only evidence and defers selective raw-error loading.
  The largest session has 8,231 runs but only 48,099 raw error bytes. Ranking
  would retain full metadata processing and introduce compatibility policy;
  no endpoint latency benefit is established. Full-history processing remains
  open. No production writes, push or deployment occurred.
- State: independently reviewed and committed locally with this cycle.
  Cycle 73 is committed as `405d5bc8`. The command-shim consolidation is a
  separately scoped following cycle.

## Cycle 75 — Consolidate command-shim JSON execution

- Finding: `execute_json_command` and `mcp_execute_json_command` in
  `scripts/agent-command-shim/panda` duplicate body construction, transport,
  response decoding, artifact output and failure handling. They differ only
  in the success exit policy: native MCP honors `output.exitCode`, then
  `output.isError`; ordinary execution returns zero.
- Change: let the existing executor apply that policy only when passed the
  explicit third argument `mcp`. Replace the seven native MCP calls and delete
  the duplicate function. Earlier generated `--json` dispatch remains
  unflagged. Input parsing, routes, authorization, SIGPIPE handling, shell flags,
  quoted arguments and error envelopes remain unchanged.
- Evidence: exact whole-script reconstruction allows only this consolidation
  and the seven call substitutions. Eleven new public subprocess cases cover
  native/generated exit behavior, explicit zero precedence, null exit fallback,
  artifacts, command failures, permission denials and transport failures. Nine
  cases pass against the original script before implementation; all 188 shim
  tests pass on the final source. Independent review confirms frozen hashes
  and reports 76 baseline/current Bash comparisons plus ten explicit exit-policy
  checks without network access. Artifacts:
  `.temp/desloppify-cycle75-frozen.json`,
  `.temp/desloppify-cycle75-before-results.json`,
  `.temp/desloppify-cycle75-after-results.json` and
  `.temp/desloppify-cycle75-source-proof.json`.
- Gates: the frozen combined source from cycles 74–75 passes **3,306 tests
  across 341 files**, with no failures, skips or todo cases. Bash syntax,
  root typecheck/build, import law and shim/prompt contracts pass. Generated
  routes and the prompt snapshot stay unchanged; all 19 compiled package
  entrypoints retain their exports and shared `Thread` identity. No additional
  PostgreSQL run is needed for this script-only source change; cycle 74's
  offline common-runtime smoke has passed and its cluster is stopped.
- Result: **25 fewer shipped script lines** and 90 added test lines. The
  established `src/` and `apps/` counter remains **5,961 fewer production lines
  across 76 cleanup commits**, including 75 lines moved into tests. The 25
  script lines are additional and are not silently folded into that counter.
- State: independently reviewed and committed locally with this cycle.
  Cycle 74 is committed as `bd92e101`. No production access for this change,
  push or deployment. Runtime-history processing remains open under the
  measured decision recorded with cycle 74.

## Cycle 76 — Import runtime helpers from their owning modules

- Finding: the runtime client obtains daemon constants and generic Postgres
  helpers through assembly modules. Session CLI and observer modules contain
  the same indirection. Importing a constant or stored-context renderer therefore
  pulls in daemon/runtime assembly and unrelated integrations.
- Change: replace five import specifiers across `src/app/runtime/client.ts`,
  `src/app/sessions/cli.ts`, `src/ui/observe/app.ts` and
  `src/ui/shared/stored-thread.ts`. Use the existing `daemon-shared.ts`,
  `lib/postgres-database.ts` and `thread-definition.ts` implementations. Keep
  intentional public reexports and callers that actually assemble the runtime.
  Two tests now substitute the Postgres leaf while retaining its other exports.
- Evidence: exact whole-file reconstruction permits only those import changes.
  Independent TypeScript resolution confirms all 11 changed named bindings
  still refer to identical declarations and types. Separate declaration emits
  preserve all 19 supported entrypoints and six examined internal modules.
  No import-triggered startup contract was found; startup remains inside the
  factory functions. All 63 focused tests across nine files pass.
- Dependency result: with external packages excluded and tree shaking disabled,
  esbuild's static local graph shrinks from 516 to 78 files for the runtime
  client, 518 to 59 for session CLI, 446 to 255 for observer app and 441 to 200
  for the stored-thread reader. These compare the five import substitutions
  within the same source tree. They do not measure process startup or promise
  that the root CLI, which also imports daemon assembly, becomes faster.
  Reproducible evidence: `.temp/desloppify-cycle76-import-proof.mjs`,
  `.temp/desloppify-cycle76-import-proof.json` and
  `.temp/desloppify-cycle76-focused-results.json`.
- Gates: the combined frozen source for cycles 76–78 passes 3,309 tests across
  341 files, root build/typecheck, import law and prompt/shim contracts. All 19
  compiled package imports retain their exports and shared `Thread` identity.
  The prompt snapshot is unchanged. Following Home/PCM changes are separately
  staged; this cycle changes no query, algorithm, schema or function body.
- Result: zero net production lines and one added test line. The established
  counter stays **5,961 fewer production lines across 77 cleanup commits**,
  including 75 relocated into tests; the preceding 25-line shim reduction
  remains separate.
- State: independently reviewed and committed locally with this cycle.
  Cycle 75 is committed as `28f97d90`. No production access, push or deployment.
