import {isJsonObject, normalizeToJsonValue, stableStringify, type JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {CommandDenialError} from "../commands/errors.js";
import type {CredentialResolver} from "../credentials/resolver.js";
import type {ExecutionCredentialPolicy} from "../execution-environments/types.js";
import {isSafeMcpServerName, referencedMcpCredentialEnvKeys} from "./config.js";
import {assertMcpCredentialPolicy, McpInvocationError, resolveMcpInvocation} from "./invocation.js";
import {mcpOAuthGrantRef, type McpOAuthDiscoverySummary, type McpOAuthInitiator, type McpOAuthManualClientInput, type McpOAuthTokenEndpointAuthMethod} from "./oauth-types.js";
import {McpRegistryVersionConflictError, type McpConfigStore} from "./store.js";
import {MCP_OUTPUT_MAX_BYTES, type McpAgentConfigRecord, type McpRunner, type McpServerConfig} from "./types.js";

export type McpManagementActor =
  | {kind: "control"; identityId: string; sessionId: string; agentKey: string}
  | {kind: "agent"; agentKey: string; sessionId: string; identityId?: string; threadId?: string};

export type McpManagedServerStatus =
  | "disabled"
  | "ready"
  | "missing_credentials"
  | "credential_store_unavailable"
  | "credential_unreadable"
  | "authorization_required"
  | "authorizing"
  | "reauthorization_required"
  | "unavailable"
  | "credential_policy_denied";

export interface McpOAuthManager {
  status(agentKey: string, serverName: string): Promise<{status: "authorization_required" | "authorizing" | "ready" | "reauthorization_required"; issuer?: string; resource?: string; authorizedAt?: number}>;
  discover(agentKey: string, serverName: string): Promise<McpOAuthDiscoverySummary>;
  start(input: {agentKey: string; serverName: string; initiator: McpOAuthInitiator; manualClient?: unknown}): Promise<{authorizationUrl: string; expiresAt: number}>;
  finish(rawState: string, authorizationCode: string): Promise<{completed: boolean; agentKey: string; serverName: string; initiator: McpOAuthInitiator; issuer?: string; scopes: string[]}>;
  fail(rawState: string): Promise<{agentKey: string; serverName: string; initiator: McpOAuthInitiator}>;
  disconnect(agentKey: string, serverName: string): Promise<{disconnected: boolean; remoteRevocation: "succeeded" | "failed" | "unsupported"}>;
  deleteConnection(agentKey: string, serverName: string): Promise<boolean>;
  invalidate(agentKey: string, serverName: string, resetClient: boolean): Promise<void>;
}

export interface McpManagementAuditWriter {
  recordAudit(input: {identityId?: string; sessionId?: string; eventType: string; metadata?: unknown}): Promise<void>;
}

export interface McpManagementServiceOptions {
  configs: McpConfigStore;
  credentials: Pick<CredentialResolver, "resolveCredential">;
  runner: McpRunner;
  oauthConnections?: {deleteConnection(agentKey: string, serverName: string): Promise<boolean>};
  oauth?: McpOAuthManager;
  audit?: McpManagementAuditWriter;
}

export interface McpAgentManualClientInput {
  clientId: string;
  tokenEndpointAuthMethod: McpOAuthTokenEndpointAuthMethod;
  clientSecretCredentialEnvKey?: string;
}

function serverName(value: unknown): string {
  const normalized = requireNonEmptyString(value, "MCP server name is required.");
  if (!isSafeMcpServerName(normalized)) throw new Error("MCP server name is invalid.");
  return normalized;
}

function iso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function changedFields(before: McpServerConfig | undefined, after: McpServerConfig | undefined): string[] {
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...fields].filter((field) => stableStringify(normalizeToJsonValue((before as unknown as Record<string, unknown> | undefined)?.[field]))
    !== stableStringify(normalizeToJsonValue((after as unknown as Record<string, unknown> | undefined)?.[field])));
}

