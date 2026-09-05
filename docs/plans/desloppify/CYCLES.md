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
