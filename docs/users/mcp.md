# MCP servers

Panda can discover and call tools on agent-scoped MCP servers over `stdio`, Streamable HTTP, or legacy SSE.

## Authority and access

- The only production registry is the agent row in Postgres table `runtime.agent_mcp_configs`. An absent row means no servers.
- Configure servers in **Control → Agents → _agent_ → MCP**. Saved URLs, commands, arguments, working directories, literals, and credential reference names are visible to authorized Control users. Resolved credential values are never returned.
- `mcp.tools` and `mcp.call` are visible only when the execution scope grants the `mcp` tool group. Panda does not hide tools based on destructive/write annotations.
- Primary-agent fallback scopes can use all credentials owned by that agent. A subagent must have an explicit credential allowlist. Missing policy denies all credential-backed MCP operations.

Store bearer tokens and secret header/environment values under the agent's **Credentials** tab first. In MCP forms, refer to them by `credentialEnvKey`; do not paste a secret into a literal field.

## Commands

```bash
panda mcp tools <server>
panda mcp call <server> <tool> --input '{"key":"value"}'
```

Both commands accept `--timeout-ms` from 1000 through 120000. The registry default is 30000 ms. `mcp.tools` exhausts pagination before returning. `mcp.call` returns the complete MCP result envelope, including non-text content, `structuredContent`, `_meta`, and `isError`. A tool-level `isError: true` remains a successful command response with `output.exitCode: 4`; transport/protocol failures and deadlines are command failures.

## Local three-transport runbook

The checked-in fixture supports all three transports.

### stdio

Create a server named `fixture-stdio`:

```json
{
  "transport": "stdio",
  "enabled": true,
  "command": "node",
  "args": ["examples/mcp/fixture-server.mjs", "--transport", "stdio"],
  "timeoutMs": 30000
}
```

### Streamable HTTP and SSE

Start the fixture and copy the printed endpoints:

```bash
node examples/mcp/fixture-server.mjs --transport http --port 3010
```

Create `fixture-http` with transport `streamable-http` and URL `http://127.0.0.1:3010/mcp`. Create `fixture-sse` with transport `sse` and URL `http://127.0.0.1:3010/sse`. Panda never falls back from one transport to another.

Then run `panda mcp tools` and `panda mcp call ... echo` against each server. In the production app image the fixture is at `/app/examples/mcp/fixture-server.mjs`.

## Security and limits

Panda rejects HTTP redirects and any SDK follow-up that changes origin. Private, local, and Metabase endpoints are allowed when an authenticated Control operator configured them. Model/tool input cannot choose an arbitrary endpoint.

One absolute deadline covers connect, initialization, pagination/call, and cleanup. There are no tool-call retries. Current hard caps are:

- 100 configured servers per agent
- 100 pages and 10,000 tools per listing
- 64 KiB captured stdio stderr
- 8 MiB HTTP response stream
- 8 MiB stdio JSON-RPC line before parsing
- 8 MiB normalized command output

Limit failures return no partial result. Diagnostics never include remote response bodies, session IDs, request headers, or tool input.

Panda recursively redacts exact raw resolved credential values, longest first, including split stdio stderr chunks. This guarantee does **not** cover transformed, encoded, hashed, truncated, or otherwise derived forms of a secret. Do not treat redaction as permission for an MCP server to echo credentials.

## Microsoft Learn manual smoke

`https://learn.microsoft.com/api/mcp` is a public no-secret endpoint suitable for a manual Streamable HTTP smoke. Add it as a temporary no-auth server, list tools, optionally make a harmless documentation lookup, and delete/disable it afterward. It is intentionally not a CI dependency.
