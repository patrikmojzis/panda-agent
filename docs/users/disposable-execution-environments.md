# Disposable execution environments and subagents

Panda V2 uses durable `spawn_subagent(...)` sessions for delegated work. The old
model-facing worker spawn path is gone.

## Main flow

- Use `spawn_subagent(profile="workspace", prompt="inspect the repo and report findings")` for the normal agent-workspace path.
- Use `environment_create` first when the child needs an isolated filesystem or long-lived disposable runner.
- Then call `spawn_subagent(profile="workspace", prompt="...", execution="isolated_environment", environmentId="...")`.
- Subagents communicate progress and completion through normal A2A `message_agent` calls back to the parent session.

## Filesystem layout

Disposable isolated environments mount:

- `/workspace` for normal working files
- `/inbox` for parent-provided inputs
- `/artifacts` for reviewable outputs

The parent runner sees the same environment under `/environments/<envDir>/...`.
Use `/inbox` and `/artifacts` for coordination; do not rely on transcript copying.

## Setup scripts and default toolchain

Disposable workspace containers are intentionally minimal. By default, an
isolated workspace should not be assumed to have `node`, `pnpm`, `corepack`, or
`panda` installed.

When a project needs tools, pass an explicit setup script to `environment_create`:

```text
environment_create(label="panda-agent", setupScript="./setup-worker.sh")
```

Panda copies the script into the environment as `/artifacts/setup/setup.sh` and
runs it before marking the environment ready. There is no automatic
`environment-setup.sh` discovery; setup must be requested explicitly.

Project setup scripts should install and verify their own toolchain. For example,
a Node project should install the expected Node version, enable Corepack, prepare
`pnpm`, install dependencies, and fail loudly if any readiness check is missing.


## Workspace image rebuilds

`./scripts/docker-stack.sh up --build` keeps disposable environments enabled but no
longer rebuilds the expensive workspace substrate image on every app/runtime
deploy. When `PANDA_DISPOSABLE_WORKSPACE_IMAGE` is unset, the stack helper
computes a deterministic default image tag, `panda-workspace:<hash>`, from the
Dockerfile `workspace-runner` stage and script cache version.

Normal deploy flow:

```bash
./scripts/docker-stack.sh up --build
```

If the computed `panda-workspace:<hash>` image already exists locally, the helper
skips rebuilding it and wires that tag into the generated environment-manager
compose file. If the Dockerfile workspace substrate changes, the hash changes and
the next `up --build` builds the new tag once.

To force a rebuild of the selected workspace image without changing the
substrate, set either refresh flag:

```bash
PANDA_REFRESH_WORKSPACE=true ./scripts/docker-stack.sh up --build
PANDA_BUILD_WORKSPACE=true ./scripts/docker-stack.sh up --build
```

Both flags are treated as force-rebuild requests; if both are set the behavior is
the same as setting either one. If `PANDA_DISPOSABLE_WORKSPACE_IMAGE` is set
explicitly, that image still wins for runtime. The stack helper skips building an
explicit override by default, and force-rebuilds that explicit tag only when
`PANDA_REFRESH_WORKSPACE=true` or `PANDA_BUILD_WORKSPACE=true` is set.

## Runtime context

Every durable child receives a **Subagent Runtime Context** with:

- parent session id
- profile and execution mode
- task/prompt and optional context
- environment id and mounted paths when isolated

Subagents do not inherit the parent transcript automatically. Pass the exact
context the child needs in the `prompt` and `context` fields.

## Purge

Operators hard-purge old stopped subagent environments with:

```bash
panda subagents purge --stopped --older-than 7d --dry-run
panda subagents purge --stopped --older-than 7d --execute
```

`panda subagents purge` refuses to run without a selector. `--execute` stops
matched active containers when needed, deletes subagent sessions and cascaded
runtime rows, deletes non-cascading A2A/outbound/runtime request rows, and then
removes the environment filesystem root when it is safe.

Useful selectors:

```bash
panda subagents purge --session-id <subagentSessionId> --dry-run
panda subagents purge --environment-id <environmentId> --dry-run
panda subagents purge --expired --execute
```

## Custom profiles

Built-in profiles are seeded by the runtime. Agent-scoped custom profiles are
managed with the CLI or, from an agent session, the model-facing
`upsert_subagent_profile` tool. The tool scopes writes to the current `agentKey`
and returns profile metadata without echoing the full prompt.

CLI examples:

```bash
panda subagents profiles list --agent clawd --json
panda subagents profiles get workspace --agent clawd --json
panda subagents profiles upsert code-review \
  --agent clawd \
  --description "Review local code changes" \
  --tool-groups core,workspace_read \
  --prompt-file ./code-review-profile.md \
  --json
panda subagents profiles disable code-review --agent clawd
```

Profiles store prompt, tool groups, model/thinking defaults, and enabled state.
`workspace_read` and `execute` are mutually exclusive: use `workspace_read` for
read-only wrappers, or `execute` for shell/background execution. `execute` can
read workspace files through shell commands, so do not combine them.
They do **not** store credentials, credential policies, environment ids, raw tool
allowlists, skill allowlists, or per-spawn execution choices; pass those at spawn
time.
