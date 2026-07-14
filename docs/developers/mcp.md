# MCP architecture and validation

MCP is split at a narrow boundary:

- `src/domain/mcp` owns strict config types, the Postgres registry, credential-policy checks, and command output semantics.
- `src/integrations/mcp` owns the public MCP SDK lifecycle, process/network transports, deadline, caps, session cleanup, and exact raw redaction.
- `src/domain/control/mcp-service.ts` is the narrow authenticated Control surface. Do not add MCP mutations to `ControlOperatorService`.
- `examples/mcp/fixture-server.mjs` is the checked-in stdio/Streamable HTTP/SSE fixture and is copied into the app image.

The runtime does not read filesystem or environment-based MCP config. `PostgresMcpConfigStore` locks the owning agent row and current registry row in one transaction before every mutation, preventing concurrent read-modify-write loss. Persisted JSON is parsed strictly on reads; unknown or malformed fields fail closed.

Credential grants travel in the signed command lease and `CommandScope`. Commands validate every referenced key before any resolution, process spawn, or fetch. Initial and refreshed disposable-environment leases preserve the same policy. Primary fallback is `all_agent`; absent policy is deny-all for MCP.

The custom stdio adapter uses the SDK's public `Transport` interface and exported JSON-RPC serializer/parser so it can count each line before parsing. HTTP transports use one injected fetch wrapper for the configured origin, manual redirects, streaming body accounting, and SDK-owned session/protocol header propagation. Streamable HTTP attempts `terminateSession()` for at most two seconds within the absolute deadline; SSE closes its stream. Calls are never retried.

## Fresh checks

```bash
pnpm vitest run tests/mcp-postgres.test.ts tests/mcp-commands.test.ts tests/mcp-transports.test.ts
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
