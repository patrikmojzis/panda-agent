# MCP architecture and validation

MCP is split at a narrow boundary:

- `src/domain/mcp` owns strict config types, the versioned Postgres registry, the canonical `McpManagementService`, credential-policy checks, and command output semantics.
- `src/integrations/mcp` owns the public MCP SDK lifecycle, process/network transports, deadline, caps, session cleanup, and exact raw redaction.
- `src/domain/control/mcp-service.ts` is a narrow visibility adapter over `McpManagementService`. Control and agent commands must not duplicate mutation, OAuth invalidation, credential-policy, test, or audit rules. Do not add MCP mutations to `ControlOperatorService`.
- `examples/mcp/fixture-server.mjs` is the checked-in stdio/Streamable HTTP/SSE fixture and is copied into the app image.

OAuth connections are separate from public MCP config. `runtime.agent_mcp_oauth_connections` stores a versioned `CredentialCrypto` payload keyed by agent/server; `runtime.agent_mcp_oauth_attempts` stores one hashed-state, encrypted-PKCE attempt per agent/server for ten minutes. Attempts record a `control | agent` initiator with a mandatory session and optional agent identity/thread. The runtime injects an SDK `OAuthClientProvider` only for Streamable HTTP and never opens a browser. Both Control and `operate` commands can discover/start/disconnect; the callback consumes state before exchanging the code, stores the grant, and never wakes the initiating runtime session.

The runtime does not read filesystem or environment-based MCP config. `PostgresMcpConfigStore` locks the owning agent row and current registry row in one transaction before every mutation, preventing concurrent read-modify-write loss. The registry starts at logical version `0`, persists at version `1`, and increments only for a real change. Agent mutations require `expectedVersion`; Control supports optional `If-Match` for API compatibility and the UI always sends it. Store mutation results contain the actual before/after values so invalidation and audits never depend on a stale second read. Persisted JSON is parsed strictly on reads; unknown or malformed fields fail closed.

Credential grants travel in the signed command lease and `CommandScope`. Commands validate every referenced key and opaque OAuth ref before decryption, process spawn, or fetch. Initial and refreshed disposable-environment leases preserve the same policy. Primary fallback is `all_agent`; absent policy is deny-all for MCP.

`mcp` grants only `mcp.tools` and `mcp.call`; `operate` grants `mcp.manage.*`, projected to the concrete `mcp.server.*` and `mcp.oauth.*` commands. Agent commands derive ownership from authenticated `CommandScope` and reject unknown input fields such as `agentKey`. Agent add/update rejects literal credential-capable header/environment values. `server test` may initialize a persisted disabled stdio/HTTP/SSE registration and exhaust `tools/list`, but it cannot accept an inline endpoint/command and never calls a tool. Treat `operate` plus stdio as trusted local code-execution authority.

The custom stdio adapter uses the SDK's public `Transport` interface and exported JSON-RPC serializer/parser so it can count each line before parsing. HTTP transports use one injected fetch wrapper for the configured origin, manual redirects, streaming body accounting, and SDK-owned session/protocol header propagation. Streamable HTTP attempts `terminateSession()` for at most two seconds within the absolute deadline; SSE closes its stream. Calls are never retried.

## Fresh checks

```bash
pnpm vitest run tests/mcp-postgres.test.ts tests/mcp-oauth-postgres.test.ts tests/mcp-oauth-http.test.ts tests/mcp-commands.test.ts tests/mcp-management-commands.test.ts tests/mcp-transports.test.ts
pnpm vitest run tests/mcp-oauth-flow.test.ts
pnpm vitest run tests/control-auth-http.test.ts -t "MCP servers"
pnpm typecheck
pnpm build
pnpm --dir apps/control-ui typecheck
pnpm --dir apps/control-ui build
```

With Docker available:

```bash
PANDA_MCP_B2B_DOCKER_SMOKE=1 \
  pnpm vitest run --config vitest.live.config.ts --testTimeout=600000 \
  tests/live/docker-mcp-b2b.live.test.ts
```

The Docker lane builds the production app target, runs the fixture on a private Docker network, and exercises compiled stdio, Streamable HTTP, and SSE clients. Keep `src/domain/mcp/**`, `src/integrations/mcp/**`, Control/UI, fixture, Dockerfile, and B2B test paths in the Docker workflow filter.

## Stable failure phases

Command failures expose only sanitized phases: `connect`, `http_status`,
`invalid_content`, `protocol`, `session_expired`, `authentication`, `timeout`,
or `output_limit`. Tool envelopes with `isError: true` remain successful command
output with exit code `4` and phase `tool_error`. Remote response bodies, endpoint
URLs, headers, session IDs, inputs, and credential values are not diagnostics.
