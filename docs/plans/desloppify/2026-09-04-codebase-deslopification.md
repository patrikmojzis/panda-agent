# Codebase Deslopification and Architecture Simplification

- **Date:** 4 September 2026
- **Status:** D01–D14 implemented and verified locally on 5 September 2026; not deployed
- **Owner:** Panda runtime, domain persistence, integrations and Control
- **Decision state:** selected designs implemented; compatibility decisions resolved below; existing accepted ADRs remain authoritative
- **Evidence baseline:** audit and production checkout `8336db394d7793502e45958d66b4e108f330a93c`; local implementation starts from `db50ca36`
- **Citation style:** Harvard author–date; audit sources accessed 4 September, implementation verified 5 September 2026
- **Discussion coverage:** original six recommendations, deeper reconnaissance and subagent corrections mapped in §7

## Abstract

Panda's main architectural problem is competing descriptions of the same
behaviour: a command catalog plus a handwritten capability list; transactional
session operations plus sequential substitutes; durable event records plus
separate input admission; and retired worker concepts beside the active
subagent model. Several of these inconsistencies cause observable failures.
The recommendation is to delete obsolete paths, give each durable operation one
owner, and keep policy close to the module that enforces it.

This plan contains fourteen bounded work packages. Start with verified internal
deletions and small correctness fixes, then repair claim ownership and durable
handoffs, and finally simplify construction and read paths. Gateway upload
admission is a separate, larger reliability project. No generic queue framework,
dependency-injection framework or connector rewrite is proposed.

“Slop” here means demonstrably unused code, duplicated policy, misleading
fallbacks or abstractions that spread knowledge across callers. The audit does
not establish who wrote individual lines or whether an AI model wrote them.

## 1. Scope, method and constraints

### 1.1 Reconnaissance

The audit combined direct source and caller inspection, accepted decisions,
existing tests, local dependency-injected probes and independent subagent
passes. The final subagent pass covered durable work, command/environment/
delivery behaviour, and deletion/public-contract checks. Findings were
challenged before inclusion: live table hooks were excluded from deletion, and
existing real-Postgres lifecycle tests were recognised rather than described as
missing.

Evidence labels below distinguish **P** (behaviour reproduced locally with
in-memory dependencies), **S** (source and caller evidence) and **T** (existing
test evidence inspected). A probe is not a production incident report. The
initial findings used local evidence. A subsequent strictly read-only deployment
and database audit is recorded in §8; it did not send messages, mutate Docker,
change production files or write database records. Implementation verification
is tracked separately from the original reconnaissance.

Concurrent session-compaction and heartbeat changes were present during the
audit. They are outside this plan's cleanup scope. References identify symbols
as well as paths because line numbers and construction signatures can move.
Recheck each package against the eventual implementation base before editing.

### 1.2 Non-negotiable architecture

The existing architecture remains the target: `app` assembles; `domain` owns
business concepts and persistence policy; `kernel` owns the provider-neutral
inner loop; integrations own protocol behaviour; `panda` owns configured policy;
and Control owns its human-facing presentation. Concrete leaf imports and deep
modules with narrow interfaces remain the default (Panda Agent, 2026a; Panda
Agent, 2026c).

In particular:

1. Durable work targets a **session** and resolves its current thread inside the
   final admission operation. `/reset` must not strand work on an old thread.
2. Admission locks/rechecks the active session. Archive discards pending work;
   restore does not replay it. Preserve the established owner → session →
   thread lock order where applicable (Panda Agent, 2026b; Panda Agent, 2026q).
3. Postgres remains the production persistence model. Tests substitute complete
   operations or use disposable Postgres; they must not require a second
   persistence algorithm in production code.
4. Human delivery remains channel-specific; Panda-to-Panda delivery remains
   A2A. Connector protocol, media and authority policy stay local.
5. Public exports, persisted shapes and released migrations are contracts.
   “No in-tree caller” is insufficient evidence for breaking an exported
   interface (Panda Agent, 2026i; Panda Agent, 2026n).

## 2. Priorities and delivery sequence

Priority reflects impact, not file size. **P1** protects correctness or durable
work; **P2** improves locality and removes misleading maintenance paths. These
are planning priorities, not assertions of production incident severity.

| Package | Priority | Selected outcome | Evidence | Dependency |
| --- | --- | --- | --- | --- |
| D01 | P2 | Delete verified internal remnants; isolate public-contract cleanup | S, T | None for internal deletions |
| D02 | P1 | Fence watch/heartbeat admission and settlement by claim generation | S | Ownership contract before D03 |
| D03 | P1 | Commit watch event, session input and detector settlement together | P, S | D02 |
| D04 | P1 | Commit Gateway input and event/attachment settlement together | S, T | Transactional input seam from D03 |
| D05 | P1 | Distinguish external send success from receipt-write failure | P, S | None |
| D06 | P1 | Serialize environment transitions and reject stale completion | P, S | None |
| D07 | P1 | Derive default command capability policy from the catalog | P, S | Explicit capability review |
| D08 | P1/P2 | Honour explicit models without ambient default resolution | P, S | Public-contract review for full relocation |
| D09 | P2 | Keep one session creation/reset persistence algorithm | S, T | None; coordinate with concurrent runtime work |
| D10 | P2 | Bind command groups with required, narrow dependencies | S | D07 policy ownership agreed |
| D11 | P1/P2 | Return one truthful Control failure snapshot | S, T | None |
| D12 | P2 | Use exact typed conversation lookup for authority checks | S | None |
| D13 | P1 | Preserve infrastructure errors in live voice commands | P, S | None |
| D14 | P2 | Reserve upload capacity before consuming attachment bodies | P, S | Separate schema/recovery design |

Recommended batches, each containing separate reviewable PRs:

- **Batch A — remove obvious traps:** D01 internal deletions, D05, D07, D08's
  explicit-model correction and D13. Start here for useful, contained changes.
- **Batch B — establish durable ownership:** D02 → D03 → D04; D06 may run in
  parallel. Do not merge a handoff refactor before its fencing tests pass.
- **Batch C — improve locality:** D09, D10, D11 and D12; finish D08 and D01's
  compatibility-gated cleanup at the relevant module seams.
- **Batch D — bounded upload lifecycle:** D14, with its own implementation
  breakdown and resource measurements.

Avoid a single “cleanup everything” PR. In particular, do not combine a
capability grant change with command-construction refactoring, or a schema
migration with unrelated file moves.

The initial discussion recommended starting with the runner deletion, model
defaults and failure dashboard. Deeper reconnaissance moved command-policy
drift, claim fencing, atomic handoffs and receipt handling ahead of cosmetic
restructuring. The batches above describe manageable delivery groups, not a
reason to delay D02 ownership work until every small Batch A cleanup is done.

## 3. Work packages

### 3.1 D01 — Delete the legacy in-process subagent runner and other remnants

**Finding.** `DefaultAgentSubagentService` is an unused in-process runner beside
the active durable `SubagentSessionService`. Its role policy and worker-era
metadata helpers survive through obsolete code or dedicated tests. A second
watch configuration parser is exported from the schema catalog even though
runtime parsing uses `config.ts`. Control also retains unused exports (Panda
Agent, 2026r; Panda Agent, 2026w; Panda Agent, 2026x).

**Deletion manifest.** Recheck imports, re-exports, dynamic access and package
entrypoints immediately before each deletion.

| Target | Selected action | Keep |
| --- | --- | --- |
| `src/panda/subagents/service.ts` | Delete the retired runner and its exclusive types | Durable profile/tool-group subagents |
| `src/panda/subagents/policy.ts` and exclusive role/model mappings | Delete obsolete role policy, `resolveDefaultAgentSubagentModelSelector` and tests that only preserve them | Public `resolveDefaultAgentModelSelector` and built-in prompts used by current profiles |
| `worker`/`workerExtras` in `src/panda/definition.ts` | Delete the unused toolset member and argument; they are not supported package exports | Specialist toolsets still consumed by runtime assembly |
| `src/domain/sessions/worker-metadata.ts` | Delete runtime-unused helpers and their exclusive test | Historical worker metadata migration/backfill code |
| `src/domain/watches/schema-catalog.ts` | Remove unused compact-envelope parsers/getters and stale transport comments | Canonical `config.ts` parsers, catalog schemas, examples and discovery rendering |
| `apps/control-ui/src/pages.tsx` | Delete unused page barrel | Leaf page imports in `app/control-page-routes.tsx` |
| `useGatewayEvents`, `useSessionGatewayEvents`, `useTelegramSetupStatus`, `useBriefing` in Control `queries.ts` | Remove exports/functions with no callers | `useScopedGatewayEvents`, corresponding endpoints and live query helpers |
| `export` on `keepPrevious` in Control `queries.ts` | Remove the unused external export as optional housekeeping | The function and its many same-file callers |
| Legacy subagent-model and `worker_spawn` examples in `.env.example` | Remove obsolete settings/comments with the retired runner | Active default model settings and reserved credential-name policy |

