# Execution Environments

Execution environments are the session-scoped boundary for bash execution.

For operator setup, use
[Disposable Execution Environments](../users/disposable-execution-environments.md).

The runner is still dumb: it exposes the bash HTTP protocol and runs commands.
The environment decides which runner endpoint, cwd/root, credential policy, and
tool policy apply to a session.

## Current Shape

- `main` and `branch` sessions without a binding keep the old behavior.
- fallback remote bash still uses `RUNNER_URL_TEMPLATE` and `RUNNER_CWD_TEMPLATE`
  with `{agentKey}`.
- fallback persistent agent runners keep access to all stored credentials for the
  current agent.
- `worker` sessions exist as a separate session kind for constrained role runs.
- worker/disposable environments default to explicit credential allowlists.
- `worker_spawn` creates a worker session plus a default disposable environment.
- `worker_stop` stops the disposable environment and leaves files in place.
- parent LLM context renders active and recently stopped workers from session and
  environment state.

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
- Remote runners receive credentials only in the per-command/job env snapshot.
  Runners do not load credentials themselves.

## Worker Controls

`worker_spawn` is intentionally a runtime tool, not a prompt trick. It calls
`WorkerSessionService.createWorkerSession`, which:

- creates a `worker` session using the same `agentKey` as the parent
- stores worker role and parent session id in session metadata
- creates the disposable environment through `ExecutionEnvironmentLifecycleService`
- binds the worker session to that environment as default
- queues or wakes the worker handoff input

The worker model defaults to `WORKER_MODEL` when set. Worker thinking defaults
to `high` unless the caller passes `thinking`. Worker environment TTL defaults
to 3 hours unless the caller passes `ttlMs`.

`worker_stop` validates that the target worker belongs to the current
`agentKey` and current parent `sessionId` before calling
`ExecutionEnvironmentLifecycleService.stopEnvironment`. It does not delete
worker filesystem roots.

Worker sessions do not receive `worker_spawn` or `worker_stop` in their toolset.

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

For a Dockerized core, put the manager and disposable runner containers on a
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

Disposable runner containers do not mount `/root/.panda`, the agent home, or
the Codex home by default. Credentials are passed only per bash request through
the environment binding credential policy.

Disposable workers do mount agent-scoped file-sharing dirs:

- worker: `/workspace`, `/inbox`, `/artifacts`
- parent runner: `/environments/<envDir>`
- core: `${PANDA_ENVIRONMENTS_ROOT:-/root/.panda/environments}/<agentKey>/<envDir>`
- host: `${PANDA_ENVIRONMENTS_HOST_ROOT:-$HOME/.panda/environments}/<agentKey>/<envDir>`

The environment metadata stores these mappings under `metadata.filesystem`.
Path resolution maps worker and parent-runner paths back to core-visible paths
before attachments are read.

Do not mount the Docker socket into `panda-core`.
