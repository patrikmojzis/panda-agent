# Browser

Panda now ships with a built-in `browser` tool.

It drives a real headless Chromium session through Dockerized Playwright Server. This is the heavy lane for pages where `web_fetch` is not enough.

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

The important bit is state.

Inside a normal thread, Panda keeps one browser session alive and reuses it across calls until you close it or it expires.

## Requirements

You need:

- Docker installed on the machine running `panda run`
- a working Docker daemon
- permission for the Panda process to run `docker`
- enough RAM for Chromium to not be miserable

You do not need to start Playwright manually.

Panda starts the container on first browser use.

## Current Reality

Right now the browser service starts with the runtime, not lazily behind a feature flag.

That means:

- `panda run` expects Docker to be available
- the first real browser action may still take longer if the Playwright image needs to be pulled
- this works fine on a VPS as long as Docker works there too

No GUI is required. Headless Chromium is the point.

## How Sessions Work

- one browser session per Panda thread
- one active page in that session
- popups/new tabs switch the session to the newest page automatically
- idle sessions expire after 10 minutes by default
- hard max session age is 60 minutes by default
- `browser close` kills the session immediately

If Panda has no thread id in context, the browser falls back to an ephemeral one-call session.

## Safety Boundaries

Browser v1 is not a free-for-all.

It blocks:

- non-HTTP(S) URLs
- embedded credentials in URLs
- loopback targets
- private IP ranges
- link-local targets
- metadata-style targets
- `.local` hostnames

Those checks happen:

- before navigation
- after redirects
- on routed in-page subrequests

That is useful SSRF protection. It is not full internet safety. Prompt injection and broader network policy are still future work.

## Artifacts

Screenshots and PDFs are saved under Panda's media storage.

Typical paths:

- `~/.panda/media/browser/<thread-id>/...`
- `~/.panda/agents/<agentKey>/media/browser/<thread-id>/...`

If `PANDA_DATA_DIR` is set, the same structure lives under that root instead.

`screenshot` also returns an image payload to the UI immediately.

## Quick Smoke Test

Start Panda:

```bash
panda run
```

Open chat and ask for something blunt:

```text
Open https://example.com in the browser, tell me the page title, take a screenshot, then close the browser session.
```

That should prove:

- Docker works
- the Playwright container starts
- Chromium can reach the internet
- artifacts land in media storage

## Troubleshooting

If startup fails with a Docker error:

- run `docker info`
- make sure the Panda process can call `docker`
- make sure the daemon is actually running

If the first browser call is slow:

- the Playwright image is probably being pulled
- that is normal on first use

If you want to inspect active Panda browser containers:

```bash
docker ps --filter label=panda.browser=1
```

If you need to nuke stale ones manually:

```bash
docker ps -aq --filter label=panda.browser=1
docker rm -f <container-id>
```

Use that second command with your brain on.
