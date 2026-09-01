# Channel Action Reconciliation and Typing Expiry

- **Date:** 1 September 2026
- **Status:** implemented; disposable-PostgreSQL execution remains a release gate
- **Owner:** Panda channel actions and connector runtime
- **Decision state:** deepen the existing channel-action module into an
  expiring durable outbox; retain shared notifications as the latency path and
  add bounded polling as the reconciliation path
- **Citation style:** Harvard author-date

## Abstract

Panda persists typing requests and other connector operations in
`runtime.channel_actions`. Connector workers normally wake through PostgreSQL
`LISTEN/NOTIFY`. The shared connector runtime starts each action worker without
its own notification subscription and routes process-level notifications to the
matching account worker. Unlike outbound-delivery workers, action workers do
not poll. A missed or incorrectly routed notification can therefore leave a
durable action pending indefinitely even while inbound messages and outbound
replies continue normally (Panda Agent, 2026d; Panda Agent, 2026g; Panda Agent,
2026h).

A recent multi-account deployment exposed this failure mode: typing actions
were created successfully but remained pending and unclaimed, while ordinary
outbound deliveries continued to settle. This plan deliberately excludes host,
account, actor, conversation and credential details. The evidence establishes
the failing module without publishing operational identifiers.

The selected implementation deepens the existing channel-action module rather
than creating a Telegram-specific recovery loop or reverting the shared
connector runtime. Non-expiring actions become recoverable through bounded
polling. Typing actions gain an explicit deadline and terminal `expired` state,
so a restart or delayed reconciliation cannot replay obsolete presence. Real
PostgreSQL tests will exercise enqueue, notification routing, polling recovery,
expiry and multi-account isolation through the public queue/worker interface.

## Implementation outcome

The implementation follows the selected expiring-outbox design:

- migration `0017_channel_action_expiry` adds `expires_at` and terminalises
  historical pending typing actions;
- the typing event seam assigns a fixed 10-second queue deadline;
- the action store persists `expired` as a terminal outcome, continues past
  expired or archived candidates and bounds terminal cleanup to 100 rows per
  claim pass;
- the action worker reconciles every 15 seconds through the existing
  `DrainLoop` and checks expiry again immediately before connector dispatch;
- connector logs identify poll recovery and pre-dispatch expiry without
  payload, conversation, actor, credential or database details; and
- `tests/live/channel-action-runtime.live.test.ts` covers migration, real
  notification routing, multiple accounts, listener reconnect, suppressed
  notification recovery and restart expiry against a disposable database.

No shared-router change was made without a deterministic real-PostgreSQL
failure. Existing source and mocked tests did not establish a parser,
registration or routing defect. The durable correctness bug was the absence of
reconciliation; the new live test is the release gate for any later fast-path
correction. Local execution of that test was intentionally skipped because its
safe harness resets a disposable database and no database mutation was
authorised for the implementation session.

One planned observability event was deliberately omitted:
`channel_action_notification_miss_suspected`. A poll recovery does not prove
that a notification was missed, and listener health is owned by the connector
runtime rather than the channel-action domain. Emitting that diagnosis from
the worker would be false precision. `channel_action_recovered_by_poll` plus
listener reconnect state provides accurate evidence without coupling the
domain worker to daemon health internals.

Local verification completed with the full unit suite (2,732 tests), focused
channel-action and migration tests, TypeScript typechecking, the architecture
import-law ratchet and whitespace validation. The disposable-PostgreSQL live
test and smoke test remain deployment gates because both reset a test database.

## 1. Problem statement

Panda currently couples action progress to an optimisation:

1. core persists a pending channel action;
2. the store emits a PostgreSQL notification after commit;
3. the shared connector listener parses the notification;
4. the runtime looks up the registered connector worker;
5. the worker drains the pending action; and
6. the connector adapter performs the protocol operation.

