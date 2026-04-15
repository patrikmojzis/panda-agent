# Browser

This is Panda's heavyweight web lane.

The design is still opinionated on purpose:

- one compact `browser` tool
- stateful per thread
- official Playwright Docker image
- no host browser install
- no tool explosion

## File Map

Core files:

- `src/personas/panda/tools/browser-tool.ts`
- `src/personas/panda/tools/browser-service.ts`
- `src/personas/panda/tools/browser-snapshot.ts`
- `src/personas/panda/tools/browser-output.ts`
- `src/personas/panda/tools/browser-types.ts`
- `src/personas/panda/tools/safe-web-target.ts`
- `assets/playwright-seccomp-profile.json`

Split of responsibility:

- `browser-tool.ts`: schema, public tool surface, short formatting
- `browser-service.ts`: Docker lifecycle, Playwright connection, session reuse, auth-state persistence, cleanup, artifacts
- `browser-snapshot.ts`: page snapshot script, ref generation, rendering, change-summary text
- `browser-output.ts`: tiny wrapper for untrusted browser-derived content
- `safe-web-target.ts`: shared SSRF/private-network guard reused by `browser` and `web_fetch`

## Runtime Shape

The browser service is created in runtime bootstrap, but Docker startup is lazy.

That means:

- Panda can boot without immediately touching Docker
- the first real browser action starts the container
- Docker is still required if you actually use the tool

Relevant wiring:

- `src/app/runtime/runtime-bootstrap.ts`
- `src/app/runtime/thread-definition.ts`
- `src/personas/panda/definition.ts`

Tool order:

- `bash`
- `view_media`
- `web_fetch`
- `browser`
- OpenAI-backed extras when configured
- Brave search when configured

`browser` still stays out of the `explore` subagent allowlist.

## Session Model

- scope by `threadId` when present
- otherwise fall back to ephemeral per-call sessions
- one active page per session
- popups switch to the newest page automatically
- idle TTL: 10 minutes by default
- max session age: 60 minutes by default
- `close()` kills the session container immediately

Thread-scoped sessions now persist Playwright storage state in the browser artifact directory. That gives us boring, useful auth persistence across:

- `close()`
- idle expiry
- max-age recycle
- process restarts that reuse the same data dir

The implementation is intentionally small: Playwright `storageState` restore on context creation, then best-effort save on action completion and close.

## Safety Model

The browser reuses the shared guarded-target checks from `web_fetch`.

It blocks:

- non-HTTP(S)
- embedded credentials
- loopback/private/link-local/metadata-ish targets
- `.local` hosts

Checks happen:

- before initial navigation
- after navigation settles, on the final URL
- in a Playwright route handler for page subrequests

That is SSRF protection, not full browsing isolation.

## Output Shape

Snapshot-returning actions:

- `navigate`
- `snapshot`
- `click`
- `type`
- `press`
- `select`
- `wait`

They accept `snapshotMode: "compact" | "full"` and return:

- title
- URL
- signals
- `Changes:` summary after state-changing actions
- visible dialog/page text
- interactive elements with stable `e1`, `e2`, ... refs
- richer state like `value`, `checked`, `selected`, `required`, `invalid`, `readonly`, `href`

Browser-derived text is wrapped in:

```text
<<<EXTERNAL_UNTRUSTED_CONTENT source="browser" kind="snapshot">>>
...
<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>
```

`evaluate` uses the same wrapping when it returns content. If the script yields nothing, the tool answers with the explicit `return` hint instead of fake `null` sludge.

`screenshot(labels=true)` is page-only. It injects temporary ref overlays that line up with the current snapshot refs, captures the image, then cleans the overlays up.

## Docker Contract

We derive the container image tag from the installed `playwright-core` version:

- host dependency: `playwright-core@X`
- image: `mcr.microsoft.com/playwright:vX-noble`

Container launch uses:

- `--init`
- `--ipc=host`
- `--workdir /home/pwuser`
- `--user pwuser`
- `--security-opt seccomp=assets/playwright-seccomp-profile.json`
- loopback-only port publish `127.0.0.1::3000`
- labels for browser ownership, thread id, and start time

Inside the container:

```bash
npx -y playwright@X run-server --port 3000 --host 0.0.0.0
```

## Artifacts

Artifacts land under Panda media storage in a browser subtree:

- `~/.panda/media/browser/<thread-or-ephemeral>/...`
- agent-scoped equivalent when `agentKey` exists

The same subtree also holds the thread-scoped `storage-state.json` file used for browser auth persistence.

## Testing

Fast checks:

- `pnpm typecheck`
- `pnpm exec vitest run tests/browser-tool.test.ts`

Useful coverage now includes:

- Docker command construction
- session reuse and isolation
- startup cleanup
- SSRF blocking on navigation, redirects, and subrequests
- richer snapshot rendering
- post-action change summaries
- labeled screenshots
- evaluate no-value hint
- storage-state persistence across close/reopen

Still do a live smoke. Browser code without a real run is fake confidence with better branding.

## Next Work

The next sane steps are:

- isolate browser access behind a less-trusted subagent lane
- tighten outbound network policy beyond SSRF checks
- optionally persist more than Playwright storage state if a real auth case needs it
- add a dedicated browser smoke command

Do not turn this into fifteen tiny browser tools. That still sucks.
