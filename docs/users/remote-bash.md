# Remote Bash

Panda can run `bash` in two modes:

- `local`: in-process shell execution inside `panda-core`
- `remote`: `panda-core` calls a runner over HTTP

In both modes, foreground bash mutates the shared shell session and background bash is isolated.

Use remote mode when you want Docker or another sandbox boundary between the core runtime and shell execution.

## Rule Zero

Keep secrets in `panda-core`, not in the runner.

The core is for:

- model and provider credentials
- Postgres credentials
- connector credentials
- everything else you would hate arbitrary shell to see

The runner is for bash. Nothing more.

## Credentials And Secret Env

Remote runners do not own static secrets.

In credentials v1, `panda-core` may still send short-lived env values with a single `/exec` request:

- stored credentials resolved for the current session/thread context
- persisted shell session env
- explicit `bash.env` values for that call

For remote background jobs, `panda-core` sends the same snapshot precedence at spawn time:

- resolved credentials
- current foreground shell session env
- explicit `bash.env` values for that call

Those values exist only for that process execution. The runner does not store them in Postgres, files, or long-lived process env.

That also means the core-to-runner link is sensitive. Keep it private.

## Mental Model

In v1:

- `agentKey` is the filesystem boundary
- one runner serves one agent
- each runner mounts that agent home
- shared workspaces are explicit extra mounts

That means:

- `panda-core` keeps DB creds, provider tokens, and connector secrets
- `panda-runner-<agent>` executes shell commands
- the runner should not have DB creds or a network path to Postgres

Background jobs follow the same split:

- Panda starts them explicitly
- the runner owns the live process
- Panda stores durable job metadata
- active jobs can show up in Panda context while they run
- watcher-owned completions may wake Panda with a queued background event, while `bash_job_status` / `bash_job_wait` remain the explicit control tools

## Core Env

Set this in `panda-core`:

```bash
BASH_EXECUTION_MODE=remote
RUNNER_URL_TEMPLATE=http://panda-runner-{agentKey}:8080
RUNNER_CWD_TEMPLATE=/root/.panda/agents/{agentKey}
```

`RUNNER_URL_TEMPLATE` can be:

- a per-agent template with `{agentKey}`
- a plain URL if every agent should hit the same runner endpoint

Examples:

- `http://panda-runner-{agentKey}:8080`
- `http://runner-gateway/{agentKey}`
- `http://127.0.0.1:8080`

`RUNNER_CWD_TEMPLATE` tells `panda-core` what starting directory exists inside the runner.
Use it whenever remote bash is on, especially when the core runs on your host but the runner lives in Docker.

## Runner Env

Each runner gets its own agent key:

```bash
RUNNER_AGENT_KEY=panda
RUNNER_PORT=8080
```

The runner serves one agent. Container mounts and sandboxing decide what files it can touch.

## Setup A: Local Core, Docker Runner

This is the nicest day-to-day dev setup:

- `panda run` on your host
- `panda chat` on your host
- Postgres on your host or external
- bash runner in Docker

Easy path:

```bash
./scripts/run-docker-runner.sh panda
```

Manual path:

```bash
docker run --rm -p 8080:8080 \
  -e RUNNER_AGENT_KEY=panda \
  -v "$HOME/.panda/agents/panda:/root/.panda/agents/panda" \
  -v "$HOME/.panda/shared:/workspace/shared" \
  panda:latest runner
```

Then start Panda locally against that runner:

```bash
export BASH_EXECUTION_MODE=remote
export RUNNER_URL_TEMPLATE=http://127.0.0.1:8080
export RUNNER_CWD_TEMPLATE=/root/.panda/agents/{agentKey}

pnpm dev run --db-url postgresql://localhost:5432/panda
pnpm dev chat --db-url postgresql://localhost:5432/panda --agent panda
```

If you only need a one-shot live check and not the TUI, use the headless smoke path instead:

