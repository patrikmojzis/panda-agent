# Remote Bash / Bash Server

Panda can run `bash` in two modes:

- `local`: in-process shell execution inside `panda-core`
- `remote`: `panda-core` calls a private bash server over HTTP

In both modes, foreground bash mutates the shared shell session and background bash is isolated.

Use remote mode when you want Docker, a VPS, Tailscale, or another private execution boundary between the core runtime and shell execution.

For on-demand throwaway runners, start with
[Disposable Execution Environments](./disposable-execution-environments.md).

## Rule Zero

Keep secrets in `panda-core`, not in the runner.

The core is for:

- model and provider credentials
- Postgres credentials
- connector credentials
- everything else you would hate arbitrary shell to see

The bash server is for bash. Nothing more.

## Credentials And Secret Env

Remote runners do not own static secrets.

In credentials v1, `panda-core` may still send short-lived env values with a single `/exec` request:

- stored credentials resolved for the current agent
- persisted shell session env
- explicit `bash.env` values for that call

For remote background jobs, `panda-core` sends the same snapshot precedence at spawn time:

- resolved credentials
- current foreground shell session env
- explicit `bash.env` values for that call

Those values exist only for that process execution. The runner does not store them in Postgres, files, or long-lived process env.

That also means the core-to-runner link is sensitive. Keep it private. Core
derives a different bearer token for each persistent agent or bound execution
environment; possession of one runner token must not authorize another runner.

## Mental Model

In v1:

- sessions resolve a default execution environment before bash runs
- when no explicit session environment binding exists, Panda falls back to the persistent per-agent runner
- `agentKey` remains the fallback filesystem and credential boundary
- one persistent runner serves one agent
- each persistent runner mounts that agent home
- shared workspaces are explicit extra mounts

That means:

- `panda-core` keeps DB creds, provider tokens, and connector secrets
- `panda-runner-<agent>` executes shell commands
- the runner should not have DB creds or a network path to Postgres
- disposable subagent environments should use explicit credential allowlists, not inherit every agent credential

Background jobs follow the same split:

- Panda starts them explicitly
- the runner owns the live process
- Panda stores durable job metadata
- active jobs can show up in Panda context while they run
- watcher-owned completions may wake Panda with a queued background event, while `background_job_status` / `background_job_wait` remain the explicit control tools

## Core Env

Breaking change: the old exact `RUNNER_*` bash-server env names were removed. Rename them to `BASH_SERVER_*` before restarting; there are no aliases, and startup fails if both old and new names are present.

Set this in `panda-core`:

```bash
BASH_EXECUTION_MODE=remote
BASH_SERVER_URL_TEMPLATE=http://panda-runner-{agentKey}:8080
BASH_SERVER_CWD_TEMPLATE=/root/.panda/agents/{agentKey}
# Required for remote execution. Keep the master only in core.
PANDA_RUNNER_TOKEN_MASTER_KEY_FILE=/run/secrets/panda-core/runner-token-master-key
PANDA_APPS_HOST=0.0.0.0
PANDA_APPS_PORT=8092
PANDA_APPS_INTERNAL_BASE_URL=http://panda-core:8092
```

`BASH_SERVER_URL_TEMPLATE` can be:

- a per-agent template with `{agentKey}`
- a plain URL if every agent should hit the same runner endpoint

Examples:

- `http://panda-runner-{agentKey}:8080`
- `http://runner-gateway/{agentKey}`
- `http://127.0.0.1:8080`

`BASH_SERVER_CWD_TEMPLATE` tells `panda-core` what starting directory exists inside the runner.
Use it whenever remote bash is on, especially when the core runs on your host but the runner lives in Docker.

## Runner Env

Each runner gets its own agent key:

```bash
BASH_SERVER_AGENT_KEY=panda
BASH_SERVER_PORT=8080
# Optional initial-cwd guard; include every expected starting root.
BASH_SERVER_ALLOWED_ROOTS=/root/.panda/agents/panda:/workspace/shared:/environments
# Required bearer auth for POST /exec, /abort, and /jobs/*; /health stays open.
BASH_SERVER_AUTH_TOKEN_FILE=/run/secrets/panda-runner/token
```

The bash server receives only its derived token, never the master key. The
migration-only `BASH_SERVER_SHARED_SECRET` fallback remains for custom
deployments during rollout, but the generated stack does not use it. The bash
server fails startup when neither scoped nor legacy authentication is present.

The bash server serves one agent. Container mounts and sandboxing decide what files it can touch. `BASH_SERVER_ALLOWED_ROOTS` only validates the requested starting cwd; it is not a filesystem sandbox.

