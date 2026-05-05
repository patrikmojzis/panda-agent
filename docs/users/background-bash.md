# Background Jobs

Panda supports first-class background tool jobs.

Use this when work should keep running while Panda continues the conversation.

Current background job kinds:

- `bash` when called with `background: true`
- `image_generate`
- `spawn_subagent`
- `web_research`

## Mental Model

- foreground `bash` mutates the shared shell session
- background `bash` is an isolated snapshot
- `image_generate`, `spawn_subagent`, and `web_research` always start background jobs
- background jobs never merge cwd or env back into the shared shell session
- running jobs can appear in Panda's context while they are active
- completion may arrive as a machine-generated background event, but status/wait/cancel are still the explicit control tools

That means background bash is good for long-running work, but bad for “change directory here and keep using it later.” Foreground bash still owns shared shell state.

## Start A Background Bash Job

```json
{
  "command": "npm test --watch=false",
  "background": true
}
```

The `bash` tool returns immediately with a job handle:

- `jobId`
- `status`
- `command`
- `mode`
- `initialCwd`
- `startedAt`
- `sessionStateIsolated: true`

## Check Status

Use `background_job_status` with the `jobId`:

```json
{
  "jobId": "..."
}
```

This returns the current job state plus the latest stdout/stderr preview.

## Wait For Completion

Use `background_job_wait` when you want Panda to pause for a bit and see whether the job finishes:

```json
{
  "jobId": "...",
  "timeoutMs": 300000
}
```

If the job finishes, you get final metadata and output previews.
If it is still running, you get the current running snapshot back.

## Cancel A Job

Use `background_job_cancel` to request cancellation:

```json
{
  "jobId": "..."
}
```

Panda asks the job to stop, waits briefly, and returns the final or current state.

## Auto-Wake And Context

- Panda may see active background jobs in context during later turns
- when a background job finishes on its own, Panda receives a queued background event and wakes the session
- `background_job_status` and `background_job_wait` are still the right tools when Panda needs the full latest state on demand

## What Comes Back

Background bash job results include:

- `jobId`, `status`, `command`, `mode`
- `initialCwd`, optional `finalCwd`
- `startedAt`, optional `finishedAt`, optional `durationMs`
- optional `exitCode`, optional `signal`, `timedOut`
- `stdout`, `stderr`
- `stdoutChars`, `stderrChars`
- `stdoutTruncated`, `stderrTruncated`
- `stdoutPersisted`, `stderrPersisted`
- optional `stdoutPath`, optional `stderrPath`
- `trackedEnvKeys`
- `sessionStateIsolated: true`

Panda reports tracked env key names only. It does not expose exported env values from background jobs.

Image generation jobs return generated image paths and artifact metadata without inline image data. Subagent jobs return the child role, final message, tool-call count, and duration. Web research jobs return the cited answer and source metadata.

## Isolation Rules

- the job snapshots the current cwd and env at spawn time
- foreground shell state can keep changing while the job runs
- background completion does not update shared cwd
- background completion does not export or unset shared env vars
- resetting the current session cancels the retired thread's background jobs

## Secret And Output Rules

- secret values are redacted from previews
- large stdout/stderr files are only persisted when the call is not secret-bearing

## Scope

V1 is intentionally small:

- same thread only
- bash background jobs have no stdin or tty
- no resume or merge-back
- no `background_job_list`
