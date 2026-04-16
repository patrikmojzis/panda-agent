# Browser

Panda ships with a built-in `browser` tool.

It now runs through a dedicated `browser-runner` service.

That split is intentional:

- `panda-core` keeps DB creds, model keys, and connector secrets
- `browser-runner` owns Chromium, Playwright, session state, and browser network access
- the browser lane no longer requires Docker access inside `panda-core`

## What It Does

The tool supports:

- `navigate`
- `snapshot`
- `click`
- `type`
- `press`
- `select`
- `wait`
- `evaluate`
- `screenshot`
- `pdf`
- `close`

The public tool API did not change.

## Runtime Shape

- one browser session per Panda thread
- one active page in that session
- popups/new tabs switch to the newest page automatically
- idle sessions expire after 10 minutes by default
- hard max session age is 60 minutes by default
- `browser close` kills the session immediately

Thread-scoped sessions persist Playwright storage state in the browser-runner data directory, so auth state usually survives:

- `browser close`
- idle expiry
- max-age recycling
- browser-runner restarts that reuse the same runner data volume

If Panda has no `threadId`, the browser falls back to an ephemeral one-call session with no persistence.

## Core Env

Set this in `panda-core`:

```bash
BROWSER_RUNNER_URL=http://panda-browser-runner:8080
BROWSER_RUNNER_SHARED_SECRET=change-me
```

`BROWSER_RUNNER_URL` can point at any reachable runner base URL.

## Runner Env

Set this in `browser-runner`:

```bash
BROWSER_RUNNER_PORT=8080
BROWSER_RUNNER_SHARED_SECRET=change-me
BROWSER_RUNNER_DATA_DIR=/home/pwuser/.panda/browser-runner
```

Optional tuning:

- `BROWSER_ACTION_TIMEOUT_MS`
- `BROWSER_SESSION_IDLE_TTL_MS`
- `BROWSER_SESSION_MAX_AGE_MS`

## Setup A: Local Core, Docker Browser Runner

This is the nicest dev setup now:

- `panda run` on your host
- `browser-runner` in Docker
- Postgres on your host or external

Build images:

```bash
docker build -t panda:latest .
docker build --target browser-runner -t panda-browser-runner:latest .
```

Start the runner:

```bash
SEC=$(pwd)/assets/playwright-seccomp-profile.json

docker run --rm --init --ipc=host -p 8081:8080 \
  --user pwuser \
  --security-opt "seccomp=$SEC" \
  -e BROWSER_RUNNER_PORT=8080 \
  -e BROWSER_RUNNER_SHARED_SECRET=change-me \
  -e BROWSER_RUNNER_DATA_DIR=/home/pwuser/.panda/browser-runner \
  -v "$HOME/.panda-browser-runner:/home/pwuser/.panda/browser-runner" \
  panda-browser-runner:latest
```

That separate host path is intentional. It keeps browser cookies and storage state out of the core-mounted `~/.panda` tree by default.

Start Panda locally:

```bash
export BROWSER_RUNNER_URL=http://127.0.0.1:8081
export BROWSER_RUNNER_SHARED_SECRET=change-me

pnpm dev run --db-url postgresql://localhost:5432/panda
```

## Setup B: Docker Core, Docker Browser Runner

This is the deployment shape:

- `panda-core` in Docker
- `browser-runner` in Docker
- external Postgres
- DB/provider secrets only on `panda-core`

The ready-made compose example is:

- [examples/docker-compose.remote-bash.external-db.yml](../../examples/docker-compose.remote-bash.external-db.yml)

Run that compose example from the repo root, or set `BROWSER_RUNNER_SECCOMP_PROFILE` to an absolute host path for `assets/playwright-seccomp-profile.json`.

That stack now includes:

- `panda-core`
- `panda-runner-panda` for remote bash
- `panda-browser-runner` for browser

## Screenshots And PDFs

Final screenshots and PDFs still land under Panda's normal media storage on the core side.

Typical paths:

- `~/.panda/media/browser/<thread-id>/...`
- `~/.panda/agents/<agentKey>/media/browser/<thread-id>/...`

The browser-runner keeps its own session state and scratch artifacts under `BROWSER_RUNNER_DATA_DIR`.

## Safety Boundaries

Browser v2 still blocks:

- non-HTTP(S) URLs
- embedded credentials in URLs
- loopback targets
- private IP ranges
- link-local targets
- metadata-style targets
- `.local` hostnames

Those checks happen:

- before navigation
- after redirects settle
- on routed in-page subrequests

That is decent SSRF protection. It is not full browsing isolation.

## Quick Smoke Test

With core and runner both up, ask Panda:

```text
Open https://example.com in the browser, tell me the page title, take a labeled screenshot, then close the browser session.
```

That proves:

- core can reach the browser-runner
- auth between them is correct
- Chromium can reach the internet
- screenshots land in Panda media storage
- thread-scoped browser state works

## Troubleshooting

If browser calls fail immediately:

- check `BROWSER_RUNNER_URL`
- check `BROWSER_RUNNER_SHARED_SECRET`
- hit `[health](http://127.0.0.1:8080/health)` on the runner container or service

If the first browser call is slow:

- Chromium is cold-starting
- that is normal

If browser state is not surviving restarts:

- make sure `BROWSER_RUNNER_DATA_DIR` is mounted to durable storage

If Chromium dies on heavier pages:

- make sure the runner is using `--ipc=host`
- make sure the seccomp profile path points at `assets/playwright-seccomp-profile.json`
