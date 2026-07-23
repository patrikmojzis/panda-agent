import type {McpConfigStore} from "../../domain/mcp/store.js";
import type {McpHttpOAuthAuth, McpHttpServerConfig} from "../../domain/mcp/types.js";
import type {McpOAuthDiscoverySummary, McpOAuthManualClientInput, McpOAuthTokenEndpointAuthMethod} from "../../domain/mcp/oauth-types.js";
import type {McpOAuthService} from "../../domain/mcp/oauth-service.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {
  discoverMcpOAuth,
  finishMcpOAuthAuthorization,
  McpOAuthProviderSession,
  newMcpOAuthState,
  startMcpOAuthAuthorization,
} from "./oauth.js";

export type McpOAuthConnectionStatus = "authorization_required" | "authorizing" | "ready" | "reauthorization_required";
export interface McpOAuthConnectionDescription {
  status: McpOAuthConnectionStatus;
  issuer?: string;
  resource?: string;
  authorizedAt?: number;
}

function oauthServer(config: Awaited<ReturnType<McpConfigStore["getAgentConfig"]>>, serverName: string): McpHttpServerConfig & {transport: "streamable-http"; auth: McpHttpOAuthAuth} {
  const server = config.config.servers[serverName];
  if (!server || server.transport !== "streamable-http" || server.auth?.type !== "oauth") {
    throw new Error("MCP server is not configured for OAuth Streamable HTTP.");
  }
  return server as McpHttpServerConfig & {transport: "streamable-http"; auth: McpHttpOAuthAuth};
}

function manualClient(value: unknown): McpOAuthManualClientInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Manual OAuth client must be a JSON object.");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !["clientId", "clientSecret", "tokenEndpointAuthMethod"].includes(key));
  if (unknown) throw new Error(`Manual OAuth client contains unsupported field ${unknown}.`);
  const method = record.tokenEndpointAuthMethod;
  if (method !== "none" && method !== "client_secret_basic" && method !== "client_secret_post") {
    throw new Error("Manual OAuth token endpoint auth method is unsupported.");
  }
  const clientSecret = record.clientSecret === undefined
    ? undefined
    : requireNonEmptyString(record.clientSecret, "Manual OAuth client secret is required.");
  if (method !== "none" && !clientSecret) throw new Error("Manual OAuth confidential clients require a client secret.");
  return {
    clientId: requireNonEmptyString(record.clientId, "Manual OAuth client id is required."),
    ...(clientSecret ? {clientSecret} : {}),
    tokenEndpointAuthMethod: method as McpOAuthTokenEndpointAuthMethod,
  };
}

export class McpOAuthControl {
  constructor(private readonly options: {
    service: McpOAuthService;
    configs: McpConfigStore;
    redirectUrl: string;
    fetchFn?: typeof fetch;
  }) {}

  async status(agentKey: string, serverName: string): Promise<McpOAuthConnectionDescription> {
    const connection = await this.options.service.getConnection(agentKey, serverName);
    if (!connection) return {status: "authorization_required"};
    const metadata = {
      ...(connection.authorizationServerUrl ? {issuer: connection.authorizationServerUrl} : {}),
      ...(connection.resourceUrl ? {resource: connection.resourceUrl} : {}),
      ...(connection.authorizedAt ? {authorizedAt: connection.authorizedAt} : {}),
    };
    if (await this.options.service.hasActiveAttempt(agentKey, serverName)) return {status: "authorizing", ...metadata};
    if (connection.state.reauthorizationRequired) return {status: "reauthorization_required", ...metadata};
    return {status: connection.state.tokens ? "ready" : "authorization_required", ...metadata};
  }

  async discover(agentKey: string, serverName: string): Promise<McpOAuthDiscoverySummary> {
    const server = oauthServer(await this.options.configs.getAgentConfig(agentKey), serverName);
    return discoverMcpOAuth({serverUrl: server.url, auth: server.auth, fetchFn: this.options.fetchFn});
  }

  async start(input: {
    agentKey: string;
    serverName: string;
    initiatedIdentityId: string;
    initiatedSessionId: string;
    manualClient?: unknown;
  }): Promise<{authorizationUrl: string; expiresAt: number}> {
    const server = oauthServer(await this.options.configs.getAgentConfig(input.agentKey), input.serverName);
    const discovery = await discoverMcpOAuth({serverUrl: server.url, auth: server.auth, fetchFn: this.options.fetchFn});
    if (discovery.blockedOrigins.length > 0) throw new Error("MCP OAuth discovery contains untrusted origins.");
    if (server.auth.registration.mode === "dynamic" && !discovery.registrationEndpointAvailable) {
      throw new Error("MCP OAuth authorization server does not support dynamic client registration.");
    }
    return startMcpOAuthAuthorization({
      service: this.options.service,
      agentKey: input.agentKey,
      serverName: input.serverName,
      serverUrl: server.url,
      authConfig: server.auth,
      redirectUrl: this.options.redirectUrl,
      rawState: newMcpOAuthState(),
      initiatedIdentityId: input.initiatedIdentityId,
      initiatedSessionId: input.initiatedSessionId,
      manualClient: manualClient(input.manualClient),
      fetchFn: this.options.fetchFn,
    });
  }