Update the prompt-contract source inventory when removing legacy policy. In
`tests/panda-subagent-policy.test.ts`, delete obsolete role assertions but
retain/move the live specialist-toolset assertions. In `tests/provider.test.ts`,
remove only the legacy subagent environment-selector cases.
Reserved environment names in `src/domain/credentials/types.ts` are a separate
authority policy: deleting old model-selection code does not authorise removing
those restrictions. Preserve concurrent edits to `.env.example`.

A second group is **compatibility-gated**, not automatic deletion:

- `routeMemory`, `outboundQueue`, `channelActionQueue` and `messageAgent`
  injections in `daemon-bootstrap.ts`. They have no production readers found
  in-tree, but their context types are publicly exposed. Move the synthetic
  thread-runtime test's dependencies into that test; remove public fields and
  runtime injection together only through a deliberate compatibility change
  (Panda Agent, 2026p).
- `createDisposableForSession` and `attachSessionToDisposableEnvironment` in
  the environment lifecycle module. They have only test callers in-tree, but
  the runtime exposes the lifecycle object. Move meaningful token/ownership
  tests to the live standalone-create and ready-attach flows before removal.
  Keep historical `created_for_session_id` decoding (Panda Agent, 2026j).
- `maxSubagentDepth` in `RuntimeOptions`/`DaemonOptions` is forwarded without an
  active runtime consumer after the legacy runner. Retire that public no-op
  option deliberately. `subagentDepth` is different: current thread definitions
  initialise it to zero and kernel runtime metadata still emits it. Audit the
  public context/metadata contract before removing it; do not call it unused or
  revive nested durable spawning to justify keeping it (Panda Agent, 2026p).

**Implementation decision.** Preserve the exported context injections and both
public environment lifecycle methods; their supported contracts outweigh the
small internal deletion. The lifecycle methods now use D06 ownership. Keep
actively emitted `subagentDepth` metadata. Accept `maxSubagentDepth` as a
documented deprecated, ignored option and remove its redundant forwarding;
do not reintroduce nested durable spawning. These are resolved compatibility
decisions, not unfinished internal deletions.

**Acceptance.** No internal import, generated contract or intentional package
entrypoint depends on deleted code. Preserve behavioural coverage by moving
useful assertions to current flows; delete tests whose sole purpose is an
obsolete interface. Do not add a framework to replace deleted functions.

### 3.2 D02 — Fence watch and heartbeat claims

**Finding.** Watch claims receive new run IDs, but completion/failure can update
the watch by its ID alone and clear a successor's claim. Heartbeat settlement
checks `claimed_by`, while the deployed audit baseline uses the shared
`heartbeat-runner` label. Local commit `673e23d5` already adds unique claim
ownership and cadence `config_revision`; build on those fields, not a second
heartbeat token system.
After A expires and B reclaims, A can still interfere with B. The initial
finding came from source inspection; subsequent local Postgres verification is
recorded in §8.3. Production incidence was not established (Panda Agent, 2026u).

**Selected design.** Carry a fresh token for each claim generation. Require it
for input admission, success, failure, detector updates and claim release.
Use the existing watch run UUID where it can represent ownership; use a unique
heartbeat claim token without inventing another job ledger. Follow the
scheduled-task module's established ownership semantics without extracting a
generic scheduler.

Include the unused `clearWatchClaim(watchId)` escape hatch in this change. It
clears ownership without a generation check and is exposed by the public
`WatchStore`/`PostgresWatchStore`. Retire it through the claim-contract change,
or replace it with a token-checked operation if a real caller needs one. Do not
leave an unfenced public shortcut alongside otherwise fenced settlement (Panda
Agent, 2026u).

The proposed rule is that an expired claim cannot admit new work; a runner must
renew valid ownership before expiry if its bounded evaluation needs longer.
Use a fresh database timestamp **after acquiring locks** (for example,
`clock_timestamp()`); transaction-start `NOW()` is stale after a lock wait.
Renewal and final admission must both reject a replaced,
disabled or archived claim. Define this once per subsystem, not independently
in success and error handlers.

**Acceptance.** With independent database connections, A claims, expires, B
claims, and A then completes, fails or attempts input admission. B's claim and
state remain intact and A creates no input. Cover disabling, archive/restore,
renewal and late completion. Adding token fields requires an append-only
migration and corresponding archive cleanup/row-decoding changes.

### 3.3 D03 — Make watch acceptance one durable operation

**Finding.** `WatchRunner` separately records an event, submits session input
and settles detector/run state. A local probe observed A → B, persisted the
event, failed input submission, then observed A again. The result was two
polls, one event and zero delivered inputs. There is no pending-event delivery
scan to repair this path. Retries also lack a stable `inputId`; an external
message ID alone is insufficient across reset (Panda Agent, 2026v; Panda Agent,
2026s).

**Selected design.** Add one watch-owned persistence operation for accepting
an evaluation. Inside a single transaction, lock the active session first, then
lock and validate the D02 claim, resolve the current thread, record the event,
insert the input, advance detector state and settle the run. A preliminary
claim read must be non-locking and revalidated after the session lock; taking a
watch/run lock first would reverse archive's lock order. Evaluation/network
work stays outside the transaction. No-change settlement uses the same
ownership rule.

Use the accepted **watch-run UUID as the occurrence and input identity**, with
a new event dedupe key such as `run:<uuid>`. Existing event deduplication uses
content fingerprints: A → B → C → B can return the original B event and stale
payload. Promoting that historical event UUID to permanent input identity would
suppress a legitimate later occurrence across reset. Fingerprints remain
detector state/payload; preserve historical event IDs and do not replay them.
Reuse the existing session-input admission behaviour through
a transaction-client seam, including reset tombstones and transactional wake
notification. Do not call a helper that opens a second connection while holding
the first transaction. The public wrapper may own a transaction; the internal
primitive must accept its caller's client. Current input deduplication catches
SQL `23505` and then queries for the existing input. That cannot be transplanted
unchanged into an outer transaction: the uniqueness error aborts it. Use
conflict-safe SQL or a savepoint before duplicate resolution (Panda Agent,
2026i; Panda Agent, 2026s).

**Acceptance.** Inject failures between writes: all effects roll back together.
Test duplicate replay inside the enclosing Postgres transaction, a lost commit
response, retry after reset, A → B → C → B, archive during evaluation and stale claim
emission. Historical events without a provable input receipt need a separate
audit; replaying all of them is unsafe.

### 3.4 D04 — Replace Gateway's ambiguous handoff with an atomic commit

**Finding.** Delivery reserves an event as `delivering`, enqueues input, then
marks the event delivered and settles attachments. Claims deliberately exclude
`delivering`; tests explicitly preserve this behaviour to prevent duplicate
delivery. A crash between these steps can strand either undelivered or already
admitted work. Simply adding `delivering` to the reclaim query would discard a
real safety constraint (Panda Agent, 2026l).

**Selected design.** Keep guard evaluation outside the transaction. In a
Gateway-owned transaction, lock the active session before event/claim locks,
revalidate claim/source authority, resolve the current thread, admit one stable
input, mark delivery, scrub event text as required and transition attachment
retention. Reuse D03's transaction-compatible, conflict-safe input seam and
preserve `queue` versus `wake`.

Use the durable receipt to resolve a lost commit acknowledgement. New events
must not need a permanent ambiguity state between writes in the same database.
Preserve the guard outcome so a retry does not silently re-run guard policy.