function redactAgentConfig(config: McpServerConfig): JsonObject {
  const normalized = normalizeToJsonValue(config);
  if (!isJsonObject(normalized)) throw new Error("MCP server config is invalid.");
  if (config.transport === "stdio" && config.env) {
    normalized.env = Object.fromEntries(Object.entries(config.env).map(([key, value]): [string, JsonObject] => [key,
      "credentialEnvKey" in value
        ? {credentialEnvKey: value.credentialEnvKey}
        : {literal: true, redacted: true},
    ]));
  }
  if (config.transport !== "stdio" && config.headers) {
    normalized.headers = config.headers.map((header): JsonObject => header.credentialEnvKey
      ? {name: header.name, credentialEnvKey: header.credentialEnvKey}
      : {name: header.name, literal: true, redacted: true});
  }
  return normalized;
}

function assertAgentConfigHasNoLiteralCredentials(input: unknown): void {
  if (!isRecord(input)) return;
  if (input.transport === "stdio" && isRecord(input.env)) {
    for (const value of Object.values(input.env)) {
      if (isRecord(value) && Object.hasOwn(value, "value")) {
        throw new Error("Agent-managed MCP stdio environment values must use credentialEnvKey.");
      }
    }
  }
  if ((input.transport === "streamable-http" || input.transport === "sse") && Array.isArray(input.headers)) {
    for (const value of input.headers) {
      if (isRecord(value) && Object.hasOwn(value, "value")) {
        throw new Error("Agent-managed MCP HTTP headers must use credentialEnvKey.");
      }
    }
  }
}

function initiator(actor: McpManagementActor): McpOAuthInitiator {
  return actor.kind === "control"
    ? {kind: "control", identityId: actor.identityId, sessionId: actor.sessionId}
    : {
      kind: "agent",
      agentKey: actor.agentKey,
      sessionId: actor.sessionId,
      ...(actor.identityId ? {identityId: actor.identityId} : {}),
      ...(actor.threadId ? {threadId: actor.threadId} : {}),
    };
}

function failureCode(error: unknown): string {
  if (error instanceof McpRegistryVersionConflictError) return "stale_version";
  if (error instanceof CommandDenialError) return "credential_policy_denied";
  if (error instanceof McpInvocationError) return String(error.pandaCommandErrorDetails.kind);
  const message = error instanceof Error ? error.message : "";
  if (message.includes("not configured") || message.includes("not found")) return "not_found";
  if (message.includes("already exists")) return "already_exists";
  if (message.includes("OAuth is unavailable")) return "oauth_unavailable";
  if (message.includes("authorization")) return "authorization_required";
  return "operation_failed";
}

export class McpManagementService {
  private readonly oauthConnections: McpManagementServiceOptions["oauthConnections"];

  constructor(private readonly options: McpManagementServiceOptions) {
    this.oauthConnections = options.oauthConnections ?? options.oauth;
  }

  private async audit(actor: McpManagementActor, metadata: Record<string, unknown>): Promise<void> {
    if (!this.options.audit) return;
    await this.options.audit.recordAudit({
      ...(actor.identityId ? {identityId: actor.identityId} : {}),
      ...(actor.kind === "control" ? {sessionId: actor.sessionId} : {}),
      eventType: actor.kind === "control" ? "control_operator_write" : "agent_mcp_operation",
      metadata: {
        actorKind: actor.kind,
        agentKey: actor.agentKey,
        ...(actor.kind === "agent" ? {
          runtimeSessionId: actor.sessionId,
          ...(actor.threadId ? {threadId: actor.threadId} : {}),
        } : {}),
        ...metadata,
      },
    });
  }

  private async run<T>(
    actor: McpManagementActor,
    action: string,
    rawServerName: string | undefined,
    operation: () => Promise<{value: T; audit?: Record<string, unknown>}>,
    auditEnabled = true,
  ): Promise<T> {
    const name = rawServerName === undefined ? undefined : serverName(rawServerName);
    try {
      const result = await operation();
      if (auditEnabled) await this.audit(actor, {action, outcome: "success", ...(name ? {serverName: name} : {}), ...(result.audit ?? {})});
      return result.value;
    } catch (error) {
      if (auditEnabled) await this.audit(actor, {action, outcome: "failure", ...(name ? {serverName: name} : {}), failureCode: failureCode(error)});
      throw error;
    }
  }

