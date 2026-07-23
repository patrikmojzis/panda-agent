import type {JsonObject} from "../../lib/json.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import type {McpManagementActor, McpManagementService} from "../mcp/management-service.js";
import type {McpOAuthDiscoverySummary} from "../mcp/oauth-types.js";
import type {ControlReadService} from "./read-service.js";
import type {ControlSessionRecord} from "./types.js";

export type ControlMcpServerRow = JsonObject;

export interface ControlMcpServiceOptions {
  reads: Pick<ControlReadService, "listAgents">;
  management: McpManagementService;
}

/** Visibility-checking Control adapter over the canonical MCP management service. */
export class ControlMcpService {
  constructor(private readonly options: ControlMcpServiceOptions) {}

  private async actor(session: ControlSessionRecord, agentKey: string): Promise<McpManagementActor> {
    const normalized = requireNonEmptyString(agentKey, "Agent key is required.");
    if (!(await this.options.reads.listAgents(session)).some((agent) => agent.agentKey === normalized)) {
      throw new Error("Control target agent was not found or is not visible.");
    }
    return {kind: "control", identityId: session.identityId, sessionId: session.id, agentKey: normalized};
  }

  async listServers(session: ControlSessionRecord, agentKey: string): Promise<{servers: ControlMcpServerRow[]; count: number; version: number}> {
    return this.options.management.list(await this.actor(session, agentKey));
  }

  async putServer(
    session: ControlSessionRecord,
    agentKey: string,
    serverName: string,
    input: unknown,
    expectedVersion?: number,
  ): Promise<{server: ControlMcpServerRow; version: number}> {
    return this.options.management.put(await this.actor(session, agentKey), serverName, input, {
      mode: "upsert",
      ...(expectedVersion === undefined ? {} : {expectedVersion}),
    });
  }

  async deleteServer(
    session: ControlSessionRecord,
    agentKey: string,
    serverName: string,
    expectedVersion?: number,
  ): Promise<{deleted: boolean; version: number}> {
    return this.options.management.delete(await this.actor(session, agentKey), serverName, expectedVersion);
  }

  async discoverOAuth(session: ControlSessionRecord, agentKey: string, serverName: string): Promise<{discovery: McpOAuthDiscoverySummary}> {
    return this.options.management.discoverOAuth(await this.actor(session, agentKey), serverName);
  }

  async startOAuth(session: ControlSessionRecord, agentKey: string, serverName: string, input: {manualClient?: unknown}): Promise<{authorizationUrl: string; expiresAt: string}> {
    return this.options.management.startOAuth(await this.actor(session, agentKey), serverName, input);
  }

  async disconnectOAuth(session: ControlSessionRecord, agentKey: string, serverName: string): Promise<{disconnected: boolean}> {
    return this.options.management.disconnectOAuth(await this.actor(session, agentKey), serverName);
  }

  async finishOAuth(rawState: string, authorizationCode: string): Promise<{completed: boolean}> {
    return this.options.management.finishOAuth(rawState, authorizationCode);
  }

  async failOAuth(rawState: string, reason: string): Promise<void> {
    await this.options.management.failOAuth(rawState, reason);
  }
}
