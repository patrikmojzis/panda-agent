# Remote Bash Runner

## What This Is

Panda can now run `bash` in two modes:

- `local`: the old in-process shell path
- `remote`: `panda-core` calls a per-agent runner over HTTP

The remote mode is the one you want in Docker or any deployment where the core process holds real secrets.

No SSH.
Just a small internal runner service.

## The Model

In v1:

- `agentKey` is the filesystem boundary
- one runner container serves one agent
- each runner mounts that agent's home
- shared workspaces are explicit extra mounts

That means:

- `panda-core` keeps DB creds, provider tokens, and connector secrets
- `panda-runner-<agent>` executes shell commands
- the runner should not have DB creds or a network path to Postgres

## Core Env

Set this in `panda-core`:

```bash
PANDA_BASH_EXECUTION_MODE=remote
PANDA_RUNNER_URL_TEMPLATE=http://panda-runner-{agentKey}:8080
PANDA_RUNNER_CWD_TEMPLATE=/root/.panda/agents/{agentKey}
```

`PANDA_RUNNER_URL_TEMPLATE` can be:

- a per-agent template with `{agentKey}`
- a plain URL if every agent should hit the same runner endpoint

Examples:

- `http://panda-runner-{agentKey}:8080`
- `http://runner-gateway/{agentKey}`
- `http://127.0.0.1:8080`

`PANDA_RUNNER_CWD_TEMPLATE` tells `panda-core` what the runner-visible starting directory should be before the first bash call.

Use it when remote bash is on.
Especially use it when `panda-core` runs on your host but the runner lives in Docker, because the host `cwd` is not meaningful inside the container.

## Runner Env

Each runner gets its own agent key:

```bash
PANDA_RUNNER_AGENT_KEY=panda
PANDA_RUNNER_PORT=8080
```

The runner serves one agent.
What it can actually touch is defined by container mounts and sandboxing.

## Start Commands

Core:

```bash
panda run
```

Runner:

```bash
panda runner
```

You can override runner settings from the CLI too:

```bash
panda runner --agent panda --port 8080
```

## Example Compose

This is the shape.
Adjust image names and mounts to match your deployment.

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: panda
      POSTGRES_USER: panda_app
      POSTGRES_PASSWORD: app_pw
    networks:
      - core_net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U panda_app -d panda"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 5s

  panda-core:
    build: ..
    image: panda:latest
    command: ["run"]
    env_file:
      - ../.env
    environment:
      PANDA_DATABASE_URL: postgres://panda_app:app_pw@db:5432/panda
      PANDA_BASH_EXECUTION_MODE: remote
      PANDA_RUNNER_URL_TEMPLATE: http://panda-runner-{agentKey}:8080
      PANDA_RUNNER_CWD_TEMPLATE: /root/.panda/agents/{agentKey}
    volumes:
      - ${HOME}/.panda:/root/.panda
      - ${PANDA_SHARED_ROOT:-${HOME}/.panda/shared}:/workspace/shared
    depends_on:
      db:
        condition: service_healthy
      panda-runner-panda:
        condition: service_healthy
      panda-runner-ops:
        condition: service_healthy
    networks:
      - core_net
      - runner_net
    healthcheck:
      test:
        - CMD
        - node
        - --input-type=module
        - -e
        - |
          import { PostgresPandaDaemonStateStore } from "/app/dist/features/daemon-state/index.js";
          import { createPandaPool } from "/app/dist/features/panda/runtime.js";
          import { DEFAULT_PANDA_DAEMON_KEY, PANDA_DAEMON_STALE_AFTER_MS } from "/app/dist/features/panda/daemon.js";
          const pool = createPandaPool(process.env.PANDA_DATABASE_URL);
          const store = new PostgresPandaDaemonStateStore({ pool });
          const state = await store.readState(DEFAULT_PANDA_DAEMON_KEY);
          await pool.end();
          if (!state || Date.now() - state.heartbeatAt > PANDA_DAEMON_STALE_AFTER_MS) {
            process.exit(1);
          }
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s

  panda-runner-panda:
    build: ..
    image: panda:latest
    command: ["runner"]
    environment:
      PANDA_RUNNER_AGENT_KEY: panda
      PANDA_RUNNER_PORT: 8080
    volumes:
      - ${HOME}/.panda/agents/panda:/root/.panda/agents/panda
      - ${PANDA_SHARED_ROOT:-${HOME}/.panda/shared}:/workspace/shared
    networks:
      - runner_net
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 5s

  panda-runner-ops:
    build: ..
    image: panda:latest
    command: ["runner"]
    environment:
      PANDA_RUNNER_AGENT_KEY: ops
      PANDA_RUNNER_PORT: 8080
    volumes:
      - ${HOME}/.panda/agents/ops:/root/.panda/agents/ops
      - ${PANDA_SHARED_ROOT:-${HOME}/.panda/shared}:/workspace/shared
    networks:
      - runner_net
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 5s