  private async status(
    actor: McpManagementActor,
    name: string,
    config: McpServerConfig,
    credentialPolicy?: ExecutionCredentialPolicy,
  ): Promise<{status: McpManagedServerStatus; oauth?: JsonObject}> {
    if (!config.enabled) return {status: "disabled"};
    if (config.transport === "streamable-http" && config.auth?.type === "oauth") {
      if (!this.options.oauth) return {status: "unavailable", oauth: {status: "unavailable"}};
      if (actor.kind === "agent") {
        try {
          assertMcpCredentialPolicy(credentialPolicy, [], [mcpOAuthGrantRef(name)]);
        } catch (error) {
          if (error instanceof CommandDenialError) return {status: "credential_policy_denied", oauth: {status: "credential_policy_denied"}};
          throw error;
        }
      }
      try {
        const value = await this.options.oauth.status(actor.agentKey, name);
        return {status: value.status, oauth: {
          status: value.status,
          ...(value.issuer ? {issuer: value.issuer} : {}),
          ...(value.resource ? {resource: value.resource} : {}),
          ...(value.authorizedAt ? {authorizedAt: new Date(value.authorizedAt).toISOString()} : {}),
        }};
      } catch {
        return {status: "unavailable", oauth: {status: "unavailable"}};
      }
    }
    const keys = referencedMcpCredentialEnvKeys(config);
    if (actor.kind === "agent") {
      try {
        assertMcpCredentialPolicy(credentialPolicy, keys);
      } catch (error) {
        if (error instanceof CommandDenialError) return {status: "credential_policy_denied"};
        throw error;
      }
    }
    for (const key of keys) {
      try {
        if (!await this.options.credentials.resolveCredential(key, {agentKey: actor.agentKey})) return {status: "missing_credentials"};
      } catch (error) {
        return {status: error instanceof Error && error.message.includes("CREDENTIALS_MASTER_KEY")
          ? "credential_store_unavailable"
          : "credential_unreadable"};
      }
    }
    return {status: "ready"};
  }

  private async describe(actor: McpManagementActor, record: McpAgentConfigRecord, name: string, config: McpServerConfig, credentialPolicy?: ExecutionCredentialPolicy): Promise<JsonObject> {
    const state = await this.status(actor, name, config, credentialPolicy);
    return {
      serverName: name,
      ...(actor.kind === "agent" ? redactAgentConfig(config) : normalizeToJsonValue(config) as JsonObject),
      credentialEnvKeys: referencedMcpCredentialEnvKeys(config),
      ...state,
      ...(iso(record.createdAt) ? {createdAt: iso(record.createdAt)!} : {}),
      ...(iso(record.updatedAt) ? {updatedAt: iso(record.updatedAt)!} : {}),
    };
  }

  async list(actor: McpManagementActor, credentialPolicy?: ExecutionCredentialPolicy): Promise<{servers: JsonObject[]; count: number; version: number}> {
    return this.run(actor, "list_mcp_servers", undefined, async () => {
      const record = await this.options.configs.getAgentConfig(actor.agentKey);
      const servers = await Promise.all(Object.entries(record.config.servers).map(([name, config]) => this.describe(actor, record, name, config, credentialPolicy)));
      servers.sort((left, right) => String(left.serverName).localeCompare(String(right.serverName)));
      return {value: {servers, count: servers.length, version: record.version}};
    }, false);
  }

  async show(actor: McpManagementActor, rawName: string, credentialPolicy?: ExecutionCredentialPolicy): Promise<{server: JsonObject; version: number}> {
    return this.run(actor, "show_mcp_server", rawName, async () => {
      const name = serverName(rawName);
      const record = await this.options.configs.getAgentConfig(actor.agentKey);
      const config = record.config.servers[name];
      if (!config) throw new Error(`MCP server ${name} is not configured.`);
      return {value: {server: await this.describe(actor, record, name, config, credentialPolicy), version: record.version}};
    }, false);
  }

