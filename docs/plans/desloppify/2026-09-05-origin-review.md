# Review of local changes against origin/main

## 1. Verdict and scope

**The four reproduced regressions are repaired, with regression coverage.**
The patch preserves SDK configuration property access and public instance
identity, normalizes both sides of failure searches with the same Unicode
collation, and settles known local environment preflight failures without
releasing uncertain external operations. Independent review found no remaining
blocker in these fixes. Two PostgreSQL upgrade fixtures failed on both the
reviewed tree and untouched origin; those separate fixture defects remain
(Panda maintainers, 2026a; local verification, 2026).

Reviewed local `5dc6a50b11915b4f7b2f7eba09fa537886686498` against
`origin/main` at `2a483743e8cdbeb6638382473598d270eff69d8b`: 84 commits and 447
changed files. This includes the two non-cleanup commits for image jobs and
runner-storage context. Review prioritized changed public interfaces,
transactional ownership, cancellation, resource cleanup, authorization, queries,
CLI dispatch and UI consumers. Three independent reviewers inspected separate
areas, then rotated scopes for second and final scouting passes; root verified
the findings and ran the checks below. This is not a claim
that every possible execution or every line received exhaustive verification.

Sections 2 and 3 preserve the pre-patch findings and review evidence; their line
numbers refer to the frozen reviewed revision. Section 3.1 records the repair
and its fresh checks. The production compatibility check used read-only catalog
queries and synthetic strings only. No production writes or deployment occurred.
Disposable databases were stopped after testing. The existing untracked `output/`
was excluded.

## 2. Confirmed findings at the reviewed revision (now repaired)

### 2.1 P2 — SDK wrappers discard valid non-enumerable or inherited options

`src/app/sdk/agent.ts:12` copies options with object spread before calling the
core constructor. Object spread omits prototype getters and non-enumerable
properties; the previous public constructor read those options directly.
A structurally valid options class with an `agent` getter and explicit `model`
constructs correctly at origin, but the new public `Thread` has
`thread.agent === undefined`. Agent-dependent operations then fail.

The same defect exists at `src/app/sdk/thread-runtime.ts:19`. A valid options
class whose `maxConcurrentRuns` getter returns `1` constructs at origin but now
throws `Thread run concurrency must be a positive integer.` Inherited `store`
options are also discarded. The returned-definition spread at line 22 loses
inherited fields as well: a definition with a `thinking` getter returning `high`
resolves to that setting at origin but to `undefined` locally, even with ordinary
literal constructor options. Preserve property access when supplying default
models instead of imposing enumerable-own-property semantics on public options
or returned definitions.
The second pass also traced the same returned-definition spread through the
public runtime factory at `src/app/runtime/create-runtime.ts:244`. Class-based
definitions lose inherited `agent` and `thinking` there too; this is the same
defect with a wider affected surface. Add regression
coverage through the public constructors and factory before considering this
resolved (Panda maintainers, 2026b).

Root independently reproduced the Thread and coordinator cases against an
unmodified archived origin tree, with no database or provider calls. Reproducer:
`.temp/desloppify-origin-review-sdk-repro.mjs`; result:
`.temp/desloppify-origin-review-sdk-repro.json`. The second-pass runtime-factory
probe also reproduced missing `agent` and `thinking` using the actual factory
with mocked database/schema/coordinator and external-service lifecycle seams,
without database or provider calls. Probe:
`.temp/desloppify-second-scout-runtime.test.ts`; result:
`.temp/desloppify-second-scout-runtime.json`. Its one test passed by asserting
the observed regression; it is evidence of breakage, not regression coverage
that demonstrates a fix.

### 2.2 P2 — Unicode failure search can hide exact-title matches

`src/domain/control/work-failures.ts:86` lowercases stored values with PostgreSQL
`lower()`, but the bound search term at line 112 uses JavaScript `toLowerCase()`.
These operations do not share the same Unicode and locale rules. The previous
service lowercased both the field and search term in JavaScript. D11 selected
literal search with correct matching counts, without authorizing this search
contract change (Panda maintainers, 2026c; 2026d).

