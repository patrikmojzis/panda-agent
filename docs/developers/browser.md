# Browser

This is the Chromium lane for Panda.

The design is opinionated on purpose:

- one compact `browser` tool
- stateful per thread
- official Playwright Docker image
- no host browser install
- no sub-tool explosion

## File Map

The core files are:

- `src/personas/panda/tools/browser-tool.ts`
- `src/personas/panda/tools/browser-service.ts`
- `src/personas/panda/tools/browser-snapshot.ts`
- `src/personas/panda/tools/browser-types.ts`
- `src/personas/panda/tools/safe-web-target.ts`
- `assets/playwright-seccomp-profile.json`

Split of responsibility:

- `browser-tool.ts`: schema, public tool surface, short formatting
- `browser-service.ts`: Docker lifecycle, Playwright connection, session reuse, cleanup, artifacts
- `browser-snapshot.ts`: snapshot script, ref generation, snapshot rendering
- `safe-web-target.ts`: shared SSRF/private-network guard used by both browser and `web_fetch`

## Runtime Shape

The browser service is created in runtime bootstrap and started immediately.

Today that means Docker is a runtime dependency, not an optional extra.

That is a little rude, but it is the current truth.

Relevant wiring:

- `src/app/runtime/runtime-bootstrap.ts`
- `src/app/runtime/thread-definition.ts`
- `src/personas/panda/definition.ts`

The tool order is:

- `bash`
- `view_media`
- `web_fetch`
- `browser`
- OpenAI-backed extras when configured
- Brave search when configured

`browser` stays excluded from the `explore` subagent allowlist in v1.

## Session Model

- scope by `threadId` when present
- otherwise fall back to ephemeral per-call sessions
- one active page per session
- popups switch to the newest page automatically
- idle TTL: 10 minutes by default
- max session age: 60 minutes by default
- `close()` kills the session container immediately

Lifecycle protection:

- startup orphan sweep removes stale labeled containers
- failed bootstrap removes the just-started container
- runtime shutdown closes all sessions and removes their containers
- idle/max-age expiry is enforced both by the reaper and on access

## Docker Contract

We use the official Playwright image and derive the tag from the installed `playwright-core` version:

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

Inside the container we run:

```bash
npx -y playwright@X run-server --port 3000 --host 0.0.0.0
```

The host talks to that server over the mapped loopback websocket endpoint.

## Safety Model

Browser v1 reuses the shared guarded-target checks from `web_fetch`.

It blocks:

- non-HTTP(S)
- embedded credentials
- loopback/private/link-local/metadata-ish targets
- `.local` hosts

Checks happen in three places:

- before initial navigation
- after navigation settles, on the final URL
- in a Playwright route handler for page subrequests

The route guard intentionally re-checks DNS every time. We do not cache allow decisions forever because stale safety decisions are how you end up browsing somewhere stupid later.

This is SSRF protection, not full browsing isolation. We still do not solve prompt injection, broad egress policy, or subagent scoping here.

## Output Shape

State-changing actions return a fresh compact snapshot:

- `navigate`
- `click`
- `type`
- `press`
- `select`
- `wait`

Snapshot output includes:

- page title
- page URL
- visible text
- interactive elements with stable `e1`, `e2`, ... refs

`snapshot` is just the explicit version of that.

Other actions:

- `evaluate`: caller-supplied page JS, JSON-serializable result preferred, capped to 20k chars
- `screenshot`: image payload plus saved `.png` path
- `pdf`: saved `.pdf` path
- `close`: closes the persistent thread session

One boring but important detail:

The tool schema is a flat top-level object, not a discriminated union that emits top-level `oneOf`.
That is deliberate. Some tool consumers get weird about `oneOf`, and we already hit that wall.

## Artifacts

Artifacts land under Panda media storage in a browser subtree:

- `~/.panda/media/browser/<thread-or-ephemeral>/...`
- agent-scoped equivalent when `agentKey` exists

The service reuses Panda's normal media-dir logic instead of inventing a parallel artifact system.

## Testing

Fast checks:

- `pnpm typecheck`
- `pnpm exec vitest run tests/browser-tool.test.ts`

Relevant coverage includes:

- Docker command construction
- session reuse and isolation
- startup orphan cleanup
- startup-failure cleanup
- SSRF blocking on navigation, redirects, and subrequests
- popup page switching
- snapshot refs
- screenshot/pdf artifacts
- close behavior

Real smoke matters here.

Use an actual Panda run or a small direct tool smoke against a public page. Browser code without a live check is how you get fake confidence and a broken Docker story.

## Next Work

If you extend this, the next sane steps are:

- move browser access behind explicit subagent isolation
- add tighter outbound network policy
- make browser startup optional instead of a runtime hard dependency
- add a dedicated smoke command so operators are not hand-rolling sanity checks

Do not turn this into fifteen tiny browser tools. That path sucks.
