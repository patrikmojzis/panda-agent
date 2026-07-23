import {normalizeToJsonValue, stableStringify} from "../../lib/json.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import type {CredentialResolver} from "../credentials/resolver.js";
import {isSafeMcpServerName, referencedMcpCredentialEnvKeys} from "../mcp/config.js";
import type {McpConfigStore} from "../mcp/store.js";
import type {McpAgentConfigRecord, McpServerConfig} from "../mcp/types.js";
import type {McpOAuthDiscoverySummary} from "../mcp/oauth-types.js";
import type {ControlReadService} from "./read-service.js";
import type {ControlSessionRecord} from "./types.js";

export type ControlMcpServerStatus =
  | "disabled"
  | "ready"
  | "missing_credentials"
  | "credential_store_unavailable"
  | "credential_unreadable"
  | "authorization_required"
  | "authorizing"
  | "reauthorization_required"
  | "unavailable";

export interface ControlMcpOAuthSummary {
  status: "authorization_required" | "authorizing" | "ready" | "reauthorization_required" | "unavailable";
  issuer?: string;
  resource?: string;
  authorizedAt?: string;
}

export type ControlMcpServerRow = McpServerConfig & {
  serverName: string;
  credentialEnvKeys: string[];
  status: ControlMcpServerStatus;
  oauth?: ControlMcpOAuthSummary;
  createdAt?: string;
  updatedAt?: string;
};

export interface ControlMcpServiceOptions {
  reads: Pick<ControlReadService, "listAgents">;
  configs: McpConfigStore;
  credentials: Pick<CredentialResolver, "resolveCredential">;
  oauthConnections?: {deleteConnection(agentKey: string, serverName: string): Promise<boolean>};
  oauth?: {
    status(agentKey: string, serverName: string): Promise<{status: Exclude<ControlMcpOAuthSummary["status"], "unavailable">; issuer?: string; resource?: string; authorizedAt?: number}>;
    discover(agentKey: string, serverName: string): Promise<McpOAuthDiscoverySummary>;
    start(input: {agentKey: string; serverName: string; initiatedIdentityId: string; initiatedSessionId: string; manualClient?: unknown}): Promise<{authorizationUrl: string; expiresAt: number}>;
    finish(rawState: string, authorizationCode: string): Promise<{completed: boolean; agentKey: string; serverName: string; initiatedIdentityId: string; initiatedSessionId: string; issuer?: string; scopes: string[]}>;
    fail(rawState: string): Promise<{agentKey: string; serverName: string; initiatedIdentityId: string; initiatedSessionId: string}>;
    disconnect(agentKey: string, serverName: string): Promise<{disconnected: boolean; remoteRevocation: "succeeded" | "failed" | "unsupported"}>;
    deleteConnection(agentKey: string, serverName: string): Promise<boolean>;
    invalidate(agentKey: string, serverName: string, resetClient: boolean): Promise<void>;
  };
}

function iso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function changedFields(before: McpServerConfig | undefined, after: McpServerConfig): string[] {
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...fields].filter((field) => stableStringify(normalizeToJsonValue((before as unknown as Record<string, unknown> | undefined)?.[field]))
    !== stableStringify(normalizeToJsonValue((after as unknown as Record<string, unknown>)[field])));
}

export class ControlMcpService {
  private readonly reads: ControlMcpServiceOptions["reads"];
  private readonly configs: McpConfigStore;
  private readonly credentials: ControlMcpServiceOptions["credentials"];
  private readonly oauthConnections: ControlMcpServiceOptions["oauthConnections"];
  private readonly oauth: ControlMcpServiceOptions["oauth"];

  constructor(options: ControlMcpServiceOptions) {
    this.reads = options.reads;
    this.configs = options.configs;
    this.credentials = options.credentials;
    this.oauthConnections = options.oauthConnections ?? options.oauth;
    this.oauth = options.oauth;
  }

  private async assertAgentVisible(session: ControlSessionRecord, agentKey: string): Promise<string> {
    const normalized = requireNonEmptyString(agentKey, "Agent key is required.");
    if (!(await this.reads.listAgents(session)).some((agent) => agent.agentKey === normalized)) {
      throw new Error("Control target agent was not found or is not visible.");
    }
    return normalized;
  }

  private normalizeServerName(serverName: string): string {
    const normalized = requireNonEmptyString(serverName, "MCP server name is required.");
    if (!isSafeMcpServerName(normalized)) throw new Error("MCP server name is invalid.");
    return normalized;
  }