If you also want the browser lane to inspect Panda-hosted micro-apps inside Docker, set this on `browser-runner`:

```bash
BROWSER_ALLOW_PRIVATE_HOSTS=panda-core
```

## Setup A: Local Core, Docker Runner

This is the nicest day-to-day dev setup:

- `panda run` on your host
- `panda chat` on your host
- Postgres on your host or external
- bash runner in Docker

Easy path:

```bash
umask 077
install -d -m 700 "$HOME/.panda-core-secrets" "$HOME/.panda-runner-secrets/persistent"
node -e 'process.stdout.write(`base64:${require("node:crypto").randomBytes(48).toString("base64")}\n`)' \
  > "$HOME/.panda-core-secrets/runner-token-master-key"
node scripts/derive-runner-token.mjs \
  "$HOME/.panda-core-secrets/runner-token-master-key" persistent-agent panda panda \
  > "$HOME/.panda-runner-secrets/persistent/panda.token"
chmod 600 "$HOME/.panda-core-secrets/runner-token-master-key" \
  "$HOME/.panda-runner-secrets/persistent/panda.token"

PANDA_RUNNER_TOKEN_MASTER_KEY_FILE="$HOME/.panda-core-secrets/runner-token-master-key" \
BASH_SERVER_AUTH_TOKEN_FILE="$HOME/.panda-runner-secrets/persistent/panda.token" \
./scripts/run-docker-runner.sh panda
```

Manual path:

```bash
docker network inspect panda-runner-panda-net >/dev/null 2>&1 \
  || docker network create panda-runner-panda-net
docker run --rm --network panda-runner-panda-net -p 127.0.0.1:8080:8080 \
  -e BASH_SERVER_AGENT_KEY=panda \
  -e BASH_SERVER_AUTH_TOKEN_FILE=/run/secrets/panda-runner/token \
  -v "$HOME/.panda/agents/panda:/root/.panda/agents/panda" \
  -v "$HOME/.panda/shared:/workspace/shared" \
  -v "$HOME/.panda-runner-secrets/persistent/panda.token:/run/secrets/panda-runner/token:ro" \
  panda:latest bash-server
```

Then start Panda locally against that runner:

```bash
export BASH_EXECUTION_MODE=remote
export BASH_SERVER_URL_TEMPLATE=http://127.0.0.1:8080
export BASH_SERVER_CWD_TEMPLATE=/root/.panda/agents/{agentKey}
export PANDA_RUNNER_TOKEN_MASTER_KEY_FILE="$HOME/.panda-core-secrets/runner-token-master-key"

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
- one `panda-runner-<agentKey>` bash-server container per agent boundary
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
3. Make the file owner-only with `chmod 600 .env`
4. Run `./scripts/docker-stack.sh up --build`

The stack, Wiki, and standalone runner scripts refuse to load an env file that is readable or writable by group or other users. The error shows the exact `chmod` command for the selected file. For the main stack, you can instead run:

```bash
./scripts/docker-stack.sh permissions-fix
```

That explicit command changes only the selected env file and known Panda-managed paths under `.generated`. It also removes the obsolete `.generated/wiki-host.env` secret copy. Normal stack commands never change permissions on an env file you supplied; Panda-created generated files and directories are kept at `0600` and `0700` automatically.

Panda does not guess which unrelated host files contain secrets. If you redirect a login token, recovery command, env backup, or another secret to a file yourself, create it under `umask 077` or run `chmod 600 <file>` immediately.

That wrapper:

- starts `panda-core`
- starts the shared `panda-browser-runner`
- generates one `panda-runner-<agentKey>` service per agent running `panda bash-server`
- auto-runs `panda agent ensure <agentKey>` inside core after startup
- enables the `panda-telegram` worker when `TELEGRAM_ENABLED=true`; it runs all enabled Telegram connector accounts
- creates an owner-only Core master key and distinct runner token files under
  `PANDA_CORE_SECRETS_HOST_ROOT`, which channel and workspace containers do not mount
- places every persistent runner on its own network with Core as the only shared peer

By default every declared `PANDA_AGENTS` member still mounts
`/workspace/shared`, preserving multi-agent repository collaboration. Set
`PANDA_SHARED_WORKSPACE_AGENTS` to a comma-separated subset to narrow that trust
group, or set it explicitly empty to mount the shared workspace into no runner.
Members of that list intentionally share the repository and can modify each
other's work there; it is a collaboration boundary, not private storage.

For `openai-codex`, the Docker examples mount a host Codex home read-only into `panda-core` and set `CODEX_HOME=/root/.codex` inside the container. That is better than baking `OPENAI_OAUTH_TOKEN` into the image or env because Panda reads the token from `auth.json` at request time, while a raw env token goes stale and then just sits there like a brick.

The base compose file it builds on is still [examples/docker-compose.remote-bash.external-db.yml](../../examples/docker-compose.remote-bash.external-db.yml).

CLI-backed Panda tools use a Unix socket by default in the same-host Docker
stack. The wrapper mounts
`${PANDA_COMMAND_SOCKET_HOST_DIR:-$HOME/.panda/run/command}` into Core and the
declared runners; it does not put a command-control HTTP endpoint on runner
networks. Runners receive scoped command access per bash call. Set
`PANDA_COMMAND_TRANSPORT=http` only for an explicitly remote runner topology;
named or DB-bound targets fail closed when the selected transport cannot reach
their command-access endpoint.

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

It should return the bash server agent key. `/health` is intentionally unauthenticated so private network health checks stay simple.

Then verify the core is actually using remote mode:

```bash
echo "$BASH_EXECUTION_MODE"
```

If that is not exactly `remote`, Panda falls back to local in-process bash.

## Session execution targets

A session can bind named runner targets so the model can call tools with
`target: "vps"` instead of relying only on global `BASH_SERVER_*` defaults.
This is the attach/register/bind/list/status/detach operator flow:

```bash
# Personal PC/Mac attach: register + bind the runner and write its derived token to a private file.
panda runner attach <sessionRef> mac \
  --agent panda \
  --runner-url http://mac-mini.tailnet:8080 \
  --runner-cwd /Users/patrik/.panda/agents/panda \
  --allow-tools bash

