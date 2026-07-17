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

## Session target operator surfaces

Named execution targets are stored as session-environment bindings. Operators can
register/bind/list/status/detach persistent runner targets with:

```bash
panda runner attach <sessionRef> <alias> --agent <agentKey> --runner-url <runnerUrl> --allow-tools <csv> [--shared-secret <secret>]
panda session targets bind <sessionRef> <alias> --agent <agentKey> --runner-url <runnerUrl> [--runner-cwd <path>] --allow-tools <csv>
panda session targets list <sessionRef> --agent <agentKey>
panda session targets status <sessionRef> [alias] --agent <agentKey>
panda session targets detach <sessionRef> <alias> --agent <agentKey>
```

Control exposes the same session target list and a small bind/detach flow from
the session overview. Control target health is named `reachable` because it only
checks unauthenticated runner `/health`; authenticated command readiness is still
validated when the tool call reaches `/exec` or `/jobs/*`.

## Tool policy

Subagent tool access is profile driven:

- `core` grants basics, shell/background execution, and parent A2A updates.
- `internet` grants public web and browser inspection.
- `memory` grants durable memory reads.
- `operate` grants operational mutation surfaces.

Workspace inspection uses standard shell commands through the granted runtime
tools in `core`.

Nested `panda subagent spawn` is denied for subagent sessions. Environment tools are
normal operational tools, not a delegation API.

## Paths

The execution-environment metadata still stores core, parent-runner, and
runtime-local paths for compatibility with the shell manager. Model-facing
prompts and docs call these subagent paths.