  async put(actor: McpManagementActor, rawName: string, config: unknown, input: {mode: "create" | "update" | "upsert"; expectedVersion?: number; credentialPolicy?: ExecutionCredentialPolicy}): Promise<{server: JsonObject; version: number}> {
    return this.run(actor, input.mode === "create" ? "add_mcp_server" : input.mode === "update" ? "update_mcp_server" : "put_mcp_server", rawName, async () => {
      const name = serverName(rawName);
      if (actor.kind === "agent") assertAgentConfigHasNoLiteralCredentials(config);
      const result = await this.options.configs.putServer(actor.agentKey, name, config, {mode: input.mode, ...(input.expectedVersion === undefined ? {} : {expectedVersion: input.expectedVersion})});
      await this.invalidateOAuth(actor.agentKey, name, result.previous, result.server);
      return {
        value: {server: await this.describe(actor, result.record, name, result.server!, input.credentialPolicy), version: result.record.version},
        audit: {transport: result.server!.transport, enabled: result.server!.enabled, changedFields: changedFields(result.previous, result.server)},
      };
    });
  }

  async setEnabled(actor: McpManagementActor, rawName: string, enabled: boolean, expectedVersion: number, credentialPolicy?: ExecutionCredentialPolicy): Promise<{server: JsonObject; version: number}> {
    return this.run(actor, enabled ? "enable_mcp_server" : "disable_mcp_server", rawName, async () => {
      const name = serverName(rawName);
      const result = await this.options.configs.setServerEnabled(actor.agentKey, name, enabled, {expectedVersion});
      return {
        value: {server: await this.describe(actor, result.record, name, result.server!, credentialPolicy), version: result.record.version},
        audit: {transport: result.server!.transport, enabled, changedFields: changedFields(result.previous, result.server)},
      };
    });
  }

  async delete(actor: McpManagementActor, rawName: string, expectedVersion?: number): Promise<{deleted: boolean; version: number}> {
    return this.run(actor, "delete_mcp_server", rawName, async () => {
      const name = serverName(rawName);
      const result = await this.options.configs.deleteServer(actor.agentKey, name, expectedVersion === undefined ? {} : {expectedVersion});
      if (result.previous?.transport === "streamable-http" && result.previous.auth?.type === "oauth") {
        await this.oauthConnections?.deleteConnection(actor.agentKey, name);
      }
      return {value: {deleted: result.deleted, version: result.record.version}, audit: {
        ...(result.previous ? {transport: result.previous.transport, enabled: result.previous.enabled} : {}),
        changedFields: result.deleted ? ["deleted"] : [],
      }};
    });
  }

  async test(actor: McpManagementActor, rawName: string, input: {credentialPolicy?: ExecutionCredentialPolicy; timeoutMs?: number} = {}): Promise<JsonObject> {
    return this.run(actor, "test_mcp_server", rawName, async () => {
      const name = serverName(rawName);
      const invocation = await resolveMcpInvocation({
        configs: this.options.configs,
        credentials: this.options.credentials,
        agentKey: actor.agentKey,
        serverName: name,
        credentialPolicy: input.credentialPolicy,
        allowDisabled: true,
        ...(input.timeoutMs === undefined ? {} : {timeoutMs: input.timeoutMs}),
      });
      if (invocation.config.transport === "streamable-http" && invocation.config.oauth) {
        if (!this.options.oauth) throw new Error(`MCP server ${name} requires OAuth authorization, but OAuth is unavailable.`);
        const oauthStatus = await this.options.oauth.status(actor.agentKey, name);
        if (oauthStatus.status !== "ready") {
          throw new Error(`MCP server ${name} authorization is required. Run panda mcp oauth start ${name}.`);
        }
      }
      const run = await this.options.runner.listTools(invocation);
      const value = normalizeToJsonValue(run.value);
      if (!isJsonObject(value) || !Array.isArray(value.tools)) throw new Error("MCP tools result is invalid.");
      const output: JsonObject = {
        server: name,
        tools: value.tools,
        toolCount: value.tools.length,
        diagnostics: normalizeToJsonValue(run.diagnostics),
        ...(run.serverInfo ? {serverInfo: normalizeToJsonValue(run.serverInfo)} : {}),
        ...(run.serverCapabilities ? {serverCapabilities: normalizeToJsonValue(run.serverCapabilities)} : {}),
      };
      if (Buffer.byteLength(JSON.stringify(output), "utf8") > MCP_OUTPUT_MAX_BYTES) {
        throw new McpInvocationError("MCP server test output exceeded the configured limit.", 3, "output_limit");
      }
      return {value: output, audit: {transport: invocation.config.transport}};
    });
  }