The durable row is the source of truth, but the worker has no reconciliation
path after its startup drain. If any step between notification emission and
worker wake is lost, the row remains pending with no retry, timeout or expiry.
The health endpoint can still report that the PostgreSQL listener is listening,
because listener connectivity does not prove that a specific action reached a
registered worker.

This is not only a typing problem. The same queue also carries reactions,
message edits, deletes, pins, unpins and sticker actions. Those operations are
durable user-visible work and must not depend exclusively on a lossy wake signal
(Panda Agent, 2026e).

Typing adds the opposite constraint. It is useful only near the input that
caused it. Replaying an old typing request after restart is incorrect even if
the queue can technically deliver it. The queue therefore needs to represent
both durable actions and durable-until-deadline actions explicitly.

## 2. Current architecture

### 2.1 Typing production

`ChannelTypingEventHandler` observes `inputs_applied`, resolves the latest
channel route and emits one `start` request. It deliberately does not run a
keepalive loop because run lifetime can extend beyond visible outbound delivery
(Panda Agent, 2026c).

The daemon's typing dispatcher persists the request as a `typing` channel
action. Telegram and WhatsApp connector workers later translate that domain
request into their protocol-specific presence operation. Telegram calls
`sendChatAction`; protocol-specific dispatch remains local to the connector, as
required by ADR 0001 (Panda Agent, 2026a; Panda Agent, 2026f; Panda Agent,
2026i).

### 2.2 Shared connector notification runtime

One connector daemon owns one bounded Postgres pool and one listener regardless
of account count. Each account registers its action and outbound workers under
its connector key. Both workers start with direct subscriptions disabled, and
the shared listener triggers the matching drain (Panda Agent, 2026g).

This shape is architecturally correct. It keeps connection budgets bounded and
centralises lifecycle glue without moving Telegram or WhatsApp policy into a
generic channel framework. The implementation must retain it (Panda Agent,
2026a; Panda Agent, 2026b).

### 2.3 Asymmetric recovery

`ChannelOutboundDeliveryWorker` polls every 15 seconds in addition to receiving
notification wakes. `ChannelActionWorker` performs an initial drain and then
waits only for notifications (Panda Agent, 2026d; Panda Agent, 2026h).

The asymmetry explains why replies can continue while typing, reactions or
other actions accumulate. It also means unit tests that manually emit a fake
notification can pass while the real Postgres-to-registration path fails
(Panda Agent, 2026j; Panda Agent, 2026k).

## 3. Aim and objectives

The aim is to make channel-action settlement correct under notification loss
without replaying obsolete typing presence.

The implementation will:

1. keep `runtime.channel_actions` as the durable source of truth;
2. retain `LISTEN/NOTIFY` as the low-latency wake path;
3. add bounded polling as a reconciliation path for pending actions;
4. add explicit optional expiry to the channel-action model;
5. mark obsolete typing actions `expired` without calling a connector;
6. ensure terminalising one inadmissible candidate does not block later work;
7. preserve per-channel and per-connector FIFO for dispatchable actions;
8. preserve shared connector pools and listener ownership;
9. prove the full path with real PostgreSQL and multiple connector accounts;
10. add bounded operational evidence for notification misses and expiry; and
11. deploy without replaying typing rows created by older builds.

## 4. Non-goals

This change will not:

- restore run-lifetime typing keepalives;
- create a new generic queue framework;
- move Telegram or WhatsApp protocol behaviour into the shared runtime;
- replace PostgreSQL notifications with hot polling;
- retry connector operations that have already reached a terminal `failed`
  state;
- infer expiry from payload JSON at read time;
- make typing part of transcript history;
- change outbound-delivery semantics; or
- publish operational host, account, actor, conversation or credential data.

Delivery-bound typing refresh may be designed separately if product evidence
later justifies it. The present change restores a reliable initial indicator
and correct queue recovery without reopening the keepalive policy.

## 5. Architectural decision

### 5.1 Deepen the existing channel-action module

The action store and worker already own persistence, claiming, dispatch and
settlement. Add reconciliation and expiry there. Do not add a parallel
`TypingQueue`, Telegram timer or daemon-level action sweeper.

