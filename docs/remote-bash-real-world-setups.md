# Remote Bash Real-World Setups

This is the practical companion to [remote-bash-runner.md](/Users/patrikmojzis/Projects/panda-agent/docs/remote-bash-runner.md).

It answers the three questions that immediately come up once the basic Docker stack is working:

- where provider tokens go
- whether Postgres can be external
- whether only the bash runner can live in Docker while everything else stays local

If you just want to stop copy-pasting `docker run`, use:

```bash
./scripts/run-docker-runner.sh panda
```

## Rule Zero

Keep secrets in `panda-core`, not in the runner.

The runner is for bash.
The core is for:

- model/provider credentials
- Postgres credentials
- connector credentials
- everything else you would hate arbitrary shell to see

If a secret is only needed for normal Panda runtime behavior, it belongs in `panda-core`.

## 1. Passing `ANTHROPIC_OAUTH_TOKEN` Into `panda-core`

Yes. Put it on `panda-core` only.

Do not put it on `panda-runner-panda`.

### Option A: load from `.env`

If your compose file lives under `examples/` and your `.env` is in the repo root:

```yaml
services:
  panda-core:
    env_file:
      - ../.env
```

Then your repo-root `.env` can contain:

```bash
ANTHROPIC_OAUTH_TOKEN=your-token-here
```

### Option B: pass it through explicitly

```yaml
services:
  panda-core:
    environment:
      ANTHROPIC_OAUTH_TOKEN: ${ANTHROPIC_OAUTH_TOKEN}
```

Then export it in your shell before `docker compose up`:

```bash
export ANTHROPIC_OAUTH_TOKEN=your-token-here
```

### Hard rule

Only `panda-core` gets provider tokens.

The runner should not get:

- `ANTHROPIC_OAUTH_TOKEN`
- `OPENAI_API_KEY`
- `PANDA_DATABASE_URL`
- `PANDA_READONLY_DATABASE_URL`

If you put those into the runner, you broke the boundary.

## 2. Using External Postgres

Yes.

You do not need the `db` container if you already have a real Postgres somewhere else.

Replace the internal DB URL with your external one:

```yaml
services:
  panda-core:
    environment:
      PANDA_DATABASE_URL: postgres://user:pass@db.example.com:5432/panda
```

If you also use the read-only SQL tool properly:

```yaml
services:
  panda-core:
    environment:
      PANDA_DATABASE_URL: postgres://panda_app:app_pw@db.example.com:5432/panda
      PANDA_READONLY_DATABASE_URL: postgres://panda_readonly:readonly_pw@db.example.com:5432/panda
```

Then you can remove the local `db:` service entirely.

### Host chat with external Postgres

If `panda chat` runs on your host, point it at the same DB:

```bash
pnpm dev chat \
  --db-url postgres://user:pass@db.example.com:5432/panda \
  --agent panda
```

### What must be true

- `panda-core` can reach that Postgres host
- your local `panda chat` can also reach it if chat runs outside Docker
- the DB user has enough rights for Panda’s normal schema setup

## 3. Local Everything, Docker Runner Only

Yes.

This is a very good dev setup.

It gives you:

- local `panda run`
- local `panda chat`
- Docker-isolated bash

That means the only thing inside Docker is the runner.

### Start the runner in Docker

The easy path:

```bash
./scripts/run-docker-runner.sh panda
```

That script:

- creates `~/.panda/agents/<agentKey>` if missing
- creates `~/.panda/shared` if missing
- starts the runner with the right mounts
- prints the local env you need for `panda run`

Manual version if you want to see the raw Docker command:

```bash
docker run --rm -p 8080:8080 \
  -e PANDA_RUNNER_AGENT_KEY=panda \
  -v "$HOME/.panda/agents/panda:/root/.panda/agents/panda" \
  -v "$HOME/.panda/shared:/workspace/shared" \
  panda:latest runner
```

### Run Panda locally against that runner

Set these in the shell where you start `panda run`:

```bash
export PANDA_BASH_EXECUTION_MODE=remote
export PANDA_RUNNER_URL_TEMPLATE=http://127.0.0.1:8080
export PANDA_RUNNER_CWD_TEMPLATE=/root/.panda/agents/{agentKey}
```

