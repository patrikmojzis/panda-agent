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
The continuing cleanup loop has completed cycles 1–60; their decisions, scoped
commits, behavior changes and verification evidence are in the cycle record.
Together, these cleanup commits remove **5,446 production lines**, including
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
caller cases verify the actual SQL and fixed query count.

The frozen tree passes **3,247 unit tests across 341 files**, root
build/typecheck, import law, all 19 compiled package
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
was stopped afterward. Identity-directory binding counts, runtime-activity reads
and pool observation ownership remain under investigation, with their constraints
recorded in the cycle record. The inspect/review/commit loop remains active.

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