The external worker interface remains small:

```ts
start(options?)
triggerDrain()
stop()
```

Polling, single-flight drain behaviour, expiry handling and notification
coalescing remain implementation details behind that interface. This improves
locality: callers do not need to know whether a drain was caused by startup,
notification, reconnect or periodic reconciliation.

### 5.2 Model an expiring durable outbox

Add nullable `expires_at TIMESTAMPTZ` to `runtime.channel_actions` and expose it
as optional `expiresAt` on action inputs and records. A `NULL` deadline means
the action does not expire automatically.

Add `expired` to `ChannelActionStatus`. Expiry is an expected terminal outcome,
not a connector failure. An expired row must have `completed_at`, retain
`attempt_count = 0` when it was never dispatched, and carry a stable safe reason
such as `Action expired before dispatch.`

Do not encode the deadline only inside `payload`. The store must be able to
select and settle expired work without parsing action-specific JSON, and
operators must be able to inspect the queue state directly.

### 5.3 Keep expiry policy with typing

The typing domain owns the typing lifetime. Define one code constant beside the
typing contract and include the absolute deadline in each emitted typing
request. The persistence adapter copies that deadline to the action row; it
does not invent policy in `daemon-bootstrap.ts`.

The initial default should be short and fixed in code. The implementation
should begin with a 10-second deadline and document that it limits queue
validity, not Telegram's display duration. Do not add an environment variable
until operators have a demonstrated need to tune it.

All non-typing action kinds remain non-expiring unless a later product decision
assigns an explicit deadline at their domain seam.

### 5.4 Notifications accelerate; polling reconciles

Configure `ChannelActionWorker` with a bounded poll interval through its
existing `DrainLoop`. The default should match the current outbound worker's
15-second reconciliation interval unless load testing demonstrates that a
different value is required.

This interval intentionally exceeds the initial typing deadline. Polling
recovers durable reactions, edits, deletes, pins and sticker actions, but it
does not replay typing late. Typing remains on the immediate notification and
listener-reconnect path. Fixing the observed shared action-notification routing
is therefore still required; polling is containment, not an excuse to leave the
fast path broken.

### 5.5 Preserve connector locality

The shared runtime continues to own pool, listener, registration and cleanup
ordering. Connector modules continue to own adapters and protocol calls. The
channel-action module owns queue semantics. This division follows ADR 0001:
shared lifecycle glue is centralised, while typing and action dispatch remain
connector-local (Panda Agent, 2026a).

## 6. Persistence changes

### 6.1 Schema

Add the next available append-only migration at implementation time. Do not
edit the frozen pre-ledger baseline. The migration must:

1. add nullable `expires_at TIMESTAMPTZ` to
   `runtime.channel_actions`;
2. terminalise every pre-existing pending `typing` row as `expired` with a safe
   reason and completion timestamp;
3. leave pending non-typing rows unchanged so the new polling path can recover
   them;
4. preserve all terminal historical rows;
5. update the schema installer, migration catalog, immutable schema-version
   summary and schema-object manifest; and
6. avoid adding an expiry index until a real query plan or backlog volume
   demonstrates that the existing pending index is insufficient.

The migration must not derive a future deadline for historical typing rows.
Those rows have already lost their UX value and must never be replayed.

### 6.2 Domain types and row parsing

Update:

- `ChannelActionInput` with optional `expiresAt`;
- `ChannelActionRecord` with optional `expiresAt`;
- `ChannelActionStatus` with `expired`;
- row parsing for `expires_at`; and
- typing request parsing so its deadline survives persistence.

Reject invalid deadlines at enqueue. A supplied deadline must be a finite
timestamp. The store may accept an already expired action and persist it
directly as `expired`, or reject it before insertion; choose one behaviour and
pin it through the public store interface. The preferred behaviour is direct
terminal persistence because it retains causal evidence without creating
pending work.

### 6.3 Claim and expiry transaction

