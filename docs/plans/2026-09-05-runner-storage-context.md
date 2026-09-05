# Runner storage context and cron persistence

Status: implemented and independently reviewed.

## Problem

Agent-workspace subagents receive invented `/workspace`, `/inbox`, and
`/artifacts` paths when filesystem metadata is absent. Cron persists command
text but neither its referenced files nor its dependencies. The generated
Docker stack recreates runners during deployment, losing unmounted files.

## Implementation

1. Declare persistent runner roots explicitly in deployment configuration and
   resolved environments. Do not infer retention from cwd, `$HOME`, runner kind,
   or subagent spawn mode. Undeclared external targets remain unspecified.
2. Render one environment storage description for main, branch, and subagent
   sessions. Preserve configured workspace/inbox/artifact mappings and identify
   their execution target. Remove independent subagent path defaults.
3. Explain managed disposable retention: container stop retains mounted files;
   environment purge removes them. Metadata describes configured paths, not
   evidence that files currently exist. Parent-runner paths are not universal
   recipient paths. Preserve mounts, A2A transfers, and browser artifacts.
4. Clarify cron help and return an additive storage notice from create, update,
   and enable. Keep it advisory and visible through JSON command output.

## Verification and delivery

- Check normal, rebound, isolated, custom-path, and undeclared target contexts.
- Check text/JSON cron help and actual shim notice output.
- Preserve existing A2A, browser-artifact, and purge behavior tests; add a local
  Docker handoff/recreation test using isolated test resources when available.
- Run typecheck, focused tests, import-law ratchet, command-shim check, prompt
  contracts, and a disposable-database runtime smoke when feasible.
- Review the complete diff independently, fix findings, and commit explicit
  paths as `fix(runtime): describe runner storage and cron persistence`.

No production changes, cron repair, historical DB rewrites, mount changes, or
shell dependency inference are part of this implementation.

## Validation results

- The isolated proposed commit passed 434 tests across 15 focused suites,
  TypeScript, import-law ratchet, command-shim generation check, and prompt
  contracts. The isolated copy excluded concurrent unrelated worktree changes.
- A local Docker regression passed: recreating a managed disposable environment
  discarded an `/opt` marker while retaining an executable artifact and identical
  parent-visible bytes. This does not verify a production cron deployment.
- The actual purge-service test preserves an accepted copy in parent agent-home
  after removing its source environment. Generated-stack tests pair the declared
  agent-home root with the corresponding runner bind mounts.
- Runtime smoke on a new local disposable PostgreSQL instance completed
  migrations and daemon dispatch, then failed because the configured provider
  API key was invalid. Model/tool completion remains unverified by that smoke.
  Test resources were cleaned up; production was not accessed.
- Independent reviews found no actionable defects. The commit contains only
  this change's paths and hunks.
