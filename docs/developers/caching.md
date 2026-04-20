# Prompt Caching

Prompt caching is a cost and latency tool, not magic. It helps when many requests reuse a large, identical prefix. It does nothing for the parts of the prompt that keep changing.

## Core Rules

- Cache hits require a stable prefix. Tiny changes in the reusable prefix can wipe out the benefit.
- Put static content first and dynamic content last.
- Treat tools, system instructions, structured output schemas, examples, and durable transcript history as potential cached prefix material.
- Treat timestamps, relative ages, live counters, per-run state, and the triggering user input as volatile suffix material unless there is a strong reason to cache them.
- A cache write without later cache reads is just paying extra to populate a cache nobody reused.
- First-party provider behavior matters. Do not assume OpenAI-compatible or Anthropic-compatible proxies implement the same cache semantics, headers, retention, or accounting.

## Design Heuristics

The most useful mental model is:

1. `stable prefix`
2. `volatile runtime overlay`
3. `triggering input`

The stable prefix should be as deterministic as possible. Keep ordering, serialization, whitespace, and section boundaries boring and repeatable.

Good cached-prefix candidates:

- tool definitions
- stable system instructions
- durable examples
- stable profile or workspace summary
- long-lived transcript history
- structured output schemas

Bad cached-prefix candidates:

- minute-level datetime
- relative strings like "5 minutes ago"
- per-run environment snapshots
- live queue sizes or job counters
- anything derived from `Date.now()` unless bucketed very coarsely
- the incoming user message

If volatile facts are useful but not needed on every call, fetch them lazily with tools instead of preloading them into the prompt.

## Session Affinity

Some providers support explicit cache-affinity keys in addition to prefix matching. Use a stable session or prompt-cache key across requests that share a reusable prefix.

This is separate from prompt determinism:

- deterministic prompt shape helps any prefix cache
- stable session affinity helps providers that route requests based on cache keys

Do not rotate affinity keys gratuitously. A fresh key is often equivalent to starting cold.

## Anthropic Notes

Anthropic prompt caching is explicit. The cache covers the prompt prefix in `tools -> system -> messages` order up to the chosen cache breakpoint. Anthropic supports both automatic caching and explicit block-level breakpoints. Automatic caching is convenient for growing conversations. Explicit breakpoints are better when different sections change at different rates.

Important Anthropic rules:

- default retention is 5 minutes
- 1 hour retention is available, but cache writes cost more than 5 minute writes
- the lookback window is 20 content blocks per breakpoint
- up to 4 breakpoints can be used for finer control
- changes to `tool_choice`, image presence, or thinking settings can invalidate cache reuse
- a cache entry becomes available only after the first response begins, so parallel cold-start requests will not all hit immediately
- minimum cacheable length depends on model, so short prompts may silently skip caching

Use explicit breakpoints when the last block changes every request. Otherwise the system will happily keep writing fresh cache entries for a suffix that never matches.

## OpenAI Notes

OpenAI prompt caching is prefix-based and enabled automatically for sufficiently long prompts. OpenAI also supports explicit cache-affinity via `prompt_cache_key`.

Important OpenAI rules:

- caching is available for prompts of 1024 tokens or more
- static content should go first and dynamic content should go last
- tools, images, and structured output schemas can be part of the cached prefix
- `prompt_cache_key` improves routing and cache affinity for related requests
- retention can be left in-memory or extended to `24h`
- prompt cache pricing is the same for in-memory and `24h` retention on first-party OpenAI APIs
- very high fanout on one shared prefix/key can overflow a single machine and reduce hit rates

If a workload depends on OpenAI caching, keep the cache key stable and avoid splitting the same logical session across many unrelated keys.

## Periodic And Multi-Step Workloads

Cadence matters.

If a workflow wakes up less often than the effective cache lifetime, assume cold starts unless a longer retention policy exists and is economically justified.

Longer retention helps only when:

- the reusable prefix is still stable
- future requests arrive within the longer window
- the extra write cost, if any, is lower than the cold-start cost it avoids

For tool-heavy multi-step runs, cache behavior often looks like this:

- first turn pays the write cost
- later turns in the same run mostly read cached prefix
- the next run may start cold again if retention expired or the prefix changed

## Measuring Cache Effectiveness

Do not look only at total spend. Measure the shape of the spend.

Track per request:

- uncached input tokens
- output tokens
- cache read tokens
- cache write tokens
- total cost
- latency

Track per workload:

- cache hit rate
- cache write share vs cache read share
- average turns per triggering input
- average cost per triggering input, not just per model call

Warning signs:

- high cache writes and low cache reads
- many low-hit requests despite a supposedly stable prompt
- expensive periodic wakes with little or no user-visible output
- prompt prefixes that differ only by tiny runtime details

## Implementation Guidance

When adding new prompt context, ask two questions:

1. Does this belong in the stable prefix?
2. If not, should it be a volatile overlay or a tool lookup?

Default to the stable prefix only for information that is both:

- reused often
- stable enough to match exactly across requests

Everything else should be pushed later in the request or fetched on demand.

## References

- [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