`claimNextPendingAction` must never return an expired record for dispatch. In
one bounded transaction it should:

1. find the oldest pending candidate for the channel and connector;
2. settle the candidate as `expired` when its deadline has passed;
3. settle or skip candidates invalidated by session lifecycle policy;
4. continue to the next candidate rather than returning `null` after such a
   terminal transition;
5. lock and claim the first dispatchable candidate; and
6. increment `attempt_count` only when the action enters `sending`.

Bound the number of terminal candidates handled in one claim pass so a legacy
backlog cannot monopolise the shared two-connection connector pool. A batch of
100 is a reasonable initial ceiling. The worker's next drain or poll continues
remaining cleanup.

Keep PostgreSQL `SKIP LOCKED` behaviour and the existing compatibility fallback
for local test stand-ins. Real PostgreSQL remains authoritative for lock and
transaction behaviour.

## 7. Runtime implementation

### 7.1 Reproduce before changing the listener

Add a real-PostgreSQL test that starts the shared connector daemon runtime,
registers at least two connector workers, enqueues a channel action through a
separate core-side store and observes terminal settlement through the worker
interface. The test must use actual `LISTEN`, `pg_notify` and commit behaviour.

This test is the gate for the notification fix. It should reproduce the
deployed failure or prove which assumption differs from production. Do not
patch the router based only on a mocked `EventEmitter` test.

Inspect and correct the smallest failing seam among:

- action notification parsing;
- source and connector-key matching;
- account registration lifetime;
- listener callback dispatch; and
- listener reconnect state.

The resulting test should remain indifferent to the internal registration map
or callback count. Its observable assertion is that the intended connector
dispatches the action and another connector does not.

### 7.2 Add polling reconciliation

Pass `pollIntervalMs` to the action worker's `DrainLoop`, using the same
single-flight and stop-wait semantics already used by outbound delivery. Do not
create a second timer implementation.

The worker should distinguish drain causes internally for logging:

- `startup`;
- `notification`;
- `listener_reconnect`; and
- `poll`.

Do not expose these causes in the public worker interface unless the
implementation cannot produce useful evidence otherwise.

### 7.3 Guard again before protocol dispatch

Expiry is checked during claim, but time can pass between claim and connector
dispatch. Immediately before the connector adapter call, reject a claimed
expiring action whose deadline has now passed and settle it as `expired` rather
than `failed`.

This last-responsible-moment guard prevents a congested process from sending
obsolete presence after a valid database claim.

## 8. Observability and health

Add structured, identifier-safe events:

- `channel_action_expired` with channel, action kind, age and drain cause;
- `channel_action_recovered_by_poll` with channel, action kind and age; and
- `channel_action_notification_miss_suspected` when polling finds a recently
  created non-expired action while the listener reports `listening`.

Do not log payloads, conversation IDs, actor IDs, connector credentials or raw
database URLs. Connector keys are already operational routing identifiers, but
the new events do not require them in default logs.

Listener connectivity alone should remain part of health, but the health
contract should not run an unbounded database query. Prefer worker-local
counters and timestamps. If backlog-age health is later required, add one
bounded indexed aggregate at daemon scope rather than one query per account and
healthcheck.

## 9. Test plan

Tests must protect observable queue behaviour through public seams rather than
private callback wiring (Panda Agent, 2026a; Panda Agent, 2026b).

### 9.1 Store behaviour

Add focused tests proving that:

1. a non-expiring pending action can be claimed and settled;
2. an unexpired typing action can be claimed;
3. an expired typing action becomes `expired` without dispatch attempt;
4. `attempt_count` remains zero for never-dispatched expiry;
5. an expired oldest row does not block the next valid action;
6. archived-session handling does not block later valid work;
7. enqueue preserves a valid deadline; and
8. an already expired input follows the selected terminal-persistence policy.

Use the store interface for assertions. Direct SQL is appropriate only in the
migration test, where the database transformation itself is the interface.

### 9.2 Worker behaviour

Prove that:

