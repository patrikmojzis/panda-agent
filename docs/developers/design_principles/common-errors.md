# Common Errors

## Oversized OpenAI Codex Prompt Cache Key

Error:

```text
Provider runtime failed; provider=openai-codex; model=gpt-5.5; stopReason=error; failureKind=provider_error; detail=Invalid 'prompt_cache_key': string too long. Expected a string with maximum length 64
```

OpenAI Codex rejected an oversized cache key. Check
`src/domain/threads/runtime/prompt-cache-key.ts` before provider adapters; final
keys must stay at or below 64 chars while preserving cache-affinity changes.