**Acceptance.** Rollback at every write leaves no partial handoff; retry after
an acknowledged or ambiguous commit creates one input across reset. Archive
and attachment retention remain consistent. Existing `delivering` rows require
receipt/input/tombstone inspection. Rows without proof remain explicitly
unresolved under existing retention pending reconciliation, with no automatic
status or payload mutation. Quarantining them would scrub text and change
attachment expiry, potentially destroying reconciliation evidence.

### 3.5 D05 — Separate transport failure from receipt failure

**Finding.** The outbound worker catches `adapter.send` and `markDeliverySent`
in the same block. A local probe completed the external send, failed receipt
persistence and observed `markDeliveryFailed` followed by terminal-failure
cleanup. Channel actions have the same combined failure seam. A lost database
acknowledgement can also mean `sent` committed before an attempted failure
update (Panda Agent, 2026d).

**Selected design.** Separate external execution from receipt settlement.
After adapter success, perform bounded receipt-only retries; never send again
or run transport-failure cleanup merely because recording success failed.
Settlement must be conditional on the owned claim and must not overwrite a
committed terminal success. Resolve ambiguous acknowledgements by reading the
receipt when possible.

Keep exhausted receipt failures distinguishable from transport failures. The
current `pending/sending/sent/failed` model cannot prove what happened after
every process crash. If a durable unknown-outcome state is needed for recovery,
introduce it explicitly with decoding, migration and operator visibility. Do
not silently reinterpret `failed` or promise exactly-once external delivery.
Multi-item partial sends remain a separate delivery-contract problem. Include
worker startup: currently it marks `sending` rows failed. Recover interrupted
sends as explicitly unknown, never automatically resend, and retain claim
ownership so a still-running sender can record a known outcome. Preserve typing
expiry, archive behaviour and operator visibility for uncertain outcomes.

**Acceptance.** Send count remains one after receipt rejection or lost commit
acknowledgement. Cleanup follows a real transport failure only. Failure-record
errors remain observable, retries are bounded, and stale settlement cannot
rewrite another claim or a committed success.

### 3.6 D06 — Give environment transitions exclusive ownership

**Finding.** Stop and restart perform whole-record upserts around Docker calls.
An expired environment may restart even while `stopping`. A probe using the
actual lifecycle class and a gated fake manager produced `stopping →
provisioning → stopped → ready`, with no runner remaining when the database
reported `ready` (Panda Agent, 2026j).

**Selected design.** Reject in-progress transitions before extending TTL or
starting another operation. Replace lifecycle upserts with conditional
transitions that exclusively claim the environment and update only owned
fields. Completion must match the operation that started it. Keep Docker calls
outside database transactions. Route explicit stop, sweep, resolver recovery
and `SubagentPurgeService.stopEnvironment` through this same ownership seam;
the purge path currently calls a standalone stop helper that bypasses it.

A database token alone cannot cancel an old Docker call. Initially do not
reclaim an in-progress external operation until its prior execution is known
to have ended. Recovery must reconcile actual runner state and establish
ownership before performing another stop/create. If takeover is introduced,
the manager must fence operations by runner/operation generation; a token only
on the final database update is insufficient. Preserve setup-script restart
restrictions, scoped credentials and isolated-subagent no-restart behaviour.

**Acceptance.** Gate manager promises to race stop/restart and sweep/resolve.
Only one operation runs, late completion cannot overwrite newer state, metadata
survives, and interrupted operations reconcile honestly. Validate conditional
SQL on Postgres; use a disposable manager environment for external recovery
tests before shipping takeover behaviour.

### 3.7 D07 — Make the catalog own default command eligibility

**Finding.** `defaultPersistentToolPolicy` maintains a large literal capability
list independently of command-module policy. With the actual catalog,
resolver and lease-authority code, both main and branch fallback sessions
granted `web.fetch` but denied registered `web.read`, MCP management and
WhatsApp call commands. This is a policy divergence, not evidence that every
denied command should be enabled (Panda Agent, 2026e).

**Selected design.** Represent default-session eligibility alongside catalog
policy and project selected capabilities in Panda policy assembly. Pass the
resolved policy into the environment resolver. Keep native tool permissions
separate. First preserve existing grants mechanically; then review missing
capabilities as an explicit authorisation delta in a separate change.

Do not grant every registered extension by default. Extensions require explicit
default eligibility for fallback main/branch policy. This eligibility is not a
global ceiling: explicit bindings and subagent snapshots may deliberately grant
commands excluded from defaults. Apply identity, credential mutation,
readonly-Postgres and other execution gates to whichever policy is selected.
Existing persisted binding policies and immutable subagent snapshots must not
be silently widened or narrowed.

**Acceptance.** Test resolver → visible command descriptors → lease execution
with the real catalog: default commands, opted-in and excluded extensions,
disabled integrations, restricted bindings and subagent exclusions. Include an
explicit binding/snapshot granting a command excluded from defaults. Delete
the parallel literal list. Generated routes and prompt discovery remain
projections of the same catalog.

### 3.8 D08 — Remove ambient model selection from explicit-model paths

**Finding.** `Thread`, model-context policy and coordinator `resolveModelConfig`
resolve the runtime default before using an explicitly supplied model. Default
selection reads environment and provider authentication availability, including
filesystem-backed credentials. A local probe setting an invalid `DEFAULT_MODEL` caused explicit
`openai/gpt-5.4` construction and context-policy resolution to fail (Panda Agent,
2026m).

**Selected design.** First fix lazy fallback in all three paths: a valid explicit
model must not evaluate defaults. Coordinate the coordinator edit with the
concurrent compaction work. Then move environment/provider default selection
into Panda configuration or app assembly, passing resolved choices into the
kernel. Keep model parsing and budget calculation deterministic for explicit inputs.

Audit exported constructors and factories before requiring a model everywhere.
`tests/provider.test.ts` explicitly protects environment-default behaviour for
`new Thread({agent})`. Preserve documented convenience through an intentional configured factory, or
make a deliberate package-contract change; do not leave an accidental provider
auth dependency in the kernel as an indefinite compatibility shim. A broader
provider or transcript rewrite is outside this package.

**Acceptance.** Explicit-model behaviour is unchanged by unrelated invalid
default settings or unavailable credential files. Default selection is tested
at its configured factory. Preserve canonical model identity and current
persisted transcript shapes; run public-entrypoint tests for relocated exports.
Preserve unpinned sessions: resolving a runtime fallback must not write that
model into session configuration. Keep explicit runtime configuration →
immutable subagent snapshot → runtime default precedence. Retain the existing
`tests/daemon-threads.test.ts` assertion that a new main session without a
requested model remains unpinned (Panda Agent, 2026m).

### 3.9 D09 — Keep one session lifecycle persistence algorithm

**Finding.** Main/branch creation, reset and subagent creation choose between
transactional operations and sequential writes using concrete-store
`instanceof` checks. Production uses Postgres; orchestration fakes select a
weaker algorithm. Real-Postgres creation/reset coverage already exists. The
problem is duplicated persistence semantics, not a total absence of tests
(Panda Agent, 2026q).

**Selected design.** Runtime assembly supplies complete operations implemented
by `domain/sessions/lifecycle.ts`. Orchestration tests substitute those
operations. Delete sequential persistence fallbacks and their concrete-store
branching. Keep authorisation and orchestration visible while transaction,
receipt and lock details stay inside the lifecycle module.

**Acceptance.** The same persistence operation serves real creation/reset flows.
Retain existing real-Postgres tests and add only missing rollback/replay cases.
Preserve owner → session → thread locks, operation receipts, parent archive
checks, pending-wake clearing and run fences. Check public runtime dependency
injection before removing any advertised custom-store support.

### 3.10 D10 — Bind command groups with honest dependencies

**Finding.** Required runtime dependencies become a broad optional bag in
`AgentCommandModuleDependencies`, then numerous `require…` helpers reconstruct
the guarantees. Tests use empty-object casts to satisfy construction. This
spreads knowledge of missing resources through command definitions (Panda
Agent, 2026f).