1. startup drains existing valid work;
2. notification dispatch remains immediate;
3. a suppressed notification is recovered by polling for a non-expiring
   action;
4. polling never dispatches an expired typing action;
5. overlapping notification and poll wakes dispatch once; and
6. `stop()` waits for an in-flight drain and cancels future polling.

Avoid tests that only assert internal timer setup or private callback counts.
Use fake timers only to advance the public polling behaviour deterministically.

### 9.3 Real PostgreSQL integration

Create a focused live test using a disposable `TEST_DATABASE_URL` that proves:

1. a committed `pg_notify` wakes the correct account action worker;
2. two connector accounts remain isolated;
3. listener reconnect drains work committed during the gap;
4. polling recovers a durable action when notification dispatch is suppressed;
5. expired typing is not sent after restart; and
6. concurrent workers do not claim the same action.

This test replaces confidence currently inferred from mocked notification
objects. Existing small unit tests may remain where they protect parsing or
adapter behaviour, but redundant wiring assertions should be deleted.

### 9.4 Connector contracts

Retain Telegram tests proving `message_thread_id` preservation and connector-key
validation. Retain WhatsApp presence tests. Add one contract case per connector
showing that an expired request never reaches the protocol adapter.

## 10. Implementation sequence

### Phase 0: Reproduction

1. Add the real-PostgreSQL shared-listener test.
2. Reproduce the multi-account action-notification failure.
3. Record the smallest confirmed failing seam in the implementation PR.

Exit criterion: the failure is deterministic without production identifiers.

### Phase 1: Persistence contract

1. Add `expires_at` and the `expired` status.
2. Add the append-only migration and stale-typing hard cut.
3. Update types, row parsing, schema installers, catalogs and manifest.
4. Add store and migration tests.

Exit criterion: expired actions cannot be claimed and historical typing cannot
be replayed.

### Phase 2: Worker reconciliation

1. Add bounded polling through `DrainLoop`.
2. Continue past terminalised candidates.
3. Add the final pre-dispatch expiry guard.
4. Add structured recovery and expiry evidence.

Exit criterion: durable actions settle after a missed notification, and typing
never dispatches after its deadline.

### Phase 3: Notification correction

1. Fix the confirmed shared listener or registration defect.
2. Keep the reproduction test at the public runtime interface.
3. Delete mocked assertions made redundant by the integration test.

Exit criterion: immediate action delivery works for multiple accounts through
real PostgreSQL.

### Phase 4: Verification and documentation

1. Run focused store, worker, connector and live PostgreSQL tests.
2. Run `pnpm typecheck`.
3. Run `pnpm architecture:import-law:ratchet` if imports or module ownership
   move.
4. Run `pnpm smoke` against a disposable `TEST_DATABASE_URL` when feasible.
5. Run `git diff --check`.
6. Update developer queue/lifecycle documentation and operational diagnostics.

Exit criterion: all required checks pass and every new named path, command and
reference resolves in the current tree.

## 11. Deployment and rollback

### 11.1 Pre-deployment

- Confirm the deployment revision contains both migration and runtime code.
- Count pending actions by kind and age without exposing payloads.
- Confirm database writers will be stopped by the normal migration flow.
- Confirm the connector pool budget still reserves one LISTEN connection and
  one query connection.

### 11.2 Deployment

1. Apply the migration through the normal writer-stopped migration path.
2. Rebuild and restart core and connector processes from the same revision.
3. Verify schema version before admitting writers.
4. Verify connector health and listener state.
5. Send a controlled test input through each supported typing connector.
6. Confirm the typing action settles promptly and the matching outbound reply
   remains unaffected.

Do not manually replay or update pending typing rows. The migration owns their
safe terminal transition.

### 11.3 Post-deployment checks

Observe only bounded aggregates:

- pending actions by kind and age;
- expired typing count;
- actions recovered by polling;
- action attempts and terminal outcomes;
- listener reconnects; and
- outbound-delivery latency.

