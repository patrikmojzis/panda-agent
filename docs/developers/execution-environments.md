# Execution environments

Panda V2 delegates through durable subagent sessions. Disposable execution
environments are owned by the parent session and may be attached to isolated
subagents. The old model-facing worker spawn surface is removed.

## Cleanup

Use the subagent purge command:

```bash
panda subagents purge --stopped --older-than 7d --dry-run
panda subagents purge --stopped --older-than 7d --execute
```

The purge planner includes standalone environments with no attached subagents
and shared environments with multiple attached subagents. Execution optionally
stops active/expired containers through the environment manager, validates safe
environment roots, deletes non-cascading A2A/outbound/runtime-request rows,
then hard-deletes attached subagent sessions and the environment row.

## Tool policy

Subagent tool access is profile driven:

- `core` grants basics plus parent A2A updates.
- `workspace_read` grants read-only workspace inspection.
- `internet` grants public web and browser inspection.
- `memory` grants durable memory reads.
- `execute` grants bash/background execution.
- `operate` grants operational mutation surfaces.

`workspace_read` and `execute` are mutually exclusive. Use `workspace_read` for
read-only wrapper tools, or `execute` for shell/background execution. `execute`
can read workspace files through shell commands, so do not combine them.

Nested `spawn_subagent` is denied for subagent sessions. Environment tools are
normal operational tools, not a delegation API.

## Paths

The execution-environment metadata still stores core, parent-runner, and
runtime-local paths for compatibility with the shell manager. Model-facing
prompts and docs call these subagent paths.