**Selected design.** Bind existing command groups to narrow required dependency
slices. Use local `Pick` types where suitable; share an interface only when
multiple consumers need that seam. Keep genuinely optional integrations
explicitly optional and keep metadata discovery independent of live resources.
Preserve the existing catalog, extension ordering and descriptor projections.

Migrate one group at a time, deleting its optional fields, redundant guards and
fabricated test dependencies. Do not introduce a generic service locator,
registration framework or file-per-command rewrite.

The current dependency type and command builders are public exports. Narrow
internal construction first, preserving `extraModules`, registration phases and
external builder behaviour. Retire public signatures only through an explicit
package-contract change; do not delete live guards ahead of that transition.

**Acceptance.** Missing required dependencies fail at construction/typecheck,
while metadata-only discovery still works without opening a pool or contacting
an integration. Execute commands through the real catalog seam in focused tests.

### 3.11 D11 — Return one truthful Control failure snapshot

**Finding.** The home page requests the same failure aggregation four times for
the table and counters. Each aggregation scans multiple sources, caps source
rows before filtering/counting, and turns several query errors into empty
successes. Consequently the interface can hide matching older failures and
present missing data as healthy (Panda Agent, 2026g).

**Selected design.** First add table data and total/critical/warning counters to
one response and migrate the UI; retain response compatibility during that
change. Extract a focused failure-read module, not the entire operator module.
Remove catch-to-empty success: a failed source read fails the snapshot with a
sanitised error instead of producing reassuring zeroes.

The selected count contract is complete matching retained history, not the
latest fifty records per source. Apply visibility, kind and search before SQL
counting/pagination; use deterministic ordering and a consistent snapshot for
rows and counters. Severity affects the table but not the sidebar counters.
If performance later requires a time window, make it an explicit query and UI
contract. A broad SQL rewrite is not required just to remove duplicate requests;
ship those changes separately and measure the final query plan.

**Implementation decision.** Persist the canonical sanitized runtime error in
`runtime.runs.error_summary` when failures or aborts are recorded. Migration
0025 backfills existing rows in bounded batches using a frozen copy of that
sanitizer. SQL searches this projection and returns a generic summary when it
is absent; it never searches raw runtime errors. One read-only repeatable-read
transaction performs scope, literal search, counts and page selection on one
pool client. Exact retained-history counts still require database work across
matching candidates; only application transfer and result materialization are
page bounded. The measurements in §8.3 are synthetic local evidence (Panda
Agent, 2026g).

**Acceptance.** One aggregation per dashboard query state; correct counts with
more than fifty rows in a source; matches beyond the old cutoff; unchanged
scope protection and severity-counter semantics; visible errors instead of
empty success. Validate changed SQL on Postgres and build the Control UI.

### 3.12 D12 — Look up the exact conversation being authorised

**Finding.** Conversation authority lists a connector's bindings and searches
for an exact target even though persistence already exposes an exact-key
lookup. Some command paths then convert typed records to JSON and parse them
back. This adds work and obscures where ownership is checked (Panda Agent,
2026h).

**Selected design.** Authorise through exact `(source, connector,
externalConversationId)` lookup, then assert that the binding belongs to the
current session. Return `ConversationBinding` internally; serialize only at
the command output seam. Keep list operations for discovery.

**Acceptance.** Foreign-session targets still fail closed, channel output shapes
stay stable, and a send authority check does not enumerate unrelated bindings.
Migrate repeated history/action lookups only where they implement this same
policy; protocol-specific parsing remains local.

### 3.13 D13 — Stop translating every voice-store error into a timeout

**Finding.** Discord/WhatsApp voice commands catch broad waiter/store failures
and translate them into timeout or missing-turn/conflict outcomes. A local
failure injection returned these domain outcomes for a database error (Panda
Agent, 2026t).

**Selected design.** Translate only known not-found, conflict and deadline
outcomes. Preserve/classify infrastructure failures through the existing
sanitised command-error seam. Keep cancellation handling intentional; do not
cancel a valid turn merely because a status read failed. Use local typed
outcomes where needed, without a new generic error framework.

**Acceptance.** Real timeout, missing turn, conflict, cancellation and database
failure produce distinct truthful outcomes without exposing connection details
or credentials. Successful calling behaviour remains unchanged.

### 3.14 D14 — Admit uploads before buffering them

**Finding.** Gateway authenticates first, but consumes and buffers the full
attachment before checking pending capacity and byte quota. Pending count and
insertion are separate operations. A local probe confirmed body consumption
preceded rejection at the pending limit. Filesystem/database writes also need
recovery for interrupted uploads (Panda Agent, 2026k).

**Selected design.** Keep the lifecycle in Gateway: authenticate and validate
headers, atomically reserve source capacity, stream into bounded temporary
storage with incremental hashing/type validation, commit metadata, and settle
the reservation. For unknown lengths reserve the maximum accepted bytes and
refund unused capacity on settlement; enforce the body limit while streaming.
Define quota accounting for rejected/disconnected requests explicitly so
aborted uploads cannot bypass ingress limits.

Reservations expire and reconcile after restart. Cleanup removes only proven
temporary/uncommitted files and expired reservations, never retained or
in-flight media. Use existing bounded lifecycle reconciliation and an explicit
pool/resource budget. Preserve idempotency conflict detection: an existing key
must not allow a different body to be accepted silently.

An existing same-key/same-body retry must succeed without reserving a second
pending slot, even when pending capacity is full. Identify the existing record
before new-upload capacity admission, but still validate its incoming body
under byte/concurrency limits. Changed-body retries remain conflicts.

**Implementation decision.** A local concurrency slot and immutable request
deadline begin before the first awaited IP-rate-limit query. Durable admission
reserves declared bytes, or the 10 MiB maximum for unknown lengths. Accepted
new uploads that fail validation or disconnect retain that byte charge; a
successful upload refunds unused bytes into its original quota window. A
request rejected before body admission consumes no byte quota, an intentional
change from buffer-then-reject accounting. Existing attachment retries consume
no new pending slot or byte charge but still obey authentication, body,
concurrency and IP limits.

The private upload directory is created with an ownership marker before
reservation. Committed metadata references the closed file directly. Cleanup
requires either a revoked reservation or database proof of absence after the
original deadline, and rechecks committed file ownership under the admission
lock. Retained and legacy media are outside orphan-directory cleanup. No new
pool is introduced; the existing Gateway pool budget remains five (Panda
Agent, 2026k).

**Acceptance.** Concurrent uploads cannot exceed the pending cap; chunked bodies
without `Content-Length` remain bounded; disconnects, checksum failures,
duplicate keys, metadata failure and restart leave reclaimable state. Test
same-key retries at full pending capacity and measure peak memory under
concurrent maximum-sized requests. Split this package into reservation/schema,
streaming and recovery changes; it is not a drive-by cleanup.

## 4. Verification and release gates

### 4.1 Behavioural test anchors

These are existing suites to extend or retain, not assertions that they already
cover every proposed case. New concurrency/failure cases belong at the public
operation seam; do not pin private helper calls merely to preserve wiring.

| Packages | Existing test anchors | Additional evidence required |
| --- | --- | --- |
| D01, D08 | `tests/package-exports.test.ts`, `tests/public-api-panda-persona.test.ts`, `tests/public-api-root.test.ts`, `tests/provider.test.ts`, `tests/model-context-policy.test.ts`, `tests/thread.test.ts` | Rechecked callers and explicit-model independence |
| D02, D03 | `tests/watch-runner.test.ts`, `tests/watches-postgres.test.ts`, `tests/heartbeat-runner.test.ts` | New real-Postgres claim-generation, rollback and reset-dedupe cases |
| D04 | `tests/gateway.test.ts`, `tests/gateway-delivery.test.ts`, `tests/gateway-attachments.test.ts` | Real-Postgres atomic handoff and lost-acknowledgement cases |
| D05 | `tests/outbound-deliveries.test.ts`, `tests/channel-actions.test.ts`, `tests/channel-worker-runtime.test.ts` | Single external execution despite receipt failure |
| D06 | `tests/execution-environments-postgres.test.ts`, `tests/docker-execution-environment-manager.test.ts` | Concurrent lifecycle calls and interrupted manager reconciliation |
| D07, D10 | `tests/command-authority.test.ts`, `tests/command-visibility.test.ts`, `tests/command-leases.test.ts`, `tests/command-modules.test.ts`, `tests/command-dependencies.test.ts`, `tests/command-extension-shape.test.ts` | End-to-end policy projection and resource-free discovery |
| D09 | `tests/daemon-threads.test.ts`, `tests/subagent-session-service.test.ts`, `tests/live/runtime-persistence.live.test.ts` | Retained atomic lifecycle behaviour without alternate orchestration persistence |
| D11 | `tests/control-auth-http.test.ts` | Postgres counts beyond old limits, query failure and UI snapshot semantics |
| D12 | `tests/channel-send-authority.test.ts`, `tests/conversation-sessions-postgres.test.ts` | Exact lookup and unchanged scope denial |
| D13 | `tests/discord-voice-commands.test.ts`, `tests/whatsapp-call-commands.test.ts` | Infrastructure failures distinguished from domain outcomes |
| D14 | `tests/gateway-attachments.test.ts`, `tests/gateway-attachment-request.test.ts`, `tests/gateway-http-body.test.ts` | Concurrent reservations, memory bounds and restart cleanup |