  async discoverOAuth(actor: McpManagementActor, rawName: string, credentialPolicy?: ExecutionCredentialPolicy): Promise<{discovery: McpOAuthDiscoverySummary}> {
    return this.run(actor, "discover_mcp_oauth", rawName, async () => {
      if (!this.options.oauth) throw new Error("MCP OAuth is unavailable.");
      const name = serverName(rawName);
      if (actor.kind === "agent") assertMcpCredentialPolicy(credentialPolicy, [], [mcpOAuthGrantRef(name)]);
      const discovery = await this.options.oauth.discover(actor.agentKey, name);
      return {value: {discovery}, audit: {issuer: discovery.authorizationServer, blockedOriginCount: discovery.blockedOrigins.length}};
    });
  }

  async oauthStatus(actor: McpManagementActor, rawName: string, credentialPolicy?: ExecutionCredentialPolicy): Promise<JsonObject> {
    return this.run(actor, "status_mcp_oauth", rawName, async () => {
      const name = serverName(rawName);
      if (!this.options.oauth) return {value: {status: "unavailable"}};
      if (actor.kind === "agent") assertMcpCredentialPolicy(credentialPolicy, [], [mcpOAuthGrantRef(name)]);
      const value = await this.options.oauth.status(actor.agentKey, name);
      return {value: {
        status: value.status,
        ...(value.issuer ? {issuer: value.issuer} : {}),
        ...(value.resource ? {resource: value.resource} : {}),
        ...(value.authorizedAt ? {authorizedAt: new Date(value.authorizedAt).toISOString()} : {}),
      }};
    }, false);
  }

  async startOAuth(actor: McpManagementActor, rawName: string, input: {credentialPolicy?: ExecutionCredentialPolicy; manualClient?: unknown} = {}): Promise<{authorizationUrl: string; expiresAt: string}> {
    return this.run(actor, "start_mcp_oauth", rawName, async () => {
      const name = serverName(rawName);
      if (!this.options.oauth) throw new Error("MCP OAuth is unavailable.");
      let manualClient: McpOAuthManualClientInput | undefined;
      if (actor.kind === "agent") {
        assertMcpCredentialPolicy(input.credentialPolicy, [], [mcpOAuthGrantRef(name)]);
        if (input.manualClient !== undefined) manualClient = await this.resolveAgentManualClient(actor, input.manualClient, input.credentialPolicy);
      } else if (input.manualClient !== undefined) {
        manualClient = input.manualClient as McpOAuthManualClientInput;
      }
      const result = await this.options.oauth.start({agentKey: actor.agentKey, serverName: name, initiator: initiator(actor), ...(manualClient ? {manualClient} : {})});
      return {value: {authorizationUrl: result.authorizationUrl, expiresAt: new Date(result.expiresAt).toISOString()}};
    });
  }

  async disconnectOAuth(actor: McpManagementActor, rawName: string, credentialPolicy?: ExecutionCredentialPolicy): Promise<{disconnected: boolean}> {
    return this.run(actor, "disconnect_mcp_oauth", rawName, async () => {
      const name = serverName(rawName);
      if (!this.options.oauth) throw new Error("MCP OAuth is unavailable.");
      if (actor.kind === "agent") assertMcpCredentialPolicy(credentialPolicy, [], [mcpOAuthGrantRef(name)]);
      const result = await this.options.oauth.disconnect(actor.agentKey, name);
      return {value: {disconnected: result.disconnected}, audit: {remoteRevocation: result.remoteRevocation}};
    });
  }