The deployment is successful when newly created typing actions settle through
the immediate path, durable actions recover after a simulated notification
gap, and no old typing action is dispatched.

### 11.4 Rollback

Application rollback is safe only to a revision that tolerates the additive
`expires_at` column and unknown terminal `expired` rows. If an older parser
rejects `expired`, roll forward with a code correction instead of starting the
old connector workers.

Do not reverse the migration or convert `expired` rows back to `pending`.
Expiry is a terminal safety decision, and replaying those rows would recreate
the user-visible defect this change prevents.

## 12. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Polling increases Postgres traffic | Use a 15-second default, existing pending index, shared bounded pool and single-flight drains; measure before adding indexes or configuration. |
| Old typing actions replay during rollout | Terminalise pending historical typing in the migration before workers restart. |
| Expired head row blocks later action | Claim logic continues past bounded terminal candidates in the same drain. |
| Notification defect remains hidden by polling | Real-PostgreSQL immediate-delivery test remains a release gate; log poll recovery while listener reports healthy. |
| Concurrent wake and poll double-dispatch | Preserve row locking, `SKIP LOCKED` and single-flight `DrainLoop` semantics. |
| Migration and runtime revisions diverge | Deploy schema and code from one revision through the existing writer-stopped flow. |
| Generic abstraction absorbs protocol policy | Keep TTL ownership in typing and provider calls in Telegram/WhatsApp adapters. |
| Healthcheck adds database load | Use local counters first; add only bounded daemon-scope backlog queries if evidence requires them. |

## 13. Acceptance criteria

The implementation is complete when all of the following are true:

- a committed typing request reaches the intended connector promptly through
  real PostgreSQL notification routing;
- another connector account never dispatches that request;
- a missed notification cannot strand a non-expiring action indefinitely;
- expired typing is never sent, including after worker restart;
- expiry is visible as a terminal state distinct from connector failure;
- an expired or archived candidate cannot block later valid work;
- outbound reply delivery remains unchanged;
- connector pool limits and shared listener ownership remain unchanged;
- logs and tests contain no account, actor, conversation, credential or raw
  connection information;
- focused tests, typecheck and applicable architecture/smoke checks pass; and
- the public documentation accurately describes notification, polling and
  expiry semantics.

## References

Panda Agent (2026a) *ADR 0001: Runtime architecture guardrails*. Available at:
`docs/developers/adr/0001-runtime-architecture-guardrails.md` (Accessed: 1
September 2026).

Panda Agent (2026b) *Architecture*. Available at:
`docs/developers/architecture.md` (Accessed: 1 September 2026).

Panda Agent (2026c) *Channel typing runtime event handler*. Available at:
`src/domain/threads/runtime/channel-typing.ts` (Accessed: 1 September 2026).

Panda Agent (2026d) *Channel action worker*. Available at:
`src/domain/channels/actions/worker.ts` (Accessed: 1 September 2026).

Panda Agent (2026e) *Channel action types, Postgres store and schema*. Available
at: `src/domain/channels/actions/` (Accessed: 1 September 2026).

Panda Agent (2026f) *Daemon runtime bootstrap*. Available at:
`src/app/runtime/daemon-bootstrap.ts` (Accessed: 1 September 2026).

Panda Agent (2026g) *Shared connector worker runtime*. Available at:
`src/integrations/channels/worker-runtime.ts` (Accessed: 1 September 2026).

Panda Agent (2026h) *Channel outbound-delivery worker*. Available at:
`src/domain/channels/deliveries/worker.ts` (Accessed: 1 September 2026).

Panda Agent (2026i) *Telegram typing adapter*. Available at:
`src/integrations/channels/telegram/typing.ts` (Accessed: 1 September 2026).

Panda Agent (2026j) *Connector daemon runtime tests*. Available at:
`tests/connector-daemon-runtime.test.ts` (Accessed: 1 September 2026).

Panda Agent (2026k) *Channel action tests*. Available at:
`tests/channel-actions.test.ts` (Accessed: 1 September 2026).