For persistence changes, use actual Postgres for locks, UUID inference,
transactions and race tests. `pg-mem` and injected stores remain useful for
behavioural orchestration tests but do not establish database concurrency
correctness. Preserve relevant archive/reset coverage in
`tests/live/session-archive.live.test.ts` and
`tests/live/thread-abort-operations.live.test.ts`.

### 4.2 Required commands

Follow the current contribution rules and package scripts (Panda Agent, 2026o):

- Every code package: `pnpm typecheck` and focused tests.
- Imports or ownership moves: `pnpm architecture:import-law:ratchet`.
- Catalog/shim changes: `pnpm agent-command-shim:check`; prompt or context
  changes: `pnpm ci:prompt-contracts`.
- Control changes: `pnpm control:typecheck` and `pnpm control:build` for changed
  built behaviour.
- Runtime, tools, channels, app or provider behaviour: `pnpm smoke` against a
  disposable `TEST_DATABASE_URL` when feasible. Inspect the smoke summary
  before raw logs on failure.
- Migrations: focused real-Postgres migration/upgrade tests and
  `pnpm ci:postgres-startup`; update the schema manifest when schema objects
  change, following the migration guide.
- This plan only: `git diff --check` and verification of named paths, scripts,
  citations and links.

Use the repository's declared package-manager version. Report unavailable
checks accurately rather than treating an installation/environment failure as
a passing validation or a code regression.

### 4.3 Schema and deployment discipline

Allocate migration identifiers when implementation lands; do not reserve the
number currently used by concurrent compaction work. Update schema sources,
row decoding, the executable catalog, version metadata and affected session
views together. Released baseline migrations stay immutable (Panda Agent,
2026i).

Changes to claims or state interpretation require stopping incompatible writers
before migration and starting only compatible binaries afterward. Use the
existing startup/schema contract rather than creating indefinite dual-write
paths. Verify fresh bootstrap, upgrade, transaction rollback and repeated
startup against disposable databases. Rollback must respect schema compatibility;
an old binary is not a safe rollback if it ignores the new ownership fields.

For legacy ambiguous events/sends, produce a bounded reconciliation inventory
with status and receipt evidence, excluding payloads/secrets. Proven admitted
work is settled without replay; unproven effects remain explicitly unresolved.
Do not use this cleanup as authorisation to retry external sends or replay
historical events.

## 5. What this plan deliberately preserves

- Accepted session/thread, archive and channel/A2A decisions. The audit does not
  justify reopening them.
- Historical schema fixtures and worker backfills referenced by migration and
  test machinery. A zero-inbound source graph does not make these dead code.
- Live Control table hooks, the shared data-table entrypoint and scoped Gateway
  query hooks. Their callers were verified.
- Provider-specific parsing, validation, credential checks, lease rules and
  safety limits merely because they look defensive.
- The current persisted transcript shape and concurrent compaction work.
- Real command extension seams and connector-specific behaviour. No generic
  outbound router or plugin framework is introduced.
- MCP connection lifecycle semantics. Stateful handle affinity deserves its own
  design; deleting teardown would exchange one problem for leaked resources.

Do not split `operator-service.ts` or the command catalog solely to reduce line
counts. Extract complete concepts with meaningful policy, and keep related
implementation knowledge local.

## 6. Completion criteria

The programme is complete when the selected packages are delivered with these
observable outcomes:

1. Verified obsolete internal paths are gone; compatibility-gated decisions are
   explicitly resolved rather than quietly breaking package consumers.
2. Default command capability membership has one policy source, and visibility
   agrees with lease execution without widening restricted bindings.
3. A stale automation claimant cannot change successor state or admit input.
4. Watch and Gateway acceptance have one database commit with stable input
   identity across reset; historical ambiguity has an explicit disposition.
5. External transport success is never reclassified as transport failure solely
   because a receipt write failed. Unknown effects are not automatically replayed.
6. Environment state reflects an exclusively owned operation and reconciled
   runner state, including interrupted transitions.
7. Explicit model choices are independent of ambient default discovery, and
   session lifecycle tests exercise the same complete persistence operations
   used in production.
8. Control performs one failure aggregation per query state and reports truthful
   counts/errors; conversation and voice commands preserve their actual domain
   outcomes.
9. Upload capacity is reserved before substantial body consumption, memory is
   bounded by streaming/concurrency limits, and interrupted uploads reconcile.

Track removed production branches, duplicated policy lists, redundant requests
and reproduced failure cases. Do not set a line-deletion quota: claim fencing
and recovery may add code while removing substantial operational complexity.

## 7. Coverage of the complete discussion

This register maps the original answers and subsequent reconnaissance to the
implementation packages. It preserves smaller findings and corrected or
deferred candidates without presenting every early suspicion as a confirmed
bug. The detailed designs and primary-source citations remain in §3.

### 7.1 Original six recommendations

| Original recommendation | Where it is covered | Final scope |
| --- | --- | --- |
| Delete the legacy in-process subagent runner | D01, §3.1 | Delete the 192-line `DefaultAgentSubagentService`, exclusive role policy, model selectors and worker toolset; preserve active durable profiles/prompts and specialist toolsets |
| Move environment-based model selection out of the kernel | D08, §3.8 | First fix eager defaults in Thread, model-context policy and coordinator; then relocate discovery with public-constructor and unpinned-session compatibility |
| Make the failure dashboard one coherent read operation | D11, §3.11 | One page/count snapshot, truthful query failures and complete matching counts; a focused extraction from the operator module |
| Use one session persistence algorithm in production and tests | D09, §3.9 | Remove concrete-store branching and sequential substitutes; retain real-Postgres lifecycle tests and substitute complete operations in orchestration tests |
| Preserve required command dependencies | D10, §3.10 | Narrow required dependency slices for existing command groups; preserve public builders, extensions and metadata discovery |
| Remove unused delivery capabilities from thread context | D01, §3.1, compatibility decision | Preserve the four public context injections for custom tools; no in-tree reader alone does not justify breaking this contract |

The first recommendation is an explicit deletion, not merely a suggestion to
rename or split the runner. No production or test caller was found during the
audit, despite its comment claiming retention for tests (Panda Agent, 2026r).

### 7.2 Findings added by deeper reconnaissance

| Finding from the follow-up answer | Where it is covered | Refinement from independent verification |
| --- | --- | --- |
| Remove the second command allowlist | D07, §3.7 | Default eligibility applies to fallback main/branch policy; it must not become a global ceiling on explicit binding/subagent grants |
| Give watch and heartbeat claims unique ownership tokens | D02, §3.2 | Fence input admission as well as settlement, and retire the unfenced `clearWatchClaim` shortcut |
| Make event-to-input handoff atomic | D03 and D04, §§3.3–3.4 | Separate watch/Gateway transactions; stable input identity, conflict-safe deduplication and session-first lock order |
| Separate successful delivery from receipt persistence | D05, §3.5 | Receipt-only retry after transport success; no blind resend, success overwrite or false terminal-failure cleanup |
| Replace environment lifecycle upserts with owned transitions | D06, §3.6 | The later deterministic probe reproduced a `ready` database record with no runner; database tokens also need honest external-operation recovery |
| Make attachment admission own reservations and streaming | D14, §3.14 | Reserve capacity before body consumption; preserve same-key/same-body retry at full pending capacity and recover interrupted uploads |
| Use exact conversation lookups and retain typed results | D12, §3.12 | Authorise one exact binding, preserve session ownership checks and stop serialising/reparsing internal records |
| Delete unused watch parser wrappers | D01, §3.1 | Remove duplicate compact-envelope parsing; keep canonical parsers and schema discovery |
| Delete legacy worker metadata helpers | D01, §3.1 | Delete the runtime-unused helpers and exclusive tests; keep historical migration backfills |
| Remove retired environment creation/attachment methods | D01, §3.1, alongside D06 | Preserve the public lifecycle methods with the same owned operations as current runtime flows |