A real PostgreSQL 18 database with `datcollate = C` and `datctype = C` reproduces
the regression through the actual old/current `ControlOperatorService` methods.
Both revisions read the same synthetic failed scheduled tasks, with the same
fixed visible-agent seam:

| Exact title searched | Origin matches | Local matches | Local matching count |
| --- | ---: | ---: | ---: |
| Plain failure | 1 | 1 | 1 |
| İstanbul | 1 | 0 | 0 |
| Žilina | 1 | 0 | 0 |
| ΣΟΣ | 1 | 0 | 0 |
| Straße | 1 | 1 | 1 |

This hides failures and reports zero matching counts even when the operator
copies the exact title. Keep field and query normalization consistent, and
protect non-ASCII matching with real PostgreSQL coverage. The affected strings
depend on database locale; this probe does not establish production's locale or
claim that every locale produces these same failures. It did not exercise HTTP
or access production.

Reproducer: `.temp/desloppify-second-scout-unicode.mjs`; result:
`.temp/desloppify-second-scout-unicode.json`. The test cluster was stopped after
execution (local verification, 2026).

### 2.3 P2 — Exported Thread no longer recognizes runtime-supplied instances

`src/app/sdk/agent.ts:10` changes the public `Thread` constructor into a subclass
of the core class, while the durable coordinator continues to construct the
core class. A `Thread` passed to public `RunPipeline.preflight` or `postflight`
therefore fails `thread instanceof Thread` when the constructor is imported from
the supported root or kernel-agent entrypoint. Directly constructed public
instances still pass, making behavior depend on how the runtime produced the
object (Panda maintainers, 2026b).

The actual old/current exported classes and public coordinator reproduce this
with ordinary literal options, an in-memory store and a fake provider. A public
preflight guard requiring an exported Thread instance completes at origin but
fails the run locally with `Pipeline requires an exported Thread instance.`
Root independently reran both the identity comparison and the guarded caller
probe. No database, live provider or production calls were made.

This is distinct from section 2.1: preserving configuration properties alone
will not repair public instance identity. Preserve the constructor/instance
relationship at the package boundary and cover objects delivered through public
callbacks, not just direct construction or equality between two exports. D08
relocates model defaults and preserves package convenience; it does not select
this callback contract change (Panda maintainers, 2026c).

Evidence: `.temp/desloppify-third-scout-thread-identity.mjs` and
`.temp/desloppify-third-scout-thread-identity.json`; caller proof:
`.temp/desloppify-third-scout-thread-identity-guard.mjs` and
`.temp/desloppify-third-scout-thread-identity-guard.json`.

### 2.4 P2 — Local preflight failure wedges an environment in provisioning

`src/app/runtime/execution-environment-service.ts:720–724` classifies every
rejection from the creation closure as an uncertain external operation. The
actual HTTP manager client also rejects local URL validation before invoking
fetch. For example, `PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL=not a URL` raises
`Invalid URL` with zero manager requests, but the service leaves the reserved
record in `provisioning` with its operation token (Panda maintainers, 2026e).

An actual baseline/current service comparison reproduces the difference:

| Step | Origin | Local |
| --- | --- | --- |
| Create with invalid manager URL | Throws Invalid URL; state becomes failed | Throws unresolved-outcome error; state remains provisioning |
| Correct URL and stop the same environment | Stops successfully | Rejects because provisioning operation must finish |
| Manager calls before correcting URL | 0 | 0 |

Root imported the full archived origin service and current service, with the
unchanged actual HTTP manager client, synthetic persistence and injected fetch.
A separate stop-only recovery scenario confirms the defect without relying on
same-ID create retries, which the new reservation contract intentionally rejects.
The local stop path never reaches the manager, even after configuration is fixed.
This leaves a reservation requiring manual reconciliation despite known absence
of an external operation. No actual database or network was used.