networks:
  core_net:
  runner_net:
```

## Hard Rules

- Do not put DB creds in runner env.
- Do not put provider API keys in runner env.
- Add `PANDA_READONLY_DATABASE_URL` to `panda-core` only after you have actually created the restricted Postgres role.
- Do not mount the Docker socket into runners.
- Do not let runners reach Postgres over the network.
- Do not mount a giant shared parent directory unless you want every command in that runner to see it.
- Shared workspaces are opt-in and collisions are expected if multiple agents use them at the same time.

## Operational Notes

- Adding a new agent does not require rebuilding the image.
  Add a new runner service or equivalent deployment entry for that agent.
- If two agents should share files, mount the same extra workspace into both runners.
- If they should not share files, do not mount the same workspace into both runners.
- Plain runner URLs like `http://127.0.0.1:8080` work for the single-runner local-dev case.
- Plain runner URLs do not remove the need for `PANDA_RUNNER_CWD_TEMPLATE` when core and runner see different filesystems.

## Verify It

Health check:

```bash
curl http://panda-runner-panda:8080/health
```

It should return the runner agent key.
It should return the runner agent key.

Then verify the core is actually using remote mode by running Panda with:

```bash
PANDA_BASH_EXECUTION_MODE=remote
```

If that variable is missing, Panda falls back to local in-process bash.

# Env

PANDA_BASH_EXECUTION_MODE

Tells Panda how to run bash.
local = old in-process shell inside panda-core.
remote = send bash commands to a runner over HTTP.
Anything other than exact remote falls back to local.
PANDA_RUNNER_URL_TEMPLATE

Used by panda-core only, when remote mode is on.
It is the URL pattern for finding the right runner for an agent.
It can include `{agentKey}` for per-agent routing, or be a plain URL for one shared runner.
Examples:
- http://panda-runner-{agentKey}:8080
- http://127.0.0.1:8080
PANDA_RUNNER_CWD_TEMPLATE

Used by panda-core only, when remote mode is on.
It is the runner-visible starting directory Panda should seed into new or untouched threads before the first bash call.
It can include `{agentKey}` for per-agent homes, or be a plain path if every runner should start in the same place.
Example:
- /root/.panda/agents/{agentKey}
PANDA_RUNNER_AGENT_KEY

Used by the runner container itself.
Says which agent this runner serves.
Use container mounts and sandboxing to decide what files the runner can see.
The clean mental model:

PANDA_BASH_EXECUTION_MODE = local vs remote
PANDA_RUNNER_URL_TEMPLATE = how core finds a runner
PANDA_RUNNER_CWD_TEMPLATE = what cwd remote threads should start with
PANDA_RUNNER_AGENT_KEY = which agent a runner belongs to
Typical setup:

# core
PANDA_BASH_EXECUTION_MODE=remote
PANDA_RUNNER_URL_TEMPLATE=http://panda-runner-{agentKey}:8080
PANDA_RUNNER_CWD_TEMPLATE=/root/.panda/agents/{agentKey}

# panda runner
PANDA_RUNNER_AGENT_KEY=panda
