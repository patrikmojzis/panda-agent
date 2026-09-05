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
The continuing cleanup loop has completed cycles 1–64; their decisions, scoped
commits, behavior changes and verification evidence are in the cycle record.
Together, these cleanup commits remove **5,731 production lines**, including
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
immutable file snapshots. Bootstrap JavaScript is identical to its baseline.

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

The last complete backend suite at cycle 63 passed **3,253 tests across 341 files**,
root build/typecheck, import law, all 19 compiled package
imports and shared `Thread` identity. The initial failure of an unchanged
cancellation test and its passing isolated/file/full reruns are recorded under
cycle 54; its precise cause remains unproven. Cycle 57 passed prompt/shim
contracts, eleven real-PostgreSQL visibility tests and 102 baseline/current
comparisons. Cycles 58–59 leave those queries and authority checks unchanged.
The cycle 60 common-runtime smoke applied all 25 migrations to fresh local
PostgreSQL and completed an owned run with applied input, one tool call, four
messages and idle state. It used injected model responses and blocked external
requests. Focused public tests and earlier method parity cover the lifecycle
changes; that smoke did not invoke those methods or the actor listings. The test cluster
was stopped afterward. Cycles 62–63 also pass prompt/shim contracts; cycle 62
changed only two source-file metadata records in the prompt snapshot, and cycle
63 leaves that snapshot unchanged. Runtime-activity
reads and broader pool observation ownership remain under investigation, with
their constraints recorded in the cycle record. The inspect/review/commit loop
remains active.

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