Validate definite local preflight before reservation/claim, or propagate a
verified pre-dispatch failure category and settle only the owned operation as
failed. Preserve the unresolved-outcome behavior when a request may have reached
the manager. D06 forbids taking over potentially active external operations;
it does not require retaining uncertainty when dispatch never occurred
(Panda maintainers, 2026c).

Evidence: `.temp/desloppify-final-scout-environment.mjs` and
`.temp/desloppify-final-scout-environment.json`. The independent scout's original
probe is `.temp/desloppify-environment-preflight-review.mjs`.

## 3. Verification before the repair

| Check | Result |
| --- | --- |
| Full unit suite | 3,318 passed across 341 files; no failures, skips or todo cases |
| Real PostgreSQL suites | 195 passed, 2 failed across 27 files; no skipped cases |
| Failed PostgreSQL tests on untouched origin | Same two failures reproduced |
| PostgreSQL startup rehearsal | Passed fresh startup, legacy upgrade, unsafe legacy-data rejection and email-policy preservation |
| Root typecheck and build | Passed |
| Control UI typecheck and production build | Passed |
| Import law | Passed |
| Generated command shim and prompt contracts | Passed |
| Shell syntax and committed diff whitespace | Passed |
| Compiled package entrypoints | All 19 imported; root/agent Thread export identity retained |
| Second-scout runtime factory | Actual assembly callback also loses inherited agent/thinking; isolated probe reproduced it |
| Second-scout Unicode comparison | Three exact-title omissions reproduced against origin on PostgreSQL 18, C locale |
| Second-scout command assembly comparison | 146 modules across 6,570 dependency configurations; only ignored extra arguments differed |
| Final-scout public pipeline probe | Origin run completes; current run fails its exported-Thread instance guard |
| Final-scout environment preflight/recovery | Invalid URL sends no request; origin recovers after correction, local stop remains blocked |
| Final-scout identity-group comparison | All 120 synthetic-row comparisons matched; no SQL execution |
| Final-scout TUI comparison | All 160 run-state and 14 usage cases matched actual baseline/current helpers |

The broad suite results above are from the first pass on the same frozen
revisions; the second pass added targeted probes and rotated static review,
without repeating the full suite. Its runtime lifecycle, browser/MCP/shell
cancellation, channel receipt, Gateway, CLI/shim and Control query reviews found
no additional concrete regression beyond sections 2.1–2.2. Command assembly
evidence: `.temp/desloppify-origin-command-wiring-parity.json`.

The final pass additionally reviewed migration/writer boundaries, durable work
ownership and reset, execution-environment operations, transcript/replay,
compaction, image/background jobs, model/provider defaults, identity/authorization,
UI response contracts and terminal presentation. It confirmed sections 2.3–2.4
and found no additional concrete changed-line defect in the other sampled paths.
The identity-group and TUI
probes use synthetic inputs; their evidence is respectively
`.temp/desloppify-origin-identity-group-scout.json` and
`.temp/desloppify-final-scout-tui.json`. These targeted comparisons supplement the
first pass's unchanged full-suite evidence; they do not replace a production
rehearsal.

The two pre-existing failures are:

1. `tests/live/control-identity-revocation.live.test.ts:39`: it migrates to
   `PANDA_SCHEMA_MIGRATIONS.length - 1`, inserts a deleted-identity scenario, then
   expects the final migration to revoke access. The revocation migration is
   already earlier in the catalog, so the fixture no longer tests its intended
   historical transition. The active-grant assertion fails on both revisions.
2. `tests/live/panda-schema-upgrade.live.test.ts:47`: it invokes the current
   agent store after only four historical migrations. That schema lacks the
   live-voice field required by the current row decoder; both revisions fail
   with `Agent row is missing live voice.`

These failures do not demonstrate new production regressions, but they leave
those specific upgrade-fixture assertions unverified. They should be repaired
using their intended historical boundaries/data shapes rather than weakening
production validation.