  private async status(agentKey: string, serverName: string, config: McpServerConfig): Promise<{status: ControlMcpServerStatus; oauth?: ControlMcpOAuthSummary}> {
    if (!config.enabled) return {status: "disabled"};
    if (config.transport === "streamable-http" && config.auth?.type === "oauth") {
      if (!this.oauth) return {status: "unavailable", oauth: {status: "unavailable"}};
      try {
        const description = await this.oauth.status(agentKey, serverName);
        const oauth = {
          status: description.status,
          ...(description.issuer ? {issuer: description.issuer} : {}),
          ...(description.resource ? {resource: description.resource} : {}),
          ...(description.authorizedAt ? {authorizedAt: new Date(description.authorizedAt).toISOString()} : {}),
        };
        return {status: description.status, oauth};
      } catch {
        return {status: "unavailable", oauth: {status: "unavailable"}};
      }
    }
    const keys = referencedMcpCredentialEnvKeys(config);
    for (const key of keys) {
      try {
        if (!await this.credentials.resolveCredential(key, {agentKey})) return {status: "missing_credentials"};
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return {status: message.includes("CREDENTIALS_MASTER_KEY")
          ? "credential_store_unavailable"
          : "credential_unreadable"};
      }
    }
    return {status: "ready"};
  }

  private async rows(record: McpAgentConfigRecord): Promise<ControlMcpServerRow[]> {
    return Promise.all(Object.entries(record.config.servers).map(async ([serverName, config]) => {
      const state = config.enabled
        ? await this.status(record.agentKey, serverName, config)
        : {status: "disabled" as const};
      return {
        serverName,
        ...config,
        credentialEnvKeys: referencedMcpCredentialEnvKeys(config),
        ...state,
        ...(iso(record.createdAt) ? {createdAt: iso(record.createdAt)} : {}),
        ...(iso(record.updatedAt) ? {updatedAt: iso(record.updatedAt)} : {}),
      };
    }));
  }

