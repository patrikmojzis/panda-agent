# Discord Voice Follow-ups

- [ ] Add automatic Codex OAuth refresh after the ChatGPT backend call path is
  stable in Panda.
  - Reload `CODEX_HOME/auth.json` immediately before refreshing so another
    Codex process can win the refresh race safely.
  - Refresh through `https://auth.openai.com/oauth/token`, preserve the expected
    ChatGPT account, persist rotated tokens atomically, and retry one rejected
    call exactly once.
  - Serialize refreshes within the worker and guard against cross-process token
    rotation. Never log tokens or upstream refresh bodies.
  - This follow-up requires a deliberately writable auth store; the initial
    backend-route change keeps the Codex mount read-only and fails expired auth
    as `auth_unavailable`.
  - Provider recovery already reloads the read-only file before each new call;
    it does not mutate or refresh credentials.