Tests used Node 26.8.1 and disposable PostgreSQL 18, with the existing installed
dependencies. CI's Node 24/PostgreSQL 16 combination, a clean dependency install,
registry vulnerability audit, real provider/channel calls and a production
cutover were not executed. Passing local checks is not proof of deployment
compatibility on every environment.

Machine-readable evidence is under `.temp/`:
`desloppify-origin-review-unit-results.json`,
`desloppify-origin-review-gates.json`,
`desloppify-origin-review-postgres-results.json`,
`desloppify-origin-review-postgres-gates.json`, and
`desloppify-origin-baseline-postgres-results.json`.

### 3.1 Repair and fresh verification

| Finding | Repair |
| --- | --- |
| SDK configuration loss | Default only the model through property forwarding that retains the original getter receiver; cover frozen plain, inherited, non-enumerable and private-getter inputs through public constructors and `createRuntime`. |
| Public instance identity | Adapt construction while sharing the core prototype, so runtime-supplied threads and coordinators satisfy public `instanceof` checks; preserve subclass construction. |
| Unicode failure search | Lowercase both field and needle with PostgreSQL ICU root collation and retain literal substring matching, matching counts and pagination. |
| Environment preflight recovery | Mark failures known to precede dispatch, settle only the owned claim, and restore a prior idle state for restart/stop; retain unresolved ownership after possible dispatch. |

SDK defaults remain in the application boundary. Ordinary instances retain the
core prototype's `.constructor` property; it is not equal to the public proxy
constructor. Subclass `.constructor`, private fields and `instanceof` remain
intact. The configuration forwarding object is internal and read through property
access; it is not an enumerable copy of the caller's object.

Environment tests also cover duplicate reservations minting no command leases.
Independent probes confirm that a delayed preflight settlement cannot overwrite
a replacement operation. Fetch rejection, HTTP errors and invalid responses
remain potentially dispatched outcomes.

The search patch requires UTF-8 PostgreSQL with `pg_catalog."und-x-icu"`, documented
in [database prerequisites](../../developers/database-migrations.md).
Disposable PostgreSQL 16 and 18 databases used `C` locale with UTF-8 encoding.
The production read-only check confirmed Homebrew PostgreSQL 18.4,
`en_US.UTF-8` locale and the ICU root collation; synthetic `Žilina`, `İstanbul`,
`ΣΟΣ` and `Straße` values lowered as expected. No migration, extension or
production locale change is required (PostgreSQL Global Development Group, 2026).

Fresh validation results and local evidence:

| Check | Result |
| --- | --- |
| New SDK regression tests | 14 passed; independently rerun with the same result |
| New environment regression tests | 14 passed |
| Full unit sweep and focused reruns | All 3,346 cases passed across 342 files on unchanged source; initial timing failures required reruns |
| PostgreSQL 16, UTF-8/C | 54 passed across failure search, environment operations, runtime persistence and run claims |
| PostgreSQL 18, UTF-8/C | All 13 failure-search tests passed, including four new Unicode cases |
| Original public pipeline reproducer after repair | Both origin and repaired runtime complete; public instance guards pass |
| Root typecheck and build | Passed |
| Import law and generated command shim | Passed |
| Prompt contracts | Passed after regenerating only the runtime-factory source checksum and byte count; prompt and tool payloads unchanged |
| Compiled package entrypoints | All 19 imported successfully |
| SDK constructor type compatibility | Generic context/output, optional constructor model, instance aliases and subclassing compile without diagnostics |

The initial unit sweep had 3,283 passes and 63 failures under concurrent host
load. Sixty-one failures were test-runner timeouts; the other two involved a
one-second Bash background wait and a 100-millisecond browser action deadline.
Rerunning all 13 affected files sequentially with a 30-second default timeout
passed 511 of 513 cases, including those Bash/browser cases and the timed-out
environment regression case. All 28 new unit regression cases passed across
the two runs. The two help sweeps initially retained their explicit 15-second
timeout and still timed out. Both then passed an isolated probe with unchanged
assertions and a larger allowance, finishing in 4.3 and 3.7 seconds. A final
focused run of the original test file also passed both under their unchanged
15-second limits, in 1.9 and 2.0 seconds. No tracked timeout or assertion was
changed. Thus every unit case passed across the sweep and focused reruns;
there was no single entirely green full-suite invocation under the earlier load.

