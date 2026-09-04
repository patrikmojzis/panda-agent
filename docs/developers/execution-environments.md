# Execution environments

Panda V2 delegates through durable subagent sessions. Disposable execution
environments are owned by the parent session and may be attached to isolated
subagents. The old model-facing worker spawn surface is removed.

## Lifecycle ownership

Each disposable create, restart or stop reserves a unique `operation_id` before
calling the manager. Completion changes only the fields owned by that operation;
metadata is merged with the current row. Explicit stop, expiry sweep, resolver
restart and purge share this fence. An expiry sweep rechecks expiry while
claiming, so it cannot stop a runner whose TTL was extended after selection.

`provisioning` and `stopping` reject further transitions, including after expiry.
There is no timed takeover: a database lease cannot cancel an earlier Docker
request. A manager timeout or disconnected response leaves the operation in
progress with an explicitly unresolved outcome. Operators must establish that
the old manager request has finished, inspect the actual runner, and reconcile
its result before another operation can run. This release does not automate
that reconciliation or provide a force-takeover command. A manager protocol
that fences operation generations is required before safe automatic takeover.

Database receipt retries never repeat manager calls. A lost acknowledgement
is accepted only when the stored operation and terminal state match. Exhausted
receipt failures leave an unresolved receipt and never trigger runner cleanup.
Setup failure is different: after a confirmed create, cleanup runs under the
same claim, and `failed` is recorded only after stop succeeds. Setup-created
runners and isolated subagent environments retain their restart restrictions.

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
Purge rechecks the terminal operation receipt under a row lock and retains that
lock through filesystem removal, preventing restart or reuse of the ID during
cleanup. Docker calls run before this transaction. A filesystem failure rolls
back database deletion so the stopped environment remains available for repair
or a later purge; filesystem removal itself cannot be rolled back.

## Session target operator surfaces

Named execution targets are stored as session-environment bindings. Operators can
register/bind/list/status/detach persistent runner targets with:

```bash
panda runner attach <sessionRef> <alias> --agent <agentKey> --runner-url <runnerUrl> --allow-tools <csv>
panda session targets bind <sessionRef> <alias> --agent <agentKey> --environment-id <existingEnvironmentId> --allow-tools <csv>
panda session targets list <sessionRef> --agent <agentKey>
panda session targets status <sessionRef> [alias] --agent <agentKey>
panda session targets detach <sessionRef> <alias> --agent <agentKey>
```

Control exposes the same session target list and a small bind/detach flow from
the session overview. Control target health is named `reachable` because it only
checks unauthenticated runner `/health`; authenticated command readiness is still
validated when the tool call reaches `/exec` or `/jobs/*`.

Core authenticates runner calls with an HMAC-derived token scoped to the owning
agent and execution-environment ID. `runner attach` therefore requires the Core
runner-token master in the operator environment and writes the derived token to
an owner-private local file for secure transfer; it never prints the bearer.
Persistent fallback runners use an agent-scoped
token. Disposable control runners use an environment-scoped token delivered by
the manager through an owner-only file; their untrusted workspace partner does
not receive it.

Persistent runners have separate per-agent networks. Each disposable workspace
gets a unique network for outbound access, while its control runner is attached
only to the private Core/manager control network. `/workspace/shared` remains an
explicit persistent-runner collaboration mount and does not bridge those
networks. The browser runner is attached dynamically to the exact workspace
network for local-app preview and never joins the runner-control network.

The workspace bridge currently preserves unrestricted public setup/Git egress;
it is not yet a host/LAN destination filter. Do not publish sensitive host
services to Docker-reachable addresses, and retain the dedicated non-admin host
user as the outer privacy boundary until an egress broker is implemented.

## Tool policy

Main and branch sessions without an explicit environment binding use the selected
command catalog's `policy.defaultAllowed` capabilities. Extensions opt in with
`defaultAllowed: true`; omitted or false eligibility does not grant fallback
access. Panda owns the small native-tool policy separately. Runtime assembly
passes this projected policy into environment resolution and heartbeat discovery.
Catalog construction rejects shared-capability combinations that would grant a
command excluded from defaults; eligibility cannot be bypassed by another command
opting in to the same effective permission.
Explicit binding policies and immutable subagent snapshots retain their own
grants, including capabilities excluded from fallback defaults. Identity,
credential mutation and readonly-Postgres gates still apply at command authority.

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
