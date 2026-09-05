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
The continuing cleanup loop has completed cycles 1–51; their decisions, scoped
commits, behavior changes and verification evidence are in the cycle record.
Together, these cleanup commits remove **5,335 production lines**, including
75 lines relocated into tests. Counts exclude unrelated commits, tests,
documentation and configuration.

The latest three cycles remove 42 production lines: Control services share
timestamp conversion, task display uses the existing SQL lifecycle classifier,
and watch pages select one latest run per watch in PostgreSQL. A real before/after
fixture returns two latest-run rows instead of 602 with identical public results.
Four new PostgreSQL tests cover lifecycle precedence, filters/sorts, ties,
pagination/counts and scoped access. The row reduction bounds transfer and
JavaScript allocation, not necessarily database scans.

The frozen combined tree passes **3,195 unit tests across 339 files** and **four
new PostgreSQL tests**, root build/typecheck, import law, prompt/shim contracts,
all 19 compiled package imports and shared `Thread` identity. The test cluster was
stopped afterward. The earlier seven profile-store tests and deterministic runtime
smoke are recorded under cycles 46–48; those historical checks do not certify
later edits. This batch tests the changed Control reads against actual PostgreSQL.
It makes no new external-provider or production-deployment claim. The
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