Then start Panda locally:

```bash
pnpm dev run --db-url postgresql://localhost:5432/panda
```

And start chat locally:

```bash
pnpm dev chat --db-url postgresql://localhost:5432/panda --agent panda
```

### Important detail

`PANDA_RUNNER_URL_TEMPLATE` can be a plain URL.

That is the cleanest option for the simple one-runner local setup.

So for one local runner, use:

```bash
export PANDA_RUNNER_URL_TEMPLATE=http://127.0.0.1:8080
```

But that only solves routing.
You should also tell `panda-core` what cwd exists inside the runner:

```bash
export PANDA_RUNNER_CWD_TEMPLATE=/root/.panda/agents/{agentKey}
```

Without that, new remote threads may still start life with your host project path and the first bash call has to recover from it.

If you run multiple per-agent runners locally, you still need an actual template:

```bash
export PANDA_RUNNER_URL_TEMPLATE=http://127.0.0.1:{agentKey}
```

That only works if you also choose ports or a gateway strategy that makes sense.

The safer default is still one Docker runner per agent name or one runner gateway that routes correctly.

## Recommended Setups

### Setup A: Fast local dev

- `panda run` on your host
- `panda chat` on your host
- Postgres on your host or external
- bash runner in Docker

This is the nicest day-to-day setup while developing the app.

### Setup B: Clean deployment

- `panda-core` in Docker
- one `panda-runner-<agentKey>` container per agent boundary
- external Postgres
- provider tokens only on `panda-core`

This is the more serious deployment shape.

## Minimal Examples

### Full Docker core + runner + external Postgres

```yaml
services:
  panda-core:
    image: panda:latest
    command: ["run"]
    env_file:
      - ../.env
    environment:
      PANDA_DATABASE_URL: postgres://panda_app:app_pw@db.example.com:5432/panda
      PANDA_BASH_EXECUTION_MODE: remote
      PANDA_RUNNER_URL_TEMPLATE: http://panda-runner-{agentKey}:8080
      PANDA_RUNNER_CWD_TEMPLATE: /root/.panda/agents/{agentKey}
    volumes:
      - ${HOME}/.panda:/root/.panda
      - ${PANDA_SHARED_ROOT:-${HOME}/.panda/shared}:/workspace/shared
    depends_on:
      - panda-runner-panda
    networks:
      - runner_net

  panda-runner-panda:
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

networks:
  runner_net:
```

There is also a ready-made example in [docker-compose.remote-bash.external-db.yml](/Users/patrikmojzis/Projects/panda-agent/examples/docker-compose.remote-bash.external-db.yml).

### Local core/chat + Docker runner

```bash
docker run --rm -p 8080:8080 \
  -e PANDA_RUNNER_AGENT_KEY=panda \
  -v "$HOME/.panda/agents/panda:/root/.panda/agents/panda" \
  -v "$HOME/.panda/shared:/workspace/shared" \
  panda:latest runner
```

```bash
export PANDA_BASH_EXECUTION_MODE=remote
export PANDA_RUNNER_URL_TEMPLATE=http://127.0.0.1:8080
export PANDA_RUNNER_CWD_TEMPLATE=/root/.panda/agents/{agentKey}
export ANTHROPIC_OAUTH_TOKEN=your-token-here

pnpm dev run --db-url postgresql://localhost:5432/panda
pnpm dev chat --db-url postgresql://localhost:5432/panda --agent panda
```

## Common Mistakes

- Putting `ANTHROPIC_OAUTH_TOKEN` into the runner container.
- Putting `PANDA_DATABASE_URL` into the runner container.
- Assuming `chat` needs a direct HTTP connection to `panda-core`.
  It does not. It talks through Postgres.
- Using a shared mount path that does not exist on the host.
- Using `/bin/zsh` in a container that only has bash.
- Treating the runner as trusted just because it is “your” container.
- Forgetting `PANDA_RUNNER_CWD_TEMPLATE` when core runs on the host and the runner runs in Docker.

## Bottom Line

The runner should stay stupid.

It should know:

- which agent it serves
- which folders are mounted into its container
- how to run bash

It should not know:

- model tokens
- database credentials
- connector secrets

That split is the whole point.
