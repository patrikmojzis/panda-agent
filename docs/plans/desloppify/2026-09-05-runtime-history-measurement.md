# Runtime-history read investigation

## 1. Decision

Retain the current read implementation for now. Selectively loading raw errors
would add ranking and eligibility policy while still loading and processing every
run's metadata. The production measurement does not establish enough benefit for
that complexity. This does not resolve full-history processing or prove that the
endpoint is fast (Panda maintainers, 2026a; production observation, 2026).

## 2. Method and deployment boundary

Read-only inspection on 5 September 2026 found the `panda-mini` checkout at
`2a483743e8cdbeb6638382473598d270eff69d8b`, with no tracked changes. The running
core container exposed no OCI revision label, so checkout identity is not proof
of its image's source revision. The Homebrew client reports PostgreSQL 18.6.

The existing debug read-only connection was used through the host client, with
`default_transaction_read_only=on`, explicit `BEGIN READ ONLY`, a four-second
statement timeout and a 750 ms lock timeout. Transactions ended with `ROLLBACK`.
Only schema metadata, anonymous counts and byte lengths were returned. No error
text, transcript content, identifiers or connection settings were retained.
No application commands, migrations, deployment or restarts were run.

The aggregate observation was taken at **09:35:09 +02:00**. Session grouping joined
runs through threads to their owning sessions, including retained threads after
reset. First-page estimates used the existing `started_at DESC, id ASC` ordering
and a page size of 25. These are inventory measurements, not endpoint timings.

## 3. Findings

| Measurement | Observed value |
| --- | ---: |
| Sessions with runs | 3,304 |
| Runs across those sessions | 31,367 |
| Failed runs | 1,388 |
| Largest session | 8,231 runs |
| 95th percentile session size | 3 runs |
| Sessions exceeding 25 runs | 15 |
| Raw error bytes across all sessions | 239,393 |
| Largest raw error | 947 bytes |
| Largest per-session raw error total | 53,241 bytes |
| Raw error bytes outside each session's first 25 runs | 174,272 |
| Metadata JSON bytes across all runs | 3,928,386 |

Metadata size is the byte length of a JSON array containing the five selected
non-error columns; it is a comparison proxy, not measured PostgreSQL wire traffic
or JavaScript heap usage. Raw errors account for about 5.7% of the combined proxy
and error bytes. The largest session contains 48,099 error bytes, of which 47,201
lie outside its first page. No non-finite or outside-year-1–9999 start timestamp
was found. These live values may change (production observation, 2026).

## 4. Constraints on a future change

The current service performs authorization followed by one scoped history query;
this is not an N+1 query path. It then normalizes every row, filters, sorts, pages
and computes an unfiltered summary. A selective-error query would retain O(N)
metadata transfer and processing (Panda maintainers, 2026a).

Any replacement must address validation order, PostgreSQL microsecond ties after
JavaScript date conversion, locale-aware text sorting, descending null-first
ordering, high-page clamping, ordered floating-point duration averages and ISO
string summary maxima. Stored summaries are not automatically interchangeable:
migration 0025 **does backfill**, but deliberately freezes its sanitizer while
the live sanitizer can evolve (Panda maintainers, 2026b; 2026c).

Independent recon also reproduced a caller changing the mutable `input.page`
while the query awaited completion. The current exposed service uses the new
page and returns its full errors. Selecting error payloads before that await
would change this behavior. The HTTP adapter creates an unshared input object,
but that alone does not redefine the exported service contract.

Before implementing a larger history-read change, measure endpoint latency,
JavaScript processing and allocations on representative histories, then compare
query plans and public results on isolated PostgreSQL. Include error-light and
error-heavy cases. Do not implement ranking merely to reduce an unmeasured
transfer cost.

## 5. References

- Panda maintainers (2026a) *Control runtime activity service*. Available at:
  [runtime-activity-service.ts](../../../src/domain/control/runtime-activity-service.ts)
  (inspected at `405d5bc8`, 5 September 2026).
- Panda maintainers (2026b) *Runtime error summary migration*. Available at:
  [0025-runtime-error-summary.ts](../../../src/app/database/migrations/0025-runtime-error-summary.ts)
  (accessed: 5 September 2026).
- Panda maintainers (2026c) *Live runtime error sanitizer*. Available at:
  [runtime-error-summary.ts](../../../src/lib/runtime-error-summary.ts)
  (accessed: 5 September 2026).
- Production observation (2026) *Anonymous runtime-history aggregates on
  panda-mini*. Read-only inspection, 5 September, 09:35 +02:00. Values and
  methodology are recorded in sections 2–3; no production payloads retained.
