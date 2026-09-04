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
- State: verified and reviewed; scoped commit prepared.

## Next cycle

Reconnaissance is examining terminal UI, CLI adapters and browser integration.
Accepted candidates need current caller/export evidence, a concrete simplification,
focused behavioral checks and an independent review before the next commit.
