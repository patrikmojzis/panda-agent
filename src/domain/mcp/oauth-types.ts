import type {EncryptedCredentialValue} from "../credentials/types.js";
import type {JsonObject} from "../../lib/json.js";

export const MCP_OAUTH_STATE_VERSION = 1;
export const MCP_OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export interface McpOAuthConnectionState {
  version: typeof MCP_OAUTH_STATE_VERSION;
  discoveryState?: JsonObject;
  clientInformation?: JsonObject;
  tokens?: JsonObject;
  reauthorizationRequired?: boolean;
}

export interface McpOAuthConnectionRecord {
  agentKey: string;
  serverName: string;
  resourceUrl?: string;
  authorizationServerUrl?: string;
  encryptedState: EncryptedCredentialValue;
  version: number;
  authorizedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface DecryptedMcpOAuthConnection extends Omit<McpOAuthConnectionRecord, "encryptedState"> {
  state: McpOAuthConnectionState;
}

export interface McpOAuthAttemptRecord {
  stateHash: string;
  agentKey: string;
  serverName: string;
  encryptedVerifier: EncryptedCredentialValue;
  initiator: McpOAuthInitiator;
  expiresAt: number;
  consumedAt?: number;
  createdAt: number;
}

export type McpOAuthInitiator =
  | {kind: "control"; identityId: string; sessionId: string}
  | {kind: "agent"; agentKey: string; sessionId: string; identityId?: string; threadId?: string};

export interface DecryptedMcpOAuthAttempt extends Omit<McpOAuthAttemptRecord, "encryptedVerifier"> {
  codeVerifier: string;
}

export type McpOAuthTokenEndpointAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export interface McpOAuthManualClientInput {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: McpOAuthTokenEndpointAuthMethod;
}

export interface McpOAuthDiscoverySummary {
  resource: string;
  resourceMetadataUrl?: string;
  authorizationServer: string;
  supportedScopes: string[];
  registrationEndpointAvailable: boolean;
  tokenEndpointAuthMethods: string[];
  blockedOrigins: string[];
}

export function mcpOAuthGrantRef(serverName: string): string {
  return `mcp-oauth:${serverName}`;
}