### 7.3 Additional subagent findings and qualifications

| Topic | Disposition |
| --- | --- |
| Voice database errors presented as timeout/conflict | Accepted as D13; distinguish known domain outcomes from sanitised infrastructure failures |
| Unused Control page barrel and four query hooks | Accepted in D01; backend endpoints and the live scoped hook remain |
| `keepPrevious` | Remove only its unused export; its implementation is live |
| Legacy depth options and runtime metadata | Included in D01 with distinct public-contract treatment for the unused option and actively emitted metadata |
| Stale `.env.example` subagent/worker settings | Included in D01; reserved credential names remain protected |
| Mixed legacy-policy/current-toolset tests | Delete only legacy assertions; move/preserve current toolset behaviour and update the prompt source inventory |
| Claims that lifecycle behaviour lacked Postgres tests | Corrected: existing real-Postgres tests remain; the problem is the alternate algorithm selected by orchestration fakes |
| Gateway `delivering` recovery | Preserve the intentional anti-duplication constraint; new handoffs become atomic, while legacy ambiguity keeps evidence pending explicit reconciliation |
| Input dedupe inside an outer transaction | Explicitly fix the `23505`/aborted-transaction trap before reusing the input primitive |
| Default model relocation | Preserve model precedence and unpinned sessions; never persist an incidental fallback as an explicit choice |

### 7.4 Candidates retained for context, not scheduled as cleanup

| Candidate | Decision and reason to revisit |
| --- | --- |
| MCP related-call/session affinity | Deferred as a separate design. Each invocation closes its client and attempts Streamable HTTP session termination. That lifecycle can be incompatible with session-scoped handles across calls, but removing teardown alone leaks resources. Revisit with explicit handle lifetime, owner scope, credentials, resource limits and recovery requirements (Panda Agent, 2026y) |
| Archived outbound head row ends a drain pass | Downgraded. `claimNextPendingDelivery` can terminalise one archived candidate and return `null`, but normal archive already terminalises pending deliveries. Keep as an edge-case regression candidate if a reachable stale-row path is demonstrated; it is not established as a normal production stall (Panda Agent, 2026y) |
| Apparently unreferenced Postgres schema modules | Retained. The pre-ledger schema fixture inventory and historical backfills deliberately reference them outside ordinary production imports; frozen baseline migration rules apply (Panda Agent, 2026i) |
| Mobile/table hooks and shared data-table entrypoint | Retained. `useIsMobile`, `useTable`, `useDataTableState` and the data-table barrel have live callers. They are not the unused page barrel/query hooks in D01 (Panda Agent, 2026x) |
| Broad operator/catalog file splitting | Rejected as a goal by itself. D10/D11 extract coherent policy and read operations; line count alone does not justify more indirection |
| Generic outbound router, queue framework or connector rewrite | Rejected within this plan. Existing session ownership, channel/A2A separation, command catalog and shared connector lifecycle are useful seams to preserve |

The earlier import-law check passed at its audit baseline; that does not
certify later concurrent edits. Local probes establish the specific behaviours
described here, not production incidence. Implementation gates in §4 still
apply to every eventual change.

## 8. Production alignment and implementation record

### 8.1 Read-only deployment snapshot

Direct observations through `ssh panda-mini`, 4 September 2026, approximately
22:37–22:41 CEST. These are point-in-time facts, not continuing health guarantees.
The remote checkout was clean at `8336db39`; running compiled schema metadata
and the database ledger ended at **0017**. The image had no revision label, so
checkout identity alone was not treated as image provenance. Homebrew
**PostgreSQL 18.4** serves database `panda` on the host; OrbStack runs core,
Gateway, connector workers, the environment manager and four persistent runners.
All queries used a restricted role, explicit read-only transactions, bounded
statement/lock timeouts and sanitized aggregates. No credentials or transcript
content are reproduced here.

| Area | Observed deployment state | Constraint on this plan |
|---|---|---|
| Sessions | 4 main and 10 branch; all 14 use fallback environment policy; 13 use runtime model defaults | D07 preserves all grants; D08 keeps defaults unpinned and honours overrides |
| Model/auth | `DEFAULT_MODEL=openai-codex/gpt-6-astra`; mounted Codex credentials readable | Preserve configured default/auth resolution at the app/SDK boundary |
| Subagents | 2,641 durable subagent snapshots; 661 historical worker sessions; 4 built-in and 50 custom profiles | D01 is source deletion, never deletion or rewriting of historical sessions/profiles |
| Environments | Manager enabled; 58 retained disposable records, all expired; 177 explicit subagent bindings, including 5 granting `web.read` | D06 must include purge; D07 default exclusions must not restrict explicit grants |
| Watch/heartbeat | 5 enabled watches (including an HTTP snapshot detector); 6 enabled heartbeats; no claims at snapshot | Preserve no-change silence; validate occurrence identity and post-lock expiry on real Postgres |
| Deliveries/actions | No pending/sending rows; no failed rows with nonempty sent receipts; 301 expired typing actions | D05 recovery is a correctness prerequisite, not a demonstrated current stuck queue |
| Gateway | 393 delivered, 47 quarantined, no `delivering`; all 440 current IDs UUID-shaped | D04 still handles schema-permitted non-UUID historical IDs explicitly; no blind casts or replay |
| Uploads | 31 delivered attachments, 26 with elapsed expiry; 3 uploaded and 5 quarantined attachments also past expiry | D14 must not delete retained delivery media merely because expiry elapsed |
| Failure history | 1,382 failed runtime runs and 210 failed scheduled runs retained | D11 single-response work precedes uncapped history; measure against core main pool size 4 |
| Voice | Disabled in core/Discord/WhatsApp; no active calls | D13 preserves disabled-feature behaviour and sanitizes infrastructure failures |
| Integrity | No broken current-thread or conversation references; current-thread/session composite constraints valid | Keep owner → session → thread locking, archive authority and deferred constraints |

The watch sample showed no duplicate emitted event IDs; it does not establish a
production instance of the content-repeat bug. The environment manager is
configured via `PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL` and its token; an initial
probe using the wrong variable name was corrected. Four persistent runners come
from fallback configuration, not disposable-environment database rows.

### 8.2 Deployment conditions

Local `db50ca36` includes **0018** compaction and **0019** heartbeat cadence, which
were absent from the deployment. Building even the deletion-only slice from
that base therefore requires the normal writer-stop/migration/start sequence.
New migrations are append-only; an old binary will reject a newer ledger. Do
not describe a code checkout rollback as a safe database rollback.

D14 preserves **10 MiB per upload, 100 MiB per hour, and 100 pending per source**.
Identical attachment retries retain their pending/byte-quota exemption, with
bounded body validation and concurrency admission. Pre-admission rejects no
longer charge bytes; accepted new uploads keep their reservation charge on
failure and refund unused bytes on verified success. These rules are explicit
and tested in §3.14. D04 retains unresolved historical evidence rather than
auto-quarantining it. No additional
deployment-specific blocker was found for D09, D10 or D12 under their stated
gates; this is not a substitute for implementation tests.

The local catalog now ends at **0025**: receipt ownership (0020), environment
operations (0021), watch claims (0022), upload reservations (0023), Gateway input
receipts (0024) and sanitized runtime errors (0025). Together with 0018/0019,
these require a coordinated deployment of all writers. Old binaries must not
write during or after migration. If an operator deliberately restores an older
database/binary pair, later failures need an explicit summary backfill before
their specific text becomes searchable again; raw errors are never a fallback.
Uncertain external sends and manager operations remain unresolved for explicit
operator reconciliation. This plan does not authorize replay, destructive
historical cleanup or production deployment.