  async finishOAuth(rawState: string, authorizationCode: string): Promise<{completed: boolean}> {
    if (!this.options.oauth) throw new Error("MCP OAuth is unavailable.");
    const result = await this.options.oauth.finish(rawState, authorizationCode);
    const actor = this.actorFromInitiator(result.agentKey, result.initiator);
    await this.audit(actor, result.completed
      ? {
        action: "complete_mcp_oauth",
        outcome: "success",
        serverName: result.serverName,
        ...(result.issuer ? {issuer: result.issuer} : {}),
        scopes: result.scopes,
      }
      : {
        action: "fail_mcp_oauth",
        outcome: "failure",
        serverName: result.serverName,
        failureCode: "token_exchange_failed",
      });
    return {completed: result.completed};
  }

  async failOAuth(rawState: string, reason: string): Promise<void> {
    if (!this.options.oauth) throw new Error("MCP OAuth is unavailable.");
    const result = await this.options.oauth.fail(rawState);
    await this.audit(this.actorFromInitiator(result.agentKey, result.initiator), {
      action: "fail_mcp_oauth",
      outcome: "failure",
      serverName: result.serverName,
      failureCode: reason,
    });
  }

  private actorFromInitiator(agentKey: string, value: McpOAuthInitiator): McpManagementActor {
    return value.kind === "control"
      ? {kind: "control", agentKey, identityId: value.identityId, sessionId: value.sessionId}
      : {
        kind: "agent",
        agentKey,
        sessionId: value.sessionId,
        ...(value.identityId ? {identityId: value.identityId} : {}),
        ...(value.threadId ? {threadId: value.threadId} : {}),
      };
  }

  private async resolveAgentManualClient(actor: Extract<McpManagementActor, {kind: "agent"}>, value: unknown, policy?: ExecutionCredentialPolicy): Promise<McpOAuthManualClientInput> {
    if (!isRecord(value)) throw new Error("Manual OAuth client must be a JSON object.");
    const unknown = Object.keys(value).find((key) => !["clientId", "clientSecretCredentialEnvKey", "tokenEndpointAuthMethod"].includes(key));
    if (unknown) throw new Error(`Manual OAuth client contains unsupported field ${unknown}.`);
    const method = value.tokenEndpointAuthMethod;
    if (method !== "none" && method !== "client_secret_basic" && method !== "client_secret_post") throw new Error("Manual OAuth token endpoint auth method is unsupported.");
    const clientId = requireNonEmptyString(value.clientId, "Manual OAuth client id is required.");
    const secretKey = value.clientSecretCredentialEnvKey === undefined
      ? undefined
      : requireNonEmptyString(value.clientSecretCredentialEnvKey, "Manual OAuth client secret credential reference is required.");
    if (method !== "none" && !secretKey) throw new Error("Manual OAuth confidential clients require clientSecretCredentialEnvKey.");
    if (!secretKey) return {clientId, tokenEndpointAuthMethod: method};
    assertMcpCredentialPolicy(policy, [secretKey]);
    const resolved = await this.options.credentials.resolveCredential(secretKey, {agentKey: actor.agentKey});
    if (!resolved) throw new Error(`MCP credential ${secretKey} is not configured.`);
    return {clientId, clientSecret: resolved.value, tokenEndpointAuthMethod: method};
  }

  private async invalidateOAuth(agentKey: string, name: string, before: McpServerConfig | undefined, after: McpServerConfig | undefined): Promise<void> {
    const beforeOAuth = before?.transport === "streamable-http" && before.auth?.type === "oauth" ? {url: before.url, auth: before.auth} : undefined;
    const afterOAuth = after?.transport === "streamable-http" && after.auth?.type === "oauth" ? {url: after.url, auth: after.auth} : undefined;
    if (!beforeOAuth || stableStringify(normalizeToJsonValue(beforeOAuth)) === stableStringify(normalizeToJsonValue(afterOAuth ?? null))) return;
    if (!afterOAuth) {
      await this.oauthConnections?.deleteConnection(agentKey, name);
      return;
    }
    const resetClient = beforeOAuth.url !== afterOAuth.url || beforeOAuth.auth.registration.mode !== afterOAuth.auth.registration.mode;
    if (this.options.oauth) {
      try {
        await this.options.oauth.invalidate(agentKey, name, resetClient);
        return;
      } catch {
        // A stale grant must not survive a config change when invalidation cannot complete.
      }
    }
    await this.oauthConnections?.deleteConnection(agentKey, name);
  }
}
