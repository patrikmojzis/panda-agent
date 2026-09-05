# Desloppify

This folder holds the active cleanup context, decisions and verification evidence.
The objective is to remove unnecessary complexity from Panda while preserving
its supported behavior. Code, tests, generated contracts and accepted ADRs remain
authoritative; this folder records decisions and work in progress.

- [First pass: architecture, full discussion and production alignment](./2026-09-04-codebase-deslopification.md)
- [Current pass: verified deletions and simpler implementation](./2026-09-05-simplification-pass.md)
- [Active inspect, simplify, review and commit loop](./CYCLES.md)
- [Browser cancellation and ownership repair](./2026-09-05-browser-cancellation.md)

## Current state

The initial architecture and simplification passes are committed as `ca5a689d`.
The continuing cleanup loop has completed cycles 1–69; their decisions, scoped
commits, behavior changes and verification evidence are in the cycle record.
Together, these cleanup commits remove **5,840 production lines**, including
75 lines relocated into tests. Counts exclude unrelated commits, tests,
documentation and configuration.

Control now separates single-agent authorization and bulk visible-key reads from
agent-list enrichment. Cycle 57 added 23 production lines to remove unnecessary
queries and MCP configuration parsing from seven key-only callers.
Admin credentials use one query instead of three; overview uses four instead of
five in the verification fixture. Enriched listings, access policy and admin-wide
overview/credential scope remain unchanged. The preceding lifecycle changes
simplify command-access refresh and durable subagent creation replay.

The latest runtime passes reuse the text collator, sort the already-owned
filtered array and remove redundant checks on validated durations. Ordering,
case/accent ties, nulls, page clamping and unfiltered summaries stay unchanged.
Verification includes 5,718 public-method comparisons across English, Slovak and
Turkish locales, 4,830 duration comparisons and ten new public caller cases.

Actor listings now share a Postgres batch reader while retaining their different
identity and connector scopes. Discord's identity reads fall from `1 + 2N` to
three; Telegram/WhatsApp falls from `3P` to two. This adds 45 production lines to
remove fanout. Whole batch failures return sanitized HTTP 500 responses; malformed
individual groups keep their existing omit/strict policies. Eight PostgreSQL
caller cases verify the actual SQL and fixed query count. Cycle 61 reuses that
reader for identity-directory counts with zero net production lines. Its fixture
reduces admin reads from 17 to seven and scoped reads from 15 to seven while
preserving original rows, visibility and pairing counts. All 12 PostgreSQL cases
and 50 baseline/current comparisons pass. Identity-page batch failures return
sanitized 500; global search preserves its existing best-effort category policy.

Cycle 62 removes 122 more production lines: a duplicated private bootstrap
contract, unused pool snapshot and HTML/path helpers, and a health-server
forwarding file. Public package contracts remain unchanged. Path security tests
now exercise the actual command-file resolver, including symlink containment and
immutable file snapshots. That cycle left bootstrap JavaScript identical to its
baseline.

Cycle 63 removes 39 unused lines from session-input delivery, Discord's obsolete
dropping fallback and Gateway's duplicate delivery-policy helper. Their live
atomic admission and durable-request paths remain unchanged; three tests that
only exercised those obsolete helpers are removed.

Cycle 64 removes 124 UI lines that reimplemented runtime filtering, sorting,
pagination and summaries for a retired response shape. The panel now consumes
the server's required summary, data and metadata. Its controls, loading states
and valid-response output remain unchanged; 705 backend-generated comparisons
verify the projection, and 30 React render comparisons verify component parity
with mocked boundaries. Control typecheck and production build pass. Backend
history hydration remains a separate issue.

