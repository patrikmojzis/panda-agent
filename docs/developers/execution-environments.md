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

## Network policy

Execution environments store a `networkPolicy` field. The default is `public`,
which preserves the current disposable runner network behavior. `local_only` asks
the Docker manager to place the environment on a configured internal local-only
Docker network instead of the public disposable runner network; creation fails if
that network is missing or not marked internal.

`networkPolicy` is egress control. Tool groups are capability grants only. In
particular, the `internet` tool group grants browser/web tools; it does not
turn network egress on or off.

## Tool policy

Subagent tool access is profile driven:

- `core` grants basics plus parent A2A updates.
- `workspace_read` grants read-only workspace inspection.
- `internet` grants public web and browser inspection. It is not an egress-control mechanism; use execution-environment `networkPolicy` for that.
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
