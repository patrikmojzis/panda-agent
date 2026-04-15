# Background Bash

Panda now supports first-class background bash jobs.

Use this when you want a shell command to keep running while Panda does other work.

## Mental Model

- foreground `bash` mutates the shared shell session
- background `bash` is an isolated snapshot
- background jobs never merge cwd or env back into the shared shell session
- running jobs can appear in Panda's context while they are active
- completion may show up as a runtime note, but status/wait/cancel are still the explicit control tools

That means background bash is good for long-running work, but bad for “change directory here and keep using it later.” Foreground bash still owns shared shell state.

## Start A Background Job

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

Use `bash_job_status` with the `jobId`:

```json
{
  "jobId": "..."
}
```

This returns the current job state plus the latest stdout/stderr preview.

## Wait For Completion

Use `bash_job_wait` when you want Panda to pause for a bit and see whether the job finishes:

```json
{
  "jobId": "...",
  "timeoutMs": 15000
}
```

If the job finishes, you get final metadata and output previews.
If it is still running, you get the current running snapshot back.

## Cancel A Job

Use `bash_job_cancel` to request cancellation:

```json
{
  "jobId": "..."
}
```

Panda asks the job to stop, waits briefly, and returns the final or current state.

## Auto-Wake And Context

- Panda may see active background jobs in context during later turns
- when a watcher-owned background job finishes on its own, Panda may receive a runtime note and keep going without manual polling
- `bash_job_status` and `bash_job_wait` are still the right tools when Panda needs the full latest state on demand

## What Comes Back

Background job tool results include:

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

- bash only
- same thread only
- no stdin
- no tty
- no resume or merge-back
- no `bash_job_list`