  async finish(rawState: string, authorizationCode: string): Promise<{
    completed: boolean;
    agentKey: string;
    serverName: string;
    initiatedIdentityId: string;
    initiatedSessionId: string;
    issuer?: string;
    scopes: string[];
  }> {
    const attempt = await this.options.service.consumeAttempt(rawState);
    if (!attempt) throw new Error("MCP OAuth state is invalid, expired, or already used.");
    const server = oauthServer(await this.options.configs.getAgentConfig(attempt.agentKey), attempt.serverName);
    try {
      await finishMcpOAuthAuthorization({
        service: this.options.service,
        agentKey: attempt.agentKey,
        serverName: attempt.serverName,
        serverUrl: server.url,
        authConfig: server.auth,
        redirectUrl: this.options.redirectUrl,
        authorizationCode,
        codeVerifier: attempt.codeVerifier,
        fetchFn: this.options.fetchFn,
      });
    } catch {
      return {
        completed: false,
        agentKey: attempt.agentKey,
        serverName: attempt.serverName,
        initiatedIdentityId: attempt.initiatedIdentityId,
        initiatedSessionId: attempt.initiatedSessionId,
        scopes: server.auth.scope.mode === "explicit" ? server.auth.scope.values : [],
      };
    }
    const connection = await this.options.service.getConnection(attempt.agentKey, attempt.serverName);
    const grantedScope = connection?.state.tokens?.scope;
    const scopes = typeof grantedScope === "string" && grantedScope.trim()
      ? grantedScope.trim().split(/\s+/)
      : server.auth.scope.mode === "explicit" ? server.auth.scope.values : [];
    return {
      completed: true,
      agentKey: attempt.agentKey,
      serverName: attempt.serverName,
      initiatedIdentityId: attempt.initiatedIdentityId,
      initiatedSessionId: attempt.initiatedSessionId,
      issuer: connection?.authorizationServerUrl,
      scopes,
    };
  }

  async fail(rawState: string): Promise<{
    agentKey: string;
    serverName: string;
    initiatedIdentityId: string;
    initiatedSessionId: string;
  }> {
    const attempt = await this.options.service.consumeAttempt(rawState);
    if (!attempt) throw new Error("MCP OAuth state is invalid, expired, or already used.");
    return {
      agentKey: attempt.agentKey,
      serverName: attempt.serverName,
      initiatedIdentityId: attempt.initiatedIdentityId,
      initiatedSessionId: attempt.initiatedSessionId,
    };
  }

  async disconnect(agentKey: string, serverName: string): Promise<{disconnected: boolean; remoteRevocation: "succeeded" | "failed" | "unsupported"}> {
    const connection = await this.options.service.getConnection(agentKey, serverName);
    if (!connection) return {disconnected: false, remoteRevocation: "unsupported"};
    const server = oauthServer(await this.options.configs.getAgentConfig(agentKey), serverName);
    const session = await McpOAuthProviderSession.create({
      service: this.options.service,
      agentKey,
      serverName,
      serverUrl: server.url,
      authConfig: server.auth,
      redirectUrl: this.options.redirectUrl,
    });
    const remoteRevocation = await session.revokeAndDisconnect(this.options.fetchFn);
    return {disconnected: true, remoteRevocation};
  }

  async deleteConnection(agentKey: string, serverName: string): Promise<boolean> {
    const connection = await this.options.service.getConnection(agentKey, serverName);
    if (!connection) return false;
    try {
      const server = oauthServer(await this.options.configs.getAgentConfig(agentKey), serverName);
      const session = await McpOAuthProviderSession.create({service: this.options.service, agentKey, serverName, serverUrl: server.url, authConfig: server.auth, redirectUrl: this.options.redirectUrl});
      await session.revokeAndDisconnect(this.options.fetchFn);
    } catch {
      // Local deletion must still complete when the remote server is unavailable.
    }
    return this.options.service.deleteConnection(agentKey, serverName);
  }

  async invalidate(agentKey: string, serverName: string, resetClient: boolean): Promise<void> {
    const connection = await this.options.service.getConnection(agentKey, serverName);
    if (!connection) return;
    const server = oauthServer(await this.options.configs.getAgentConfig(agentKey), serverName);
    const session = await McpOAuthProviderSession.create({service: this.options.service, agentKey, serverName, serverUrl: server.url, authConfig: server.auth, redirectUrl: this.options.redirectUrl});
    await session.invalidateConfiguration(resetClient);
  }
}
