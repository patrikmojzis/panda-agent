# Execution Environments

Execution environments are the session-scoped boundary for bash execution.

For operator setup, use
[Disposable Execution Environments](../users/disposable-execution-environments.md).

The bash server is still dumb: it exposes the bash HTTP protocol and runs commands.
The environment decides which runner endpoint, cwd/root, credential policy, and
tool policy apply to a session.

## Current Shape

- `main` and `branch` sessions without a binding keep the old behavior.
- fallback remote bash still uses `BASH_SERVER_URL_TEMPLATE` and `BASH_SERVER_CWD_TEMPLATE`
  with `{agentKey}`.
- fallback persistent agent runners keep access to all stored credentials for the
  current agent.
- `subagent` sessions are durable delegated sessions created by model-facing
  `spawn_subagent`.
- subagent/disposable environments default to explicit credential allowlists and
  profile/toolGroups policy.
- subagent sessions use a snapshotted profile prompt and receive `Subagent
  Runtime Context` with parent A2A target and filesystem paths.
- subagent tools are filtered by snapshotted `toolPolicy.allowedTools`; nested
  `spawn_subagent` is denied in PR3 even when `operate` was requested.
- `environment_create` creates a parent-owned disposable environment without a
  subagent session.
- `spawn_subagent` attaches only to an existing ready parent-owned disposable
  environment for `isolated_environment`; it never creates/restarts/stops envs.
- `environment_stop` stops the disposable container and leaves files in place.
- parent LLM context renders environments grouped with their attached sessions.

## Tables

- `runtime.execution_environments`: environment identity, kind, state, runner
  URL, runner cwd/root, owner agent/session, TTL, and metadata.
- `runtime.session_environment_bindings`: binds a session to one or more
  environments, including default alias, override permission, credential policy,
  and tool policy.

## Bash Rules

- Bash resolves the session default environment before execution.
- Public per-call environment override is intentionally not exposed yet.
- Shell cwd/env state is tracked per environment id in `context.shellSessions`.
- Legacy `context.shell` is read and migrated when old context is loaded; new
  shell state should be written only to `context.shellSessions`.
- Remote bash servers receive credentials only in the per-command/job env snapshot.
  Runners do not load credentials themselves.
- Remote bash-server commands start from a safe non-secret base env (`PATH`, `SHELL`,
  `HOME`, `TMPDIR`, `LANG`, optional `TZ`) and then merge policy-filtered
  credentials, session env, and per-call env. If user/project `PATH` entries are
  present, they stay first and missing system dirs are appended so wrappers like
  Vite/esbuild can still find core tools.

## Model-facing Environment and Subagent Controls

`environment_create` creates a standalone parent-owned disposable environment.
The parent can put files in `/environments/<envDir>/inbox` before assigning a
subagent.

`spawn_subagent` is the model-facing delegation tool. It calls
`SubagentSessionService.createSubagentSession`, which:

- creates a durable `subagent` session using the same `agentKey` as the parent
- snapshots profile/toolGroups, credential, skill, and tool policy in metadata
- optionally attaches an existing ready disposable environment only when it is
  owned by the parent session and same agent
- binds parent↔subagent A2A before waking the handoff input
- never creates, restarts, stops, or purges disposable environments

`createThreadDefinition` prepends `SubagentRuntimeContext` for subagent sessions.
That context is sourced from `agent_sessions.metadata.subagent` and environment
filesystem metadata, not from the parent transcript. It is the reliable place for
`parentSessionId`, `message_agent({ sessionId: "..." })`, `/workspace`,
`/inbox`, `/artifacts`, and `/environments/<envDir>` hints.

`environment_stop` validates that the target disposable environment belongs to
the current `agentKey` and current `sessionId` before calling
`ExecutionEnvironmentLifecycleService.stopEnvironment`. It does not delete
environment filesystem roots or subagent sessions.

Old disposable environments are removed by the operator CLI, not by
`environment_stop`:

```bash
panda workers purge --stopped --older-than 7d --dry-run
panda workers purge --stopped --older-than 7d --execute
```

The purge path discovers parent-owned `disposable_container` environments,
including standalone environments with no workers and shared environments with
multiple attached workers. It optionally stops active/expired containers through
the environment manager, validates the filesystem root against configured Panda
environment roots, then hard-deletes the environment row and any attached worker
sessions. Session deletion cascades threads, messages, inputs, runs, tool jobs,
bash jobs, heartbeats, environment bindings, and A2A bindings. The purge
explicitly deletes non-cascading `runtime.outbound_deliveries` and
`runtime.runtime_requests` rows that reference the environment or attached
workers before deleting the sessions. External copied media outside the worker
environment root is report-only in v1. Dry-run is bounded and does not scan
transcript JSON for those external references, so it prints them as not scanned
rather than `0`.

Worker sessions do not receive `worker_spawn`, `spawn_subagent`,
`environment_create`, or `environment_stop` in their toolset. Historical
`worker_spawn` internals remain for old sessions/runtime clients, but are not
model-facing.
`postgres_readonly_query` in subagents is controlled by profile/toolGroups
policy, for example the `memory` group.

## Disposable Environment Manager

The manager boundary is intentionally separate from `panda-core`. Core only
talks to `PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL`; the manager process owns
Docker Engine access.

Run it separately:

```bash
panda environment-manager \
  --host 127.0.0.1 \
  --port 8095 \
  --token "$PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN" \
  --image panda-runner:latest
```

Then point core at it:

```bash
PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL=http://127.0.0.1:8095
PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=...
```

For a Dockerized core, put the manager and disposable bash-server containers on a
Docker network that `panda-core` can reach:

```bash
PANDA_DISPOSABLE_RUNNER_NETWORK=panda_runner_net
PANDA_EXECUTION_ENVIRONMENT_MANAGER_HOST=0.0.0.0
```

With a network configured, manager-created containers are returned as
`http://<container-name>:8080`. Without a network, the manager publishes an
ephemeral host port and returns `http://127.0.0.1:<port>` by default.

The manager provides:

- create disposable environment
- stop/dispose environment
- health/readiness check
- runner URL and cwd/root discovery

Disposable bash-server containers do not mount `/root/.panda`, the agent home, or
the Codex home by default. Credentials are passed only per bash request through
the environment binding credential policy.

`scripts/docker-stack.sh up --build` builds `panda-runner:latest` with
`PANDA_RUNNER_NODE_MAJOR=${PANDA_RUNNER_NODE_MAJOR:-22}`. Supported values are
`20`, `22`, and `24`; the Dockerfile default remains Node 24 for app/browser
targets unless those builds explicitly pass another `NODE_MAJOR`.

Disposable workers do mount agent-scoped file-sharing dirs:

- worker: `/workspace`, `/inbox`, `/artifacts`
- parent runner: `/environments/<envDir>`
- core: `${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}/<agentKey>/<envDir>`
- host: `${PANDA_ENVIRONMENTS_HOST_ROOT:-$HOME/.panda/environments}/<agentKey>/<envDir>`

The environment metadata stores these mappings under `metadata.filesystem`.
Path resolution maps worker and parent-runner paths back to core-visible paths
before attachments are read.

Do not mount the Docker socket into `panda-core`.

If `BASH_SERVER_SHARED_SECRET` is enabled, wire the same value through `panda-core`, `panda-environment-manager`, and the disposable bash-server containers. It authenticates runner POST endpoints; it does not make runner networks public-safe.