Cycle 65 repairs shutdown losing a readonly pool when lazy initialization fails
after allocation. Cleanup now recovers the owned pool and any returned observer
after the initialization promise settles. It adds two production lines and two
regression tests; the original initialization error and cleanup ordering remain
intact. Cycle 66 closes the startup-log rollback gap: failed observation now
uses its normal stop operation before rethrowing the original value. It adds
eight production lines and five regression cases, retaining prior observers and
pool callback/promise behavior. Earlier observer setup failures remain a
separate boundary.

Cycle 67 removes 47 more UI lines from Automations, Watches and Gateway. These
panels now pass through the required paginated responses instead of copying them
and inventing fallback metadata. API aliases remain intact. Seventy-two React
render comparisons pass, including page metrics, previous data, errors and
Gateway source selection; Control typecheck and production build pass.

Cycle 68 closes the eager bootstrap ownership gap. Each pool and observer is
recorded immediately, and the existing cleanup boundary now covers their
initialization. Six logging-failure cases and one secondary cleanup-failure case
fail before the repair and pass afterward. Healthy initialization, lazy readonly
configuration, cleanup order and original errors remain intact. This adds 11
production lines and 50 test lines; no public contract or schema changes.

Cycle 69 deletes the unused `ConfirmSwitch` component and its exclusive import,
removing 83 UI lines. The live confirmation button, its promise handling, the
briefing caller and the shared switch primitive remain byte-for-byte unchanged.
Caller/export checks, Control typecheck and production build pass.

The frozen backend passes **3,267 unit tests across 341 files**, root build/typecheck,
import law, all 19 compiled package
imports and shared `Thread` identity. The initial failure of an unchanged
cancellation test and its passing isolated/file/full reruns are recorded under
cycle 54; its precise cause remains unproven. Cycle 57 passed prompt/shim
contracts, eleven real-PostgreSQL visibility tests and 102 baseline/current
comparisons. Cycles 58–59 leave those queries and authority checks unchanged.
The cycle 68 common-runtime smoke applied all 25 migrations to fresh local
PostgreSQL and completed an owned run with applied input, one tool call, four
messages and idle state. It used injected model responses and blocked external
requests. Focused bootstrap and observer tests prove the ownership repairs; the
smoke avoids application bootstrap and does not exercise those failure paths or
the actor listings. The test cluster was stopped afterward. Prompt/shim contracts
pass; cycle 68 changes only bootstrap source metadata in the snapshot. All 981
compiled declarations remain unchanged. Runtime-activity reads and the later
custom subagent-command registration boundary remain open. The latter now has
a public-caller reproduction showing three unclosed pools after its factory
throws. Their evidence and constraints are recorded in the cycle record. The
inspect/review/commit loop remains active.

Concurrent credential-name, image-generation and background-job work belongs to
separate tasks. Preserve those changes and untracked `output/`; they are excluded
from cleanup counts.

Production access remains strictly read-only. No deployment, migration, restart,
message replay or historical-data cleanup is part of this work. The production
snapshot and migration constraints are recorded in the first-pass plan, §8.

## Working rules

1. Verify source, callers, dynamic lookup and intentional package exports before
   deleting anything. Lack of an internal caller does not retire a public contract.
2. Prefer deleting unnecessary behavior and indirection. Do not replace a small
   helper with a framework or split files to improve line-count statistics.
3. Preserve claim ownership, atomic acceptance, uncertainty after external effects,
   session/reset semantics, scoped authority, and bounded upload admission.
4. Keep frozen migrations and legitimate protocol-specific behavior. Do not
   remove checks that enforce real input, credential or lifecycle constraints.
5. Record concrete evidence, decisions, changed files and applicable checks in
   the current pass. Net-line counts include new source files and exclude unrelated
   work and generated reporting artifacts.

## Completion audit

Completion must be supported by a current subsystem inventory, resolved findings,
verified deletions, behavior checks at callers' interfaces, applicable repository
gates, and a recorded disposition for each scoped candidate. Passing tests alone
does not establish that the objective has been completed. New concrete findings
keep the active pass open until fixed or explicitly resolved by evidence.
