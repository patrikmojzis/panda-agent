import {describe, expect, it, vi} from "vitest";

import {createMcpOAuthFetch, discoverMcpOAuth, McpOAuthOriginError} from "../src/integrations/mcp/oauth.js";

const oauthAuth = {
  type: "oauth" as const,
  registration: {mode: "dynamic" as const},
  scope: {mode: "explicit" as const, values: ["resource:read"]},
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status, headers: {"content-type": "application/json"}});
}

describe("MCP OAuth HTTP boundary", () => {
  it("blocks an untrusted origin before external fetch", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const policyFetch = createMcpOAuthFetch({serverUrl: "https://mcp.example.com/mcp", fetchFn});

    await expect(policyFetch("https://login.example.com/token")).rejects.toBeInstanceOf(McpOAuthOriginError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("allows exact trusted origins, preserves JSON errors, and rejects redirects", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({error: "invalid_grant"}, 400))
      .mockResolvedValueOnce(new Response(null, {status: 302, headers: {location: "https://elsewhere.example/token"}}));
    const policyFetch = createMcpOAuthFetch({
      serverUrl: "https://mcp.example.com/mcp",
      trustedOrigins: ["https://login.example.com"],
      fetchFn,
    });

    const errorResponse = await policyFetch("https://login.example.com/token");
    expect(errorResponse.status).toBe(400);
    await expect(errorResponse.json()).resolves.toEqual({error: "invalid_grant"});
    await expect(policyFetch("https://login.example.com/authorize")).rejects.toThrow("redirects are not allowed");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("reports a cross-origin issuer without fetching it", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({
      resource: "https://mcp.example.com/mcp",
      authorization_servers: ["https://login.example.com"],
      scopes_supported: ["resource:read"],
    }));

    const result = await discoverMcpOAuth({
      serverUrl: "https://mcp.example.com/mcp",
      auth: oauthAuth,
      fetchFn,
    });

    expect(result).toMatchObject({
      authorizationServer: "https://login.example.com",
      supportedScopes: ["resource:read"],
      blockedOrigins: ["https://login.example.com"],
      registrationEndpointAvailable: false,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("discovers capabilities only across an approved exact origin", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "https://mcp.example.com") {
        return json({
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://login.example.com"],
          scopes_supported: ["resource:read"],
        });
      }
      return json({
        issuer: "https://login.example.com",
        authorization_endpoint: "https://login.example.com/authorize",
        token_endpoint: "https://login.example.com/token",
        registration_endpoint: "https://login.example.com/register",
        revocation_endpoint: "https://revoke.example.com/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      });
    });

    const result = await discoverMcpOAuth({
      serverUrl: "https://mcp.example.com/mcp",
      auth: {...oauthAuth, trustedOrigins: ["https://login.example.com"]},
      fetchFn,
    });

    expect(result).toMatchObject({
      registrationEndpointAvailable: true,
      tokenEndpointAuthMethods: ["none", "client_secret_basic"],
      blockedOrigins: ["https://revoke.example.com"],
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
