# Browser

Panda ships with a built-in `browser` tool.

It drives real headless Chromium through Dockerized Playwright Server. Use it when `web_fetch` is too dumb for the job.

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

The browser is stateful inside a normal thread. Panda keeps one session alive, reuses it across calls, and restores stored auth state when that thread opens a fresh browser session later.

## Requirements

You need:

- Docker installed on the machine running Panda
- a working Docker daemon
- permission for the Panda process to run `docker`
- enough RAM for Chromium to not suck

You do not need to start Playwright manually.

Panda starts the browser container lazily on the first real browser action.

## Sessions And Persistence

- one browser session per Panda thread
- one active page in that session
- popups/new tabs switch to the newest page automatically
- idle sessions expire after 10 minutes by default
- hard max session age is 60 minutes by default
- `browser close` kills the session immediately

Thread-scoped sessions also persist Playwright storage state under the browser artifact directory.

That means cookies and local storage usually survive:

- `browser close`
- idle expiry
- max-age recycling
- runtime restarts that reuse the same Panda data directory

If Panda has no `threadId`, the browser falls back to an ephemeral one-call session with no persistence.

## Snapshot UX

These actions already return a fresh page snapshot:

- `navigate`
- `click`
- `type`
- `press`
- `select`
- `wait`
- `snapshot`

They accept `snapshotMode`:

- `compact`: default, good for normal driving
- `full`: longer visible-text dump when the compact view is not enough

Snapshots now include:

- page title
- URL
- page signals like `dialog`, `login`, `validation_error`, `captcha`
- a `Changes:` summary after state-changing actions
- richer interactive element state like values, checked/selected state, invalid, required, readonly, and href

## Untrusted Browser Content

Browser-derived page text is wrapped like this:

```text
<<<EXTERNAL_UNTRUSTED_CONTENT source="browser" kind="snapshot">>>
...
<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>
```

That is deliberate.

Web pages are untrusted input. Panda should read them, not obey them.

## Screenshots And PDFs

Screenshots and PDFs are saved under Panda's media storage.

Typical paths:

- `~/.panda/media/browser/<thread-id>/...`
- `~/.panda/agents/<agentKey>/media/browser/<thread-id>/...`

If `PANDA_DATA_DIR` is set, the same structure lives there instead.

`screenshot` returns an image payload immediately.

Whole-page screenshots also support `labels: true`, which overlays the current `e1`, `e2`, ... refs onto the page before capture. That is useful when you want visual proof plus a text snapshot that lines up with the same refs.

`labels: true` is page-only. It does not work for element screenshots.

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

Start Panda:

```bash
panda run
```

Then ask for something blunt:

```text
Open https://example.com in the browser, tell me the page title, take a labeled screenshot, then close the browser session.
```

That proves:

- Docker works
- the Playwright image starts
- Chromium can reach the internet
- screenshots land in media storage
- the labeled screenshot flow works

## Troubleshooting

If browser startup fails:

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