### 8.3 Local execution record

- D01 internal deletions are implemented. One hundred focused tests, Control UI
  typecheck/build and import-law checks passed. Public context/lifecycle methods
  and emitted depth metadata are deliberately retained; the ignored depth option
  is deprecated. The compatibility decisions are resolved in §3.1. Historical
  data and released migrations remain.
- D07 is implemented as explicit catalog eligibility plus injected
  fallback policy. A before/after set comparison preserved all **131** existing
  grants, including recent heartbeat/compaction capabilities; no new grant is
  implied by this cleanup. The policy/authority/discovery/dependency/environment
  verification group passed 108 tests.
- D08 preserves optional-model package construction at explicit SDK entrypoints;
  core model selection is deterministic. Its 301 focused tests, compiled build,
  package self-import probes and import-law checks passed.
- D12/D13 exact conversation authority and truthful voice errors are implemented;
  channel, voice and all 173 shim tests passed. Unexpected voice-state errors
  expose a sanitized category, not infrastructure details.
- D09 complete lifecycle operations replace production/test algorithm branching.
  Focused orchestration checks and 23 existing real-Postgres lifecycle/concurrency
  cases passed; no schema or persisted transcript change was required.
- D05 receipt fencing and startup uncertainty are implemented; 73 focused/checksum
  and 10 real-Postgres tests passed. Unknown action/delivery attention is included
  in the Control snapshot. Exported receipt mutations now require claim tokens;
  this is an intentional API change, not blanket compatibility preservation.
- D02/D03 implement watch-run UUID ownership, atomic outcome/input acceptance and
  heartbeat claim fencing. The final package checks passed 72 focused/checksum
  and 38 real-Postgres cases, including the existing runtime persistence suite.
  Split watch completion/event mutation APIs are intentionally removed.
- D06 implements exclusive environment operations and purge ownership, including
  holding the matched row lock through filesystem removal. Seventy-five focused,
  30 manager-boundary and 15 real-Postgres cases passed. Uncertain manager results
  remain explicitly unresolved; there is no automatic timeout takeover.
- D04 uses a separate UUID receipt without rewriting historical text event IDs.
  Atomic admission, reset, stale claims, lost acknowledgements, attachment expiry
  and cleanup races passed 18 real-Postgres cases, including cleanup refusal for
  an attachment outside the agent media root. Guard assessment is persisted once;
  legacy `delivering` events are preserved for explicit reconciliation.
- D10 binds all command families through required narrow services. Public
  metadata-only construction remains supported; boundary guards are intentional.
  Redundant dependency reconstruction and fabricated dependency-test inputs are
  removed. The catalog metadata/order digest and all 173 shim tests are preserved.
  D07 review also exposed conflicting extension eligibility within a shared
  capability; fallback construction now rejects that configuration through the
  real lease-authority evaluator, without a second allowlist.
- D11 performs SQL search/count/pagination over stored sanitized summaries.
  Its synthetic local fixture contains 1,594 scoped failures; a stress variant
  adds 50,000 completed runs and 5,000 succeeded scheduled runs. A 20-row page
  plus counters used one client, four statements and 8,377 response bytes.
  `EXPLAIN ANALYZE` measured 24.609 ms execution in the isolated stress run and
  231.382 ms during concurrent local verification; both used 965 shared-buffer
  hits and zero temporary writes. Existing indexes were sufficient for those
  measurements; no new index was added. Twelve simultaneous snapshots also
  passed with a pool limit of four. These are local synthetic measurements, not
  production latency promises or a production data copy.
- D14 reserves upload capacity before reading bodies, streams to owned storage,
  and reconciles expired reservations without deleting committed media. Tests
  cover commit acknowledgement loss, cleanup/commit races, quota windows,
  deadlines across database waits and blocked writes, and full-quota retries.
  Eight concurrent 10 MiB uploads all returned HTTP 201. With clients in a
  separate process, observed server RSS rose by 36,274,176 bytes (34.6 MiB),
  array buffers by 14,255,174 bytes (13.6 MiB) and heap by 6,192,584 bytes
  (5.9 MiB). This is an observed resource probe, not a brittle CI threshold.
- Migrations 0020–0025 are registered; checksum and DDL-boundary checks pass.
  The generated schema manifest is current through 0025. Fresh bootstrap,
  legacy-minimal upgrade, rejection of three unsafe legacy fixtures and the
  email-recipient upgrade passed the startup rehearsal through 0025.
- Final broad verification passed **329 unit-test files / 2,918 tests** and
  **14 real-Postgres files / 132 tests**. The latter includes all new ownership,
  acceptance, upload and failure-snapshot suites plus existing lifecycle,
  heartbeat, compaction, archive and abort coverage. Earlier failures exposed
  stale fixtures for new clock functions, canonical summaries and expired claim
  admission. The upload ownership race now uses explicit gates and durable expiry;
  it no longer assumes every healthy request completes within 100 ms under load.
- Root typecheck/build, import-law ratchet, generated shim, prompt contracts,
  Control typecheck/build and `git diff --check` pass. All 19 compiled package
  entrypoints import successfully and preserve root/subpath `Thread` identity.
  A final import-placement cleanup was followed by a build, import/prompt checks
  and 19 focused runtime/SDK/export tests. The plan and changed subsystem docs
  have 110 valid local links; all 25 Harvard references resolve.
- The final disposable-database model smoke passed with the configured
  `openai-codex/gpt-6-astra` model: expected reply, no failed runs and an idle
  thread. Its local ignored evidence is
  `.temp/runtime-smoke/deslop-final-20260905/summary.json`; unit and database
  reports are `.temp/deslop-frozen-unit-results.json` and
  `.temp/deslop-final-live-results.json`. This smoke exercises core startup and
  a model turn; it is not a production rollout or an external-channel test.
- Database verification uses an isolated, disposable local Postgres cluster.
  No production migration, restart, deployment or database write is authorized
  by the production reconnaissance request.

## References

Source citations below are repository-local; §8 records direct deployment observations. The year suffixes distinguish works by the
same corporate author and are ordered by title. Links refer to the working tree;
the evidence baseline above identifies the audited revision context. Deleted
source names are retained as historical evidence at that revision, not broken
links or proposed restorations.

Panda Agent (2026a) *Accepted architecture guardrails*. Available at: [ADR 0001](../../developers/adr/0001-runtime-architecture-guardrails.md) (Accessed: 4 September 2026).

Panda Agent (2026b) *Accepted session archive decision*. Available at: [ADR 0002](../../developers/adr/0002-session-archive-lifecycle.md) (Accessed: 4 September 2026).

Panda Agent (2026c) *Architecture and domain vocabulary*. Available at: [architecture](../../developers/architecture.md) and [vocabulary](../../developers/vocabulary.md) (Accessed: 4 September 2026).

Panda Agent (2026d) *Channel transport and receipt settlement*. Available at: [outbound worker](../../../src/domain/channels/deliveries/worker.ts), [outbound persistence](../../../src/domain/channels/deliveries/postgres.ts) and [action worker](../../../src/domain/channels/actions/worker.ts) (Accessed: 4 September 2026).

Panda Agent (2026e) *Command capability catalog and fallback policy*. Available at: [catalog](../../../src/panda/commands/agent-command-modules.ts), [environment resolver](../../../src/app/runtime/execution-environment-resolver.ts) and [lease authority](../../../src/domain/execution-environments/command-authority.ts) (Accessed: 4 September 2026).

Panda Agent (2026f) *Command construction and runtime dependency wiring*. Available at: [runtime dependencies](../../../src/app/runtime/command-dependencies.ts), [command modules](../../../src/domain/commands/modules.ts), [catalog binding](../../../src/panda/commands/agent-command-modules.ts) and [module tests](../../../tests/command-modules.test.ts) (Accessed: 4 September 2026).