  async listServers(session: ControlSessionRecord, agentKey: string): Promise<{servers: ControlMcpServerRow[]; count: number}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const servers = await this.rows(await this.configs.getAgentConfig(normalizedAgentKey));
    servers.sort((left, right) => left.serverName.localeCompare(right.serverName));
    return {servers, count: servers.length};
  }

  async putServer(
    session: ControlSessionRecord,
    agentKey: string,
    serverName: string,
    input: unknown,
  ): Promise<{server: ControlMcpServerRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const normalizedServerName = this.normalizeServerName(serverName);
    const before = (await this.configs.getAgentConfig(normalizedAgentKey)).config.servers[normalizedServerName];
    const record = await this.configs.putServer(normalizedAgentKey, normalizedServerName, input);
    const config = record.config.servers[normalizedServerName]!;
    const beforeOAuth = before?.transport === "streamable-http" && before.auth?.type === "oauth"
      ? {url: before.url, auth: before.auth}
      : undefined;
    const afterOAuth = config.transport === "streamable-http" && config.auth?.type === "oauth"
      ? {url: config.url, auth: config.auth}
      : undefined;
    const oauthChanged = stableStringify(normalizeToJsonValue(beforeOAuth ?? null))
      !== stableStringify(normalizeToJsonValue(afterOAuth ?? null));
    let oauthInvalidated = false;
    if (beforeOAuth && oauthChanged) {
      oauthInvalidated = true;
      if (afterOAuth) {
        const resetClient = beforeOAuth.url !== afterOAuth.url
          || beforeOAuth.auth.registration.mode !== afterOAuth.auth.registration.mode;
        if (this.oauth) {
          try {
            await this.oauth.invalidate(normalizedAgentKey, normalizedServerName, resetClient);
          } catch {
            await this.oauthConnections?.deleteConnection(normalizedAgentKey, normalizedServerName);
          }
        } else await this.oauthConnections?.deleteConnection(normalizedAgentKey, normalizedServerName);
      }
      else await this.oauthConnections?.deleteConnection(normalizedAgentKey, normalizedServerName);
    }
    const server = (await this.rows({...record, config: {servers: {[normalizedServerName]: config}}}))[0]!;
    return {
      server,
      audit: {
        action: "put_mcp_server",
        agentKey: normalizedAgentKey,
        serverName: normalizedServerName,
        transport: config.transport,
        enabled: config.enabled,
        changedFields: changedFields(before, config),
        credentialEnvKeys: referencedMcpCredentialEnvKeys(config),
        ...(oauthInvalidated ? {oauthInvalidated: true} : {}),
      },
    };
  }

  async deleteServer(
    session: ControlSessionRecord,
    agentKey: string,
    serverName: string,
  ): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const normalizedServerName = this.normalizeServerName(serverName);
    const before = (await this.configs.getAgentConfig(normalizedAgentKey)).config.servers[normalizedServerName];
    if (before?.transport === "streamable-http" && before.auth?.type === "oauth") {
      await this.oauthConnections?.deleteConnection(normalizedAgentKey, normalizedServerName);
    }
    const {deleted} = await this.configs.deleteServer(normalizedAgentKey, normalizedServerName);
    return {
      deleted,
      audit: {
        action: "delete_mcp_server",
        agentKey: normalizedAgentKey,
        serverName: normalizedServerName,
        ...(before ? {transport: before.transport, enabled: before.enabled, credentialEnvKeys: referencedMcpCredentialEnvKeys(before)} : {}),
        changedFields: deleted ? ["deleted"] : [],
      },
    };
  }

  async discoverOAuth(session: ControlSessionRecord, agentKey: string, serverName: string): Promise<{discovery: McpOAuthDiscoverySummary; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const normalizedServerName = this.normalizeServerName(serverName);
    if (!this.oauth) throw new Error("MCP OAuth is unavailable.");
    const discovery = await this.oauth.discover(normalizedAgentKey, normalizedServerName);
    return {discovery, audit: {action: "discover_mcp_oauth", agentKey: normalizedAgentKey, serverName: normalizedServerName, authorizationServer: discovery.authorizationServer, blockedOrigins: discovery.blockedOrigins}};
  }

  async startOAuth(session: ControlSessionRecord, agentKey: string, serverName: string, input: {manualClient?: unknown}): Promise<{authorizationUrl: string; expiresAt: string; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const normalizedServerName = this.normalizeServerName(serverName);
    if (!this.oauth) throw new Error("MCP OAuth is unavailable.");
    const result = await this.oauth.start({agentKey: normalizedAgentKey, serverName: normalizedServerName, initiatedIdentityId: session.identityId, initiatedSessionId: session.id, manualClient: input.manualClient});
    return {authorizationUrl: result.authorizationUrl, expiresAt: new Date(result.expiresAt).toISOString(), audit: {action: "start_mcp_oauth", agentKey: normalizedAgentKey, serverName: normalizedServerName}};
  }

  async disconnectOAuth(session: ControlSessionRecord, agentKey: string, serverName: string): Promise<{disconnected: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const normalizedServerName = this.normalizeServerName(serverName);
    if (!this.oauth) throw new Error("MCP OAuth is unavailable.");
    const result = await this.oauth.disconnect(normalizedAgentKey, normalizedServerName);
    return {disconnected: result.disconnected, audit: {action: "disconnect_mcp_oauth", agentKey: normalizedAgentKey, serverName: normalizedServerName, remoteRevocation: result.remoteRevocation}};
  }

  async finishOAuth(rawState: string, authorizationCode: string): Promise<{completed: boolean; audit: Record<string, unknown>; identityId: string; sessionId: string}> {
    if (!this.oauth) throw new Error("MCP OAuth is unavailable.");
    const result = await this.oauth.finish(rawState, authorizationCode);
    return {
      completed: result.completed,
      identityId: result.initiatedIdentityId,
      sessionId: result.initiatedSessionId,
      audit: result.completed
        ? {action: "complete_mcp_oauth", agentKey: result.agentKey, serverName: result.serverName, ...(result.issuer ? {issuer: result.issuer} : {}), scopes: result.scopes}
        : {action: "fail_mcp_oauth", agentKey: result.agentKey, serverName: result.serverName, reason: "token_exchange_failed"},
    };
  }

  async failOAuth(rawState: string, reason: string): Promise<{audit: Record<string, unknown>; identityId: string; sessionId: string}> {
    if (!this.oauth) throw new Error("MCP OAuth is unavailable.");
    const result = await this.oauth.fail(rawState);
    return {
      identityId: result.initiatedIdentityId,
      sessionId: result.initiatedSessionId,
      audit: {action: "fail_mcp_oauth", agentKey: result.agentKey, serverName: result.serverName, reason},
    };
  }
}
