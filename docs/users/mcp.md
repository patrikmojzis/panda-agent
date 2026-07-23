# MCP servers

Panda can discover and call tools on agent-scoped MCP servers over `stdio`, Streamable HTTP, or legacy SSE.

## Authority and access

- The only production registry is the agent row in Postgres table `runtime.agent_mcp_configs`. An absent row means no servers.
- Configure servers in **Control → Agents → _agent_ → MCP**. Saved URLs, commands, arguments, working directories, literals, and credential reference names are visible to authorized Control users. Resolved credential values are never returned.
- `mcp.tools` and `mcp.call` are visible only when the execution scope grants the `mcp` tool group. Panda does not hide tools based on destructive/write annotations.
- Primary-agent fallback scopes can use all credentials owned by that agent. A subagent must explicitly allow credential environment keys and opaque OAuth refs such as `mcp-oauth:<server-name>`. Missing policy denies all credential-backed MCP operations.

Store bearer tokens and secret header/environment values under the agent's **Credentials** tab first. In MCP forms, refer to them by `credentialEnvKey`; do not paste a secret into a literal field.

## Commands

```bash
panda mcp tools <server>
panda mcp call <server> <tool> --input '{"key":"value"}'
```

Both commands accept `--timeout-ms` from 1000 through 120000. The registry default is 30000 ms. `mcp.tools` exhausts pagination before returning. `mcp.call` returns the complete MCP result envelope, including non-text content, `structuredContent`, `_meta`, and `isError`. A tool-level `isError: true` remains a successful command response with `output.exitCode: 4`; transport/protocol failures and deadlines are command failures.

## OAuth for Streamable HTTP

OAuth uses Authorization Code with PKCE and belongs to the agent/server pair. Panda supports dynamic client registration and pre-registered clients; it does not contain provider-specific scopes or endpoints.

```json
{
  "transport": "streamable-http",
  "enabled": true,
  "url": "https://mcp.example.com/mcp",
  "auth": {
    "type": "oauth",
    "registration": {"mode": "dynamic"},
    "scope": {"mode": "explicit", "values": ["resource:read"]},
    "trustedOrigins": ["https://login.example.com"]
  },
  "timeoutMs": 30000
}
```

Use Control to save the server, run **Discover**, approve any exact cross-origin HTTPS origins, then **Connect**. For manual registration, enter the client ID, optional client secret, and token endpoint authentication method during Connect. Secrets, tokens, PKCE verifiers, and registered client information are encrypted with `CREDENTIALS_MASTER_KEY` and are never returned by Control.

`scope.mode=explicit` requires unique non-empty strings, which Panda passes through unchanged. `server-default` is a deliberate operator choice and delegates scope selection to the MCP OAuth discovery flow; it is never an automatic fallback. OAuth is rejected for stdio and legacy SSE.

Set `PANDA_CONTROL_PUBLIC_URL` to Control's canonical externally reachable URL before connecting. Panda derives the registered callback exclusively as `<public-url>/api/control/mcp/oauth/callback`. HTTPS is mandatory except for loopback development. Changing the MCP URL, OAuth registration/scope policy, or trusted origins invalidates tokens; disabling the server or changing its timeout does not.

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

Panda rejects HTTP redirects and any SDK follow-up that changes origin. Private and local endpoints are allowed when an authenticated Control operator configured them. OAuth requests can reach only the MCP origin and exact origins explicitly stored in `trustedOrigins`; discovery reports other origins without fetching them. Model/tool input cannot choose an arbitrary endpoint.

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