# Already-provisioned environment: bind it to another session alias.
panda session targets bind <sessionRef> vps \
  --agent panda \
  --environment-id <existingEnvironmentId> \
  --allow-tools bash

# See default + named targets and runner reachability.
panda session targets list <sessionRef> --agent panda
panda session targets status <sessionRef> default --agent panda
panda session targets status <sessionRef> vps --agent panda

# Remove a non-default alias.
panda session targets detach <sessionRef> vps --agent panda
```

`--allow-tools` is required for new named targets and is enforced at call time.
If a selected target has no allowlist, or omits `bash`, the tool fails before it
touches the runner or target filesystem. Binding another target with `--default`
switches the session default; after that, the old alias can be detached.

Use `panda session targets list` or `status` to inspect session execution targets.
The health result means **reachable** only: it is an unauthenticated runner `/health` probe,
not proof that the runner token or target agent header will authorize a
real tool call. A wrong-secret or wrong-agent runner may be reachable and still
fail at execution time.

## Remote Background Jobs

Remote mode supports the same background bash interface as local mode:

- start with `bash(background=true, maxRuntimeMs=...)`
- inspect with `background_job_status`
- wait with `background_job_wait`
- stop with `background_job_cancel`

The important rule stays the same:

- remote foreground bash mutates the shared shell session
- remote background bash does not
- resetting the current session cancels the retired thread's remote background jobs

Background jobs snapshot cwd and env at spawn time and never merge anything back into the shared shell state.
`timeoutMs` is foreground-only. Remote background starts accept only
`maxRuntimeMs` for process lifetime; old background `timeoutMs` payloads fail
instead of acting as an alias. The default maximum runtime is 30 minutes and the
maximum is 6 hours.

## Runner Endpoints

Foreground execution still uses:

- `POST /exec`
- `POST /abort`

Remote background jobs add:

- `POST /jobs/start`
- `POST /jobs/status`
- `POST /jobs/wait`
- `POST /jobs/cancel`

Those endpoints are runner-internal plumbing for Panda core. They are not meant
as a public API contract for random clients. Every POST requires the bearer
token derived for that exact agent/environment scope; `/health` remains open
inside the private network.

## Disposable Runners

Disposable runner setup lives in
[Disposable Execution Environments](./disposable-execution-environments.md).

## Compatibility

Current compatibility aliases:

- `panda bash-server` is preferred
- `panda runner` still works for now
- Docker target `bash-runner` is preferred
- Docker target `runner`, image/service names like `panda-runner:latest` and `panda-runner-<agent>` still work for now

## Hard Rules

- do not put DB creds in runner env
- do not put provider API keys in runner env
- do not mount the Docker socket into `panda-core`
- do not mount the Docker socket into runners
- do not place disposable runner token files below an environment or workspace mount
- do not let runners reach Postgres over the network
- do not expose the core-to-runner HTTP hop on a public network, even with scoped tokens
- do not mount a giant shared parent directory unless you really want the runner to see all of it
- shared workspaces are opt-in and collisions are expected if multiple agents use them at the same time

That split is the whole point. If the runner knows secrets, the boundary is fake.