Panda Agent (2026g) *Control failure listing and dashboard consumption*. Available at: [failure snapshot](../../../src/domain/control/work-failures.ts), [error-summary migration](../../../src/app/database/migrations/0025-runtime-error-summary.ts), [operator reads](../../../src/domain/control/operator-service.ts), [home page](../../../apps/control-ui/src/features/control/pages/home-page.tsx), [query hooks](../../../apps/control-ui/src/features/control/api/queries.ts), [HTTP tests](../../../tests/control-auth-http.test.ts) and [Postgres failure tests](../../../tests/live/control-work-failures.live.test.ts) (Accessed: 4–5 September 2026).

Panda Agent (2026h) *Conversation lookup and send authority*. Available at: [authority](../../../src/domain/channels/conversation-authority.ts), [conversation persistence](../../../src/domain/sessions/conversations/repo.ts) and [authority tests](../../../tests/channel-send-authority.test.ts) (Accessed: 4 September 2026).

Panda Agent (2026i) *Database migration protocol*. Available at: [migration guide](../../developers/database-migrations.md), [transaction helper](../../../src/lib/postgres-transaction.ts) and [frozen baseline entrypoint](../../../src/app/database/migrations/0001-pre-ledger-baseline.ts) (Accessed: 4 September 2026).

Panda Agent (2026j) *Execution environment transitions and storage*. Available at: [lifecycle operations](../../../src/app/runtime/execution-environment-service.ts), [Postgres store](../../../src/domain/execution-environments/postgres.ts), [Docker manager](../../../src/integrations/shell/docker-execution-environment-manager.ts) and [environment documentation](../../developers/execution-environments.md) (Accessed: 4 September 2026).

Panda Agent (2026k) *Gateway attachment admission*. Available at: [acceptance](../../../src/integrations/gateway/attachment-acceptance.ts), [bounded request streaming](../../../src/integrations/gateway/attachment-request.ts), [owned file storage](../../../src/integrations/gateway/attachment-storage.ts), [attachment tests](../../../tests/gateway-attachments.test.ts) and [Postgres upload tests](../../../tests/live/gateway-uploads.live.test.ts) (Accessed: 4–5 September 2026).

Panda Agent (2026l) *Gateway event admission and settlement*. Available at: [delivery](../../../src/integrations/gateway/delivery.ts), [persistence](../../../src/domain/gateway/postgres.ts) and [ambiguity/reclaim tests](../../../tests/gateway.test.ts) (Accessed: 4 September 2026).

Panda Agent (2026m) *Kernel model selection and context policy*. Available at: [Thread constructor](../../../src/kernel/agent/thread.ts), [configured model selection](../../../src/panda/defaults.ts), [configured Thread entrypoint](../../../src/app/sdk/agent.ts) and [configured coordinator entrypoint](../../../src/app/sdk/thread-runtime.ts), [context policy](../../../src/kernel/models/model-context-policy.ts), [coordinator model configuration](../../../src/domain/threads/runtime/coordinator.ts), [session model precedence](../../../src/app/runtime/thread-definition.ts), [provider authentication](../../../src/integrations/providers/shared/auth.ts), [default-constructor contract test](../../../tests/provider.test.ts) and [unpinned-session test](../../../tests/daemon-threads.test.ts) (Accessed: 4 September 2026).

Panda Agent (2026n) *Package entrypoints and public contract tests*. Available at: [package exports](../../../package.json), [export tests](../../../tests/package-exports.test.ts), [persona contracts](../../../tests/public-api-panda-persona.test.ts) and [root contracts](../../../tests/public-api-root.test.ts) (Accessed: 4 September 2026).

Panda Agent (2026o) *Repository verification commands and contribution rules*. Available at: [package scripts](../../../package.json) and [agent instructions](../../../AGENTS.md) (Accessed: 4 September 2026).

Panda Agent (2026p) *Runtime session context injection*. Available at: [bootstrap injection](../../../src/app/runtime/daemon-bootstrap.ts), [context interface](../../../src/app/runtime/panda-session-context.ts), [runtime options](../../../src/app/runtime/create-runtime.ts), [daemon options](../../../src/app/runtime/daemon-shared.ts), [thread definition](../../../src/app/runtime/thread-definition.ts), [kernel metadata contract](../../../src/kernel/agent/runtime.ts), [metadata emission](../../../src/kernel/agent/thread.ts), [runtime entrypoint](../../../src/app/runtime/index.ts) and [thread runtime tests](../../../tests/thread-runtime.test.ts) (Accessed: 4 September 2026).

Panda Agent (2026q) *Session creation and reset persistence*. Available at: [lifecycle transactions](../../../src/domain/sessions/lifecycle.ts), [daemon orchestration](../../../src/app/runtime/daemon-threads.ts), [subagent orchestration](../../../src/app/runtime/subagent-session-service.ts) and [real-Postgres lifecycle tests](../../../tests/live/runtime-persistence.live.test.ts) (Accessed: 4 September 2026).

Panda Agent (2026r) *Subagent remnants and worker metadata*. Available at: retired runner (`src/panda/subagents/service.ts` at the audit baseline; removed in D01), legacy policy (`src/panda/subagents/policy.ts` at the audit baseline; removed in D01), [toolsets](../../../src/panda/definition.ts), [model defaults](../../../src/panda/defaults.ts), worker helpers (`src/domain/sessions/worker-metadata.ts` at the audit baseline; removed in D01), [active built-in profiles](../../../src/domain/subagents/builtins.ts), [example configuration](../../../.env.example), [reserved credential names](../../../src/domain/credentials/types.ts), [retained current toolset tests](../../../tests/panda-subagent-toolsets.test.ts) (split from the retired policy test file) and [prompt source inventory](../../../scripts/ci/prompt-contracts.ts) (Accessed: 4 September 2026).

Panda Agent (2026s) *Thread input identity and admission*. Available at: [Postgres input admission and reset tombstones](../../../src/domain/threads/runtime/postgres-inputs.ts) (Accessed: 4 September 2026).

Panda Agent (2026t) *Voice turn error handling*. Available at: [Discord voice commands](../../../src/integrations/channels/discord/voice-commands.ts) and [WhatsApp call commands](../../../src/integrations/channels/whatsapp/calls/commands.ts) (Accessed: 4 September 2026).

Panda Agent (2026u) *Watch and heartbeat claim ownership*. Available at: [watch claims and settlement](../../../src/domain/watches/postgres.ts), [watch store contract](../../../src/domain/watches/store.ts), [watch public exports](../../../src/domain/watches/index.ts), [heartbeat runner](../../../src/domain/scheduling/heartbeats/runner.ts), [heartbeat persistence](../../../src/domain/sessions/postgres.ts) and [scheduled-task fencing precedent](../../../src/domain/scheduling/tasks/postgres.ts) (Accessed: 4 September 2026).

Panda Agent (2026v) *Watch evaluation and event handoff*. Available at: [runner](../../../src/domain/watches/runner.ts), [watch persistence](../../../src/domain/watches/postgres.ts) and [runner tests](../../../tests/watch-runner.test.ts) (Accessed: 4 September 2026).

Panda Agent (2026w) *Watch schema catalog and canonical configuration*. Available at: [schema catalog](../../../src/domain/watches/schema-catalog.ts), [canonical parsers](../../../src/domain/watches/config.ts) and [package entrypoint](../../../src/domain/watches/index.ts) (Accessed: 4 September 2026).

Panda Agent (2026x) *Web control entrypoints and query consumers*. Available at: unused page barrel (`apps/control-ui/src/pages.tsx` at the audit baseline; removed in D01), [live page routes](../../../apps/control-ui/src/app/control-page-routes.tsx), [query hooks](../../../apps/control-ui/src/features/control/api/queries.ts), [live table hook consumers](../../../apps/control-ui/src/components/common/data-table/ui/data-table-view.tsx) and [shared table entrypoint](../../../apps/control-ui/src/components/common/data-table/index.ts) (Accessed: 4 September 2026).

Panda Agent (2026y) *Worker drain and transport session lifecycle follow-ups*. Available at: [outbound claim behaviour](../../../src/domain/channels/deliveries/postgres.ts), [archive settlement](../../../src/domain/sessions/archive.ts), [MCP client lifecycle](../../../src/integrations/mcp/client.ts) and [MCP transport contract](../../developers/mcp.md) (Accessed: 4 September 2026).