The prior two failing upgrade fixtures are outside these focused PostgreSQL
runs. A clean dependency install, CI's Node 24 runtime, live provider/channel
smoke and a production cutover were not exercised by the repair.

Artifacts: `.temp/desloppify-patch-unit.json`,
`.temp/desloppify-patch-unit-rerun.json`,
`.temp/desloppify-patch-unit-combined.json`,
`.temp/desloppify-patch-unit-final.json`,
`.temp/desloppify-patch-shim-final.json`,
`.temp/desloppify-patch-pg16.json`,
`.temp/desloppify-patch-unicode-green.json`,
`.temp/desloppify-sdk-independent-review-tests.json`,
`.temp/desloppify-sdk-identity-guard-after.json` and
`.temp/desloppify-environment-preflight-review-after.json`.

## 4. Intentional compatibility and deployment changes

The watch ownership redesign intentionally replaces the old split settlement
API. The public watch entrypoint removes `CompleteWatchRunInput`,
`RecordWatchEventInput` and `RecordWatchEventResult`, and adds
`AcceptWatchEvaluationInput` and `RenewWatchClaimInput`. The other 18 package
entrypoints retain all prior exported names; that name inventory does not by
itself prove every runtime behavior is compatible. External watch-store adapters
or consumers of retired types need updating.

Migrations 0020–0025 introduce channel receipt ownership, environment-operation
ownership, watch claim ownership, Gateway upload reservations, Gateway input
receipts and runtime error summaries. Stop incompatible writers before migration
and start compatible binaries afterward. An old binary that ignores the new
ownership fields is not a safe rollback. These are the coordinated changes
already selected in the plan, not a rolling-deployment compatibility promise
(Panda maintainers, 2026c).

## 5. Changes grouped by behavior

| Area | One-line change |
| --- | --- |
| Legacy subagents | Delete the obsolete in-process runner and worker-era helpers; retain durable subagent sessions. |
| Watch and heartbeat work | Fence admission and settlement by claim ownership so stale runners cannot settle newer work. |
| Channel delivery | Separate external send success from receipt persistence to prevent blind duplicate sends. |
| Gateway | Reserve upload capacity and atomically commit event, attachment and session-input receipts. |
| Execution environments | Serialize transitions and reject stale completion; the repair restores recovery after known local preflight failure. |
| Session/runtime persistence | Consolidate atomic create/reset, input acceptance, replay and request-result handling. |
| CLI and command policy | Derive help/default eligibility from the catalog and remove duplicate parsers/factories. |
| SDK and models | Move ambient model defaults out of the core; the repair preserves configuration access and public instance checks. |
| Runtime resource lifecycle | Keep ownership of allocated pools/workers and finish cleanup after startup or reporting failures. |
| Browser | Centralize action completion and carry cancellation through sessions, artifacts and cleanup. |
| MCP | Preserve caller cancellation, share execution handling and bound streaming secret redaction. |
| Control reads | Return consistent failure snapshots and consolidate scoped reads; the repair normalizes both sides of Unicode searches consistently. |
| Control UI and terminal | Remove unused components and obsolete response fallbacks; simplify transcript/command projections. |
| Images, attachments and voice | Consume authorized image references, avoid overwrite races, preserve voice errors and share PCM conversion. |
| Prompts and local helpers | Reuse normalization/rendering helpers and explain runner storage and scheduled-command persistence. |
| Schema, docs and dependencies | Add six migrations, document production constraints and remove an unused UI dependency. |

## 6. Every local commit, one line each

This table includes all 84 commits between the two recorded revisions. The first
core commit contains multiple ownership changes; section 5 and the linked plan
explain their behavior.

