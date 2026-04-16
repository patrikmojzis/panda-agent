# Browser

This is Panda's heavyweight web lane.

The important architectural call now is simple:

- `panda-core` does not own Docker or Chromium anymore
- `browser-runner` is the isolated browser process boundary
- the browser tool in core is an HTTP client

That keeps provider creds, DB creds, and connector secrets out of the browser container.

## File Map

Core-side files:

- `src/panda/tools/browser-tool.ts`
- `src/panda/tools/browser-schema.ts`
- `src/integrations/browser/client.ts`
- `src/integrations/browser/protocol.ts`

Runner-side files:

- `src/integrations/browser/runner.ts`
- `src/integrations/browser/session-service.ts`

Shared browser logic still lives in:

- `src/panda/tools/browser-snapshot.ts`
- `src/panda/tools/browser-output.ts`
- `src/panda/tools/browser-types.ts`
- `src/panda/tools/safe-web-target.ts`

## Responsibility Split

- `browser-tool.ts`: public tool surface, formatting, redaction
- `browser-schema.ts`: shared action validation used by both tool and runner
- `client.ts`: authenticated HTTP client, response parsing, artifact copy into core media paths
- `runner.ts`: HTTP server, bearer-token auth, request validation, response shaping
- `session-service.ts`: Chromium launch, session reuse, storage-state persistence, SSRF checks, snapshot/evaluate/screenshot/pdf behavior

## Runtime Shape

The browser tool is still only exposed through the dedicated `browser` subagent lane.

The difference is transport:

1. browser subagent calls `browser`
2. `browser-tool` validates the action
3. `BrowserRunnerClient` sends `POST /action` to `browser-runner`
4. `BrowserSessionService` executes inside the runner
5. screenshot/PDF bytes come back over HTTP
6. core writes the final artifact into its own media storage and returns the usual tool result

The public tool schema stayed unchanged on purpose.

## Session Model

- scope by `threadId` when present
- otherwise fall back to ephemeral per-call sessions
- one active page per session
- popups switch to the newest page automatically
- idle TTL: 10 minutes by default
- max session age: 60 minutes by default
- `close()` kills the session immediately

Persistent session state lives under `BROWSER_RUNNER_DATA_DIR`, keyed by agent and thread.

Final screenshots and PDFs still live under Panda's normal core media paths.

That split matters:

- runner state is for browser continuity
- core media paths are for artifact replay, TUI display, and user-facing outputs

## Protocol

Runner endpoints:

- `GET /health`
- `POST /action`

`POST /action` requires:

- `Authorization: Bearer <BROWSER_RUNNER_SHARED_SECRET>`

Request body:

- `agentKey`
- `sessionId`
- `threadId`
- validated browser `action`

Response body is typed, not raw tool payload:

- `{ ok, text, details, artifact? }`

`artifact` is used only for screenshot/PDF outputs and contains base64 bytes plus the runner-side path.

Core rewrites the final metadata to its own artifact path before returning the tool result.

## Chromium Ownership

`BrowserSessionService` launches Chromium directly inside the runner container with Playwright.

No nested Docker.
No Playwright sidecar container.
No seccomp-profile dependency in `panda-core` itself.

That killed the old `spawn docker ENOENT` class of failure for dockerized core.

The runner deployment still needs the normal Chromium hardening:

- run as non-root `pwuser`
- use the Playwright seccomp profile from `assets/playwright-seccomp-profile.json`
- keep `--ipc=host` or an equivalent larger shared-memory setup

## Safety Model

The browser reuses the shared guarded-target checks from `web_fetch`.

It still blocks:

- non-HTTP(S)
- embedded credentials
- loopback/private/link-local/metadata-ish targets
- `.local` hosts

Checks happen:

- before initial navigation
- after navigation settles on the final URL
- in a Playwright route handler for subrequests

That is SSRF protection, not full browsing isolation.

## Docker Shape

The repo now has two image targets:

- default/final `panda:latest` for `panda-core` and bash runners
- `--target browser-runner` for the dedicated browser image

The compose example now keeps browser-runner state on a separate host path by default instead of nesting it under the core-mounted `~/.panda` tree.

The compose example in [examples/docker-compose.remote-bash.external-db.yml](../../examples/docker-compose.remote-bash.external-db.yml) is the source of truth for the current deployment shape.

## Testing

Fast checks:

- `pnpm typecheck`
- `pnpm exec vitest run tests/browser-tool.test.ts tests/browser-runner.test.ts`

Live checks worth doing before shipping:

- host core + dockerized browser-runner
- dockerized core + dockerized browser-runner + external Postgres
- combined stack with remote bash runner still alive

Browser code without a live smoke is still fake confidence, just with better branding.
