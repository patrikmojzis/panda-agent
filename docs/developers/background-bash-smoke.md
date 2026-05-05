# Background Jobs Smoke Recipe

This is a manual developer smoke test. It is not CI.

Start with [Live Smoke](./live-smoke.md) if you just need a headless real-runtime check. Use this recipe when you specifically need to watch interactive background job behavior over multiple turns.

## Goal

Verify that background bash:

- starts more than one job at once
- stays isolated from shared cwd and env
- surfaces running jobs in context while they are active
- can auto-wake Panda with a queued background event on completion
- works in both status/wait/cancel flows
- becomes `lost` after a Panda restart

## Setup

If you want a quick sanity check before the interactive flow, run:

```bash
TEST_DATABASE_URL=postgresql://localhost:5432/panda_smoke \
pnpm smoke --agent panda --input "Reply with the single word ready." --expect-text "ready"
```

Then start Panda against a disposable database for the interactive background-bash checks.

Example:

```bash
pnpm dev run --db-url postgresql://localhost:5432/panda
```

In another terminal:

```bash
pnpm dev chat --db-url postgresql://localhost:5432/panda --agent panda
```

If you want remote mode, also set:

```bash
export BASH_EXECUTION_MODE=remote
export RUNNER_URL_TEMPLATE=http://127.0.0.1:8080
export RUNNER_CWD_TEMPLATE=/root/.panda/agents/{agentKey}
```

and start the runner separately.

## Smoke Flow

1. Start two background jobs.

Ask Panda to call:

- `bash` with `{"command":"sleep 5 && printf one","background":true}`
- `bash` with `{"command":"sleep 20 && printf two","background":true}`

Keep both returned `jobId` values.

2. Confirm Panda still sees the running jobs.

Ask Panda what background jobs it currently knows about.

Expected:

- Panda can name the running jobs without relying only on the earlier turn text
- the jobs appear in context while they are still running

3. Mutate foreground shell state while they run.

Ask Panda to call foreground `bash` with something like:

```json
{"command":"mkdir -p smoke-nested && cd smoke-nested && export FG_ONLY=ok && pwd && printf %s \"$FG_ONLY\""}
```

Expected:

- foreground cwd changes
- foreground env persists
- neither background job has changed that shared state

3. Wait on the short job.

Ask Panda to call:

```json
{"jobId":"<short-job-id>","timeoutMs":300000}
```

Expected:

- status becomes `completed`
- stdout contains `one`
- shared foreground cwd/env stay exactly as they were after step 2

4. Verify auto-wake on natural completion.

Start another short background job and keep chatting instead of polling.

Expected:

- Panda gets a machine-generated background event when the job finishes
- Panda can react without an explicit `background_job_status`

5. Cancel the long job.

Ask Panda to call:

```json
{"jobId":"<long-job-id>"}
```

Expected:

- status becomes `cancelled`
- shared foreground cwd/env still do not change

6. Verify reset cleanup.

Start a long background job, then reset the current session.

Expected:

- the retired thread's background job is cancelled
- Panda does not keep reacting to that old thread's job

7. Verify restart orphan handling.

Start another long background job, then kill and restart Panda before it finishes.

After restart, ask Panda to call:

```json
{"jobId":"<orphan-job-id>"}
```

Expected:

- status is `lost`
- reason explains the runtime restarted before completion

## What To Watch For

- background jobs must never update shared cwd
- background jobs must never export or unset shared env vars
- explicit `background_job_*` tools should be used instead of shell polling loops
- auto-wake should queue a durable background event through thread input, not append an assistant message mid-run
- remote mode should behave the same as local mode from Panda’s point of view