| # | Commit | One-line change |
| ---: | --- | --- |
| 1 | `5396b95d` | Consume authorized references and contain job failures. |
| 2 | `ca5a689d` | Consolidate durable ownership and remove obsolete paths. |
| 3 | `2e3aa496` | Derive help-only routes from the command catalog. |
| 4 | `161ed329` | Share page action completion and deadline handling. |
| 5 | `779e7647` | Carry latest run directly through stored snapshots. |
| 6 | `8686d315` | Remove copied help stubs from operator modules. |
| 7 | `d33f96f7` | Enforce no-overwrite with exclusive file copies. |
| 8 | `07cabc01` | Remove redundant auth and context projections. |
| 9 | `89dfea95` | Describe runner storage and cron persistence. |
| 10 | `598a7ef4` | Use native abort composition and isolate the test store. |
| 11 | `bd8382a7` | Simplify tools and share catalog resolution. |
| 12 | `338893f2` | Centralize remote start compensation. |
| 13 | `1bcf1e67` | Remove single-use research command factory. |
| 14 | `f040e8b9` | Centralize session access checks. |
| 15 | `90aa0a8c` | Share history text extraction and previews. |
| 16 | `52522e01` | Share image filtering and simplify replay segments. |
| 17 | `544ad3ad` | Share Whisper command execution. |
| 18 | `299c56be` | Delete unused tool scope and payload helpers. |
| 19 | `2cb35981` | Remove unsupported structured form errors. |
| 20 | `a289bc02` | Consolidate ordered daemon worker startup. |
| 21 | `ee4c76f3` | Remove unused Bash secret metadata. |
| 22 | `29b17c94` | Remove redundant subagent prompt projection. |
| 23 | `862832e4` | Honor command cancellation and remove dead progress hook. |
| 24 | `998c2155` | Reuse the existing usage accumulator. |
| 25 | `267fb0e4` | Share persisted request-result polling. |
| 26 | `39540ab9` | Reuse string normalization in Bash audit reader. |
| 27 | `3ac63511` | Centralize background startup cleanup. |
| 28 | `c39f4244` | Remove redundant routes and matchers. |
| 29 | `5a7e3620` | Delete obsolete orphaned-job row parser. |
| 30 | `f79af08a` | Construct schema catalog without forwarding accessors. |
| 31 | `f647451a` | Reuse the app HTTP service contract. |
| 32 | `9559ed62` | Construct transcript entries directly. |
| 33 | `36b47900` | Reuse command string validation. |
| 34 | `b94d5d8b` | Make streaming secret redaction bounded and overlap-safe. |
| 35 | `17cf72c2` | Reuse object-shape guards. |
| 36 | `0f191bdc` | Reuse credential and environment string parsing. |
| 37 | `64a0404e` | Give default tools their own configured client. |
| 38 | `39251993` | Carry caller cancellation through transport cleanup. |
| 39 | `11c7590d` | Centralize assistant-turn finalization. |
| 40 | `a5d84ff7` | Remove unused migration constant exports. |
| 41 | `719074d1` | Own cancellation through session and artifact cleanup. |
| 42 | `f61e43ba` | Remove fixed-argument command factories. |
| 43 | `f899dffd` | Reuse channel email and app string validation. |
| 44 | `07f78739` | Use one mailbox uid lookup. |
| 45 | `21eb310b` | Remove unused filter patch format. |
| 46 | `4e389844` | Share binary row decoding. |
| 47 | `153279f4` | Reuse locale normalization. |
| 48 | `062b8a31` | Dispatch commands through the existing host. |
| 49 | `dd89f05a` | Consolidate profile upserts. |
| 50 | `95d78159` | Reuse matching string validators. |
| 51 | `3871580f` | Remove database and path forwarding modules. |
| 52 | `bc95aa1b` | Share timestamp conversion. |
| 53 | `21c54dc4` | Reuse SQL task lifecycle for display. |
| 54 | `e288e5ad` | Select one latest run per watch. |
| 55 | `243983a3` | Simplify projection protection windows. |
| 56 | `60ffb465` | Remove unused HTML-only reader. |
| 57 | `2aaa7744` | Separate target visibility from agent enrichment. |
| 58 | `7323be65` | Share command access refresh handling. |
| 59 | `4c80f29e` | Inline guarded subagent creation replay. |
| 60 | `31dd155d` | Read visible agent keys without enrichment. |
| 61 | `94e20aea` | Reuse runtime text sorting resources. |
| 62 | `25f5690c` | Trust normalized runtime durations. |
| 63 | `0304a002` | Batch actor pairing reads. |
| 64 | `eb34f7b9` | Batch identity binding counts. |
| 65 | `227a94c6` | Remove obsolete helpers and duplicate bootstrap contract. |
| 66 | `49c428ca` | Delete obsolete session and ingress helpers. |
| 67 | `d16ff3d2` | Remove obsolete runtime response fallback. |
| 68 | `7c5c8889` | Retain lazy pool ownership after initialization failure. |
| 69 | `4243972e` | Roll back observers after startup logging fails. |
| 70 | `51e40c8d` | Remove redundant paginated response wrappers. |
| 71 | `eef33f2a` | Own eager pools throughout bootstrap. |
| 72 | `2be8a0dd` | Delete unused confirmation switch. |
| 73 | `ca4e803c` | Clean up failed subagent command registration. |
| 74 | `ec884cd4` | Remove unused detail tabs implementation. |
| 75 | `4defcf71` | Finish shutdown after error reporting fails. |
| 76 | `405d5bc8` | Remove unused detail and provider components. |
| 77 | `bd92e101` | Remove redundant session-input forwarding. |
| 78 | `28f97d90` | Share JSON command execution. |
| 79 | `ac3aef0b` | Import helpers from their owning modules. |
| 80 | `081b5fe2` | Trust Home task query eligibility. |
| 81 | `213a2484` | Share PCM16 byte conversion. |
| 82 | `31aac169` | Share native channel history parsing. |
| 83 | `16d4c8e3` | Remove forwarding command factory. |
| 84 | `5dc6a50b` | Reuse background preview text helpers. |

