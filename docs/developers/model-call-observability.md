# Model-Call Observability

Model-call observability is a best-effort flight recorder. It must never delay,
fail, or change a model run.

## Runtime Contract

`Thread` emits one synchronous observation after every provider attempt. The
observer may copy small scalar metadata into a bounded in-memory queue, but it
must not serialize a request, query Postgres, or return a promise. A background
recorder sanitizes snapshots and writes batches through a dedicated one-client
Postgres pool. Snapshot preparation and database persistence are separate
background stages: a slow write may queue only byte-capped records, never raw
provider requests.

The provider request retains the complete context only in its system prompt.
Trace metadata carries bounded section descriptors, never another `content`,
`dump`, aggregate context string, or raw context cache-key fragment. Descriptor
count and previews are capped. Snapshot sanitization bounds traversal depth,
nodes, collection entries, and string characters before serialization.

When the queue is under pressure, the recorder drops a snapshot first and keeps
its small attempt row when possible. If the metadata queue is also full, it
drops the attempt. Both outcomes are preferable to slowing the agent.

## Persistence Model

`runtime.model_call_attempts` contains the searchable record:

- attribution, provider, model, mode, status, and actual retry ordinal
- timing, normalized usage and cost, and a bounded error summary
- request-shape counters and snapshot capture status

`runtime.model_call_snapshots` is an optional one-to-one forensic payload. The
default policy captures failures and no successful calls. Successful sampling
is explicit. Every snapshot is sanitized, byte-capped, independently expired,
and stores the provider-bound system prompt only once; context sections retain
descriptors rather than another full prompt copy.

The Control list reads only attempt columns, the usage endpoint aggregates into
at most 1,000 buckets in Postgres, and the detail endpoint is the only path that
joins a snapshot. This keeps ordinary browsing independent of prompt size. The
capture status is historical; detail responses separately report whether the
short-lived snapshot is still available.

The old `runtime.model_call_traces` table is deliberately dropped. These rows
are short-lived diagnostics, so migrating legacy payloads would preserve the
worst storage shape for no durable product value.

## Configuration

- `PANDA_CORE_MODEL_CALL_DB_POOL_MAX`: recorder pool maximum; default `1`
- `PANDA_MODEL_CALL_ATTEMPT_RETENTION_DAYS`: metadata retention; default `90`
- `PANDA_MODEL_CALL_SNAPSHOT_RETENTION_DAYS`: payload retention; default `7`
- `PANDA_MODEL_CALL_SNAPSHOT_MAX_BYTES`: maximum sanitized snapshot bytes;
  default `1048576`
- `PANDA_MODEL_CALL_SUCCESS_SNAPSHOT_SAMPLE_RATE`: successful-call capture
  probability from `0` to `1`; default `0`

Snapshot retention cannot exceed attempt retention. Invalid values fail startup
instead of silently changing the capture or storage budget.

## Shutdown And Failure Policy

Shutdown stops new observations, drains within a bounded deadline, drops any
remaining telemetry, and only then closes the recorder pool. During normal
operation, write and maintenance failures are counted and rate-limited in logs;
they are never retried on the request path. Expiry cleanup runs periodically in
bounded batches and schedules catch-up passes when a backlog remains. It never
runs once per model call.
