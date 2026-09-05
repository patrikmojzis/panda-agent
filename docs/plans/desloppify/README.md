# Desloppify

This folder holds the active cleanup context, decisions and verification evidence.
The objective is to remove unnecessary complexity from Panda while preserving
its supported behavior. Code, tests, generated contracts and accepted ADRs remain
authoritative; this folder records decisions and work in progress.

- [First pass: architecture, full discussion and production alignment](./2026-09-04-codebase-deslopification.md)
- [Current pass: verified deletions and simpler implementation](./2026-09-05-simplification-pass.md)
- [Active inspect, simplify, review and commit loop](./CYCLES.md)
- [Pending browser cancellation and ownership repair](./2026-09-05-browser-cancellation.md)

## Current state

The initial architecture and simplification passes are committed as `ca5a689d`.
The continuing cleanup loop has completed cycles 1–37; their decisions, scoped
commits, behavior changes and verification evidence are in the cycle record.
Together, these cleanup commits remove **5,165 production lines**, including
75 lines relocated into tests. Counts exclude unrelated commits, tests,
documentation and configuration.

The latest two cycles remove 40 production lines: the normal and streaming kernel
paths now share assistant-turn finalization, and unused migration reexports are
gone. Checkpoint/cancellation behavior, transcripts, public APIs and migration
checksums remain intact. The earlier MCP cancellation fix is also committed;
queued OAuth cancellation still waits for the preceding operation.

The frozen combined source passes **3,140 tests across 335 files**, the TypeScript
build, import law, prompt/shim contracts, all 19 compiled package imports and a
deterministic runtime smoke against disposable local Postgres with external
networking disabled. Automatic approval review declined the external-model smoke;
the local replacement validates migration, claiming, tool execution, transcript
persistence and idle state, but does not exercise an external provider or Bash.
The test database was stopped afterward. Earlier verification records are
historical and do not certify later edits. The inspect/review/commit loop remains
active; browser cancellation is the next planned repair.

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