## 7. References

- Panda maintainers (2026a) *Local Git comparison, origin/main to 5dc6a50b*.
  Commit list, changed source and repository tests, inspected 5 September 2026.
- Panda maintainers (2026b) *Public SDK convenience constructors and runtime assembly*. Available at:
  [agent.ts](../../../src/app/sdk/agent.ts),
  [thread-runtime.ts](../../../src/app/sdk/thread-runtime.ts) and
  [create-runtime.ts](../../../src/app/runtime/create-runtime.ts)
  (accessed: 5 September 2026).
- Panda maintainers (2026c) *Codebase deslopification plan*, sections 3.2–3.3, 3.6, 3.8, 3.11 and
  4.3. Available at:
  [the production-aligned plan](./2026-09-04-codebase-deslopification.md)
  (accessed: 5 September 2026).
- Panda maintainers (2026d) *Control work-failure snapshot search*. Available at:
  [work-failures.ts](../../../src/domain/control/work-failures.ts)
  (accessed: 5 September 2026).
- Panda maintainers (2026e) *Execution-environment provisioning and manager request preflight*. Available at:
  [execution-environment-service.ts](../../../src/app/runtime/execution-environment-service.ts) and
  [execution-environment-manager-client.ts](../../../src/integrations/shell/execution-environment-manager-client.ts)
  (accessed: 5 September 2026).
- Local verification (2026) *Origin-to-local review results*. Fresh checks and
  baseline reproductions, 5 September 2026; exact artifacts are named in
  sections 2–3.
- PostgreSQL Global Development Group (2026) *PostgreSQL 16: Collation support*.
  Available at: [PostgreSQL documentation](https://www.postgresql.org/docs/16/collation.html)
  (accessed: 5 September 2026).
