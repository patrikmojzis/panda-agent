# CI

Panda PR CI is meant to make review confidence visible without requiring
reviewers to reconstruct local validation from comments.

The workflow lives in `.github/workflows/ci.yml`.

## Required PR Checks

- `Unit tests` runs `pnpm ci:test`.
- `Build` runs `pnpm ci:build`.
- `Architecture` runs `pnpm ci:architecture`.
- `Prompt contracts` runs `pnpm ci:prompt-contracts`.
- `Postgres startup rehearsal` runs `pnpm ci:postgres-startup` against a
  disposable Postgres service.

Keep these checks separate. A single chained `ci:pr` command hides which
surface failed.

## Prompt Contract Snapshot

`pnpm ci:prompt-contracts` checks
`scripts/ci/prompt-contracts.snapshot.json`.

The snapshot covers model-facing contract surfaces:

- `src/prompts/**`
- `src/prompts/contexts/**`
- `src/panda/contexts/**`
- prompt/runtime wiring files under `src/app/runtime`
- default toolsets
- tool names, descriptions, and JSON schemas
- worker tool policy and allowlists

When a prompt, tool schema, tool description, toolset, allowlist, or
model-facing context builder changes intentionally, update the snapshot:

```bash
pnpm ci:prompt-contracts:update
pnpm ci:prompt-contracts
```

Commit the snapshot only when the diff is intentional. If CI catches an
unexpected prompt/tool/context diff, fix the code instead of blessing the
snapshot.

If a new model-facing file is added and it is not covered by the existing
roots in `scripts/ci/prompt-contracts.ts`, add it there. If a new tool is wired
outside the normal default/runtime toolsets, make sure the snapshot script sees
it explicitly.

## Postgres Startup Rehearsal

`pnpm ci:postgres-startup` uses `TEST_DATABASE_URL`, recreates that disposable
database, and runs the real startup schema path.

It currently rehearses:

- fresh database startup
- legacy fixture startup from `scripts/ci/postgres-fixtures/*.sql`
- readonly `session.*` view creation
- core `runtime.*` and `session.*` relation existence

GitHub Actions provides `TEST_DATABASE_URL` through a Postgres service. For a
local run, use a disposable database name containing `test`, `smoke`, or `tmp`:

```bash
TEST_DATABASE_URL=postgresql://localhost:5432/panda_test_ci_local \
pnpm ci:postgres-startup
```

The rehearsal intentionally refuses non-disposable names. Do not point it at a
real Panda database.

When adding a new startup schema resource, add it to
`scripts/ci/postgres-startup-rehearsal.ts`. When adding a migration or repair
path for old data, add a tiny synthetic SQL fixture under
`scripts/ci/postgres-fixtures/`. Do not use prod dumps.

## Local Pre-PR Run

Run the same checks locally when touching CI-sensitive areas:

```bash
pnpm ci:test
pnpm ci:build
pnpm ci:architecture
pnpm ci:prompt-contracts
TEST_DATABASE_URL=postgresql://localhost:5432/panda_test_ci_local pnpm ci:postgres-startup
```

Docs-only changes do not need the Postgres rehearsal. Runtime, schema, prompt,
tool, or provider changes usually do.