```bash
TEST_DATABASE_URL=postgresql://localhost:5432/panda_smoke \
pnpm smoke --agent panda --input "Run pwd and tell me where you are." --expect-tool bash
```

## Setup B: Docker Core, Per-Agent Runners

This is the cleaner deployment shape:

- `panda-core` in Docker
- one `panda-runner-<agentKey>` container per agent boundary
- external Postgres
- provider tokens only on `panda-core`

The primary UX is now the stack wrapper, not hand-editing Compose:

```bash
# in .env
PANDA_AGENTS=claw,luna

./scripts/docker-stack.sh up --build
```

Normal deployment flow:

1. Put your real `DATABASE_URL` and `BROWSER_RUNNER_SHARED_SECRET` in `.env`
2. Set `PANDA_AGENTS=claw,luna`
3. Run `./scripts/docker-stack.sh up --build`

That wrapper:

- starts `panda-core`
- starts the shared `panda-browser-runner`
- generates one `panda-runner-<agentKey>` service per agent
- auto-runs `panda agent ensure <agentKey>` inside core after startup
- auto-enables the `panda-telegram` worker when `TELEGRAM_BOT_TOKEN` is set

For `openai-codex`, the Docker examples mount a host Codex home read-only into `panda-core` and set `CODEX_HOME=/root/.codex` inside the container. That is better than baking `OPENAI_OAUTH_TOKEN` into the image or env because Panda reads the token from `auth.json` at request time, while a raw env token goes stale and then just sits there like a brick.

The base compose file it builds on is still [examples/docker-compose.remote-bash.external-db.yml](../../examples/docker-compose.remote-bash.external-db.yml).

## External Postgres

You do not need a local `db` container if you already have a real Postgres somewhere else.

Point `panda-core` at that database:

```yaml
services:
  panda-core:
    environment:
      DATABASE_URL: postgres://panda_app:app_pw@db.example.com:5432/panda
      READONLY_DATABASE_URL: postgres://panda_readonly:readonly_pw@db.example.com:5432/panda
```

If `panda chat` runs on your host, point it at the same DB:

```bash
pnpm dev chat \
  --db-url postgres://user:pass@db.example.com:5432/panda \
  --agent panda
```

## Verify It

Health check:

```bash
./scripts/docker-stack.sh ps
```

If you want a specific runner check:

```bash
docker compose --env-file .env \
  -f examples/docker-compose.remote-bash.external-db.yml \
  -f .generated/docker-compose.remote-bash.external-db.runners.yml \
  exec -T panda-runner-claw curl -fsS http://127.0.0.1:8080/health
```

It should return the runner agent key.

Then verify the core is actually using remote mode:

```bash
echo "$BASH_EXECUTION_MODE"
```

If that is not exactly `remote`, Panda falls back to local in-process bash.

## Remote Background Jobs

Remote mode supports the same background bash interface as local mode:

- start with `bash(background=true)`
- inspect with `bash_job_status`
- wait with `bash_job_wait`
- stop with `bash_job_cancel`

The important rule stays the same:

- remote foreground bash mutates the shared shell session
- remote background bash does not
- resetting the current session cancels the retired thread's remote background jobs

Background jobs snapshot cwd and env at spawn time and never merge anything back into the shared shell state.

## Runner Endpoints

Foreground execution still uses:

- `POST /exec`
- `POST /abort`

Remote background jobs add:

- `POST /jobs/start`
- `POST /jobs/status`
- `POST /jobs/wait`
- `POST /jobs/cancel`

Those endpoints are runner-internal plumbing for Panda core. They are not meant as a public API contract for random clients.

## Hard Rules

- do not put DB creds in runner env
- do not put provider API keys in runner env
- do not mount the Docker socket into runners
- do not let runners reach Postgres over the network
- do not expose the core-to-runner HTTP hop on a public network
- do not mount a giant shared parent directory unless you really want the runner to see all of it
- shared workspaces are opt-in and collisions are expected if multiple agents use them at the same time

That split is the whole point. If the runner knows secrets, the boundary is fake.
