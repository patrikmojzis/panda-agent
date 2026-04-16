# Live Smoke

This is the real headless E2E path for Panda changes.

It is opt-in, local-first, and not part of the default fast test suite.

## What It Does

`panda smoke` starts a temporary Panda daemon in-process, bootstraps the requested agent and identity, sends one or more inputs through the real runtime, waits for the thread to go idle, and writes postmortem artifacts.

It does not drive the TUI. Good. The TUI is for humans.

It can also reopen an existing persisted session when you want to keep poking the exact same conversation instead of starting fresh.

## Required Setup

- `TEST_DATABASE_URL`
- provider auth envs for whatever model you run

Optional:

- `TEST_MODEL`

`TEST_DATABASE_URL` is the disposable live-test database. `panda smoke` uses `--db-url` first, then `TEST_DATABASE_URL`. It does not fall back to `PANDA_DATABASE_URL`.

## Safety Model

By default, each smoke run recreates the target database before starting.

That reset is refused unless the database name looks disposable, meaning it contains one of:

- `test`
- `smoke`
- `tmp`

If you insist on something riskier, pass `--allow-unsafe-db-reset`. That flag is a loaded gun. Use it like one.

## Common Commands

Basic headless smoke:

```bash
TEST_DATABASE_URL=postgresql://localhost:5432/panda_smoke \
pnpm smoke --agent panda --input "say hi" --expect-text "hi"
```

Tool-focused smoke:

```bash
TEST_DATABASE_URL=postgresql://localhost:5432/panda_smoke \
pnpm smoke --agent panda --input "open example.com" --expect-tool browser
```

Reuse the existing DB state instead of recreating it:

```bash
pnpm smoke --agent panda --input "summarize the current thread" --reuse-db
```

Target an existing session directly:

```bash
pnpm smoke --session session_123 --reuse-db --input "what went wrong?" --interactive
```

Drop into a follow-up REPL on the same persisted smoke session:

```bash
TEST_DATABASE_URL=postgresql://localhost:5432/panda_smoke \
pnpm smoke --agent panda --input "Reply with the single word banana." --expect-text "kiwi" --interactive
```

That is especially useful after a failure. You can immediately ask Panda what happened without manually starting the TUI or reconstructing state.

Run the opt-in live Vitest pack:

```bash
pnpm test:live
```

Watch live tests while iterating:

```bash
pnpm test:live:watch
```

## Useful Flags

- `--input <text>` repeatable, ordered inputs
- `--agent <agentKey>` start or reopen the agent's main session
- `--session <sessionId>` target an existing persisted session directly
- `--expect-text <text>` repeatable substring checks
- `--expect-tool <toolName>` repeatable tool checks
- `--forbid-tool-error` fail if any persisted tool result is marked as an error
- `--timeout-ms <ms>` default `120000`
- `--reuse-db` skip the destructive reset
- `--interactive` open a follow-up REPL on the same persisted smoke session
- `--artifacts-dir <path>` write artifacts somewhere explicit
- `--json` dump the full result object

Rules:

- pass either `--agent` or `--session`
- `--session` requires `--reuse-db`
- `--session` does not accept `--model` because the session already exists and should stay itself

## Artifacts

Default artifact root:

```text
.temp/panda-smoke/<timestamp>-<agentKey>/
```

Each run writes:

- `summary.json`
- `transcript.json`
- `runs.json`
- `tool-artifacts.json`

On failure, start with `summary.json`. It includes the failure stage, message, thread/session ids, and the artifact paths. You usually do not need to poke Postgres first.

## Writing Live Tests

Live tests live under `tests/live/**/*.live.test.ts` and only run through `pnpm test:live`.

Keep them blunt and structural:

- assert key substrings, not exact prose
- assert tool names when behavior matters
- prefer one or two clear inputs over giant scripts
- let the artifact dump do the forensic work when something flakes

There is a shared helper in [tests/helpers/live-smoke.ts](/Users/patrikmojzis/Projects/panda-agent/tests/helpers/live-smoke.ts) so the CLI path and the Vitest path hit the same harness.
