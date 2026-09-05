# Desloppify

This folder holds the active cleanup context, decisions and verification evidence.
The objective is to remove unnecessary complexity from Panda while preserving
its supported behavior. Code, tests, generated contracts and accepted ADRs remain
authoritative; this folder records decisions and work in progress.

- [First pass: architecture, full discussion and production alignment](./2026-09-04-codebase-deslopification.md)
- [Current pass: verified deletions and simpler implementation](./2026-09-05-simplification-pass.md)
- [Active inspect, simplify, review and commit loop](./CYCLES.md)

## Current state

The first pass implemented D01–D14 locally and passed its recorded verification.
The second pass removes verified dead code and redundant composition. The active
cycle record tracks their commit and subsequent work. Concurrent credential-name,
image-generation and background-job work belongs to separate tasks; preserve it.
Earlier test results are historical evidence and do not certify subsequent edits.

The second pass is implemented and verified locally: 1,974 fewer production-code
lines, 330 passing test files / 2,926 tests, a passing model smoke, and current
build/import/prompt/shim checks. Its complete decisions and evidence are in the
current-pass record. Production remains undeployed by this cleanup work.

The first two passes are committed as `ca5a689d`. Cycle 1 is committed as
`2e3aa496`, removing another 834 production lines of duplicated host CLI help.
Browser action completion is committed as `161ed329`; terminal snapshots are
committed as `779e7647`. These passes remove another 125 production lines. The
mixed operator CLI cleanup is committed as `8686d315`, removing another 1,061
lines. The attachment-save race fix removes 18 more production lines and is
reviewed and committed with its cycle. In total, these cleanup commits remove
4,159 production lines relative to the first cleanup commit's parent, excluding
tests, documentation and configuration. Cycles 6–9 simplify provider projections,
MCP cancellation, runtime composition and shell compensation. They are verified
in an isolated checkout and being committed separately; concurrent storage and
prompt changes belong to another task. The cycle log is the current progress
record; the inspect/review/commit loop remains active.

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
