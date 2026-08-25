import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {hashOpaqueToken} from "../../lib/opaque-tokens.js";
import {isRecord} from "../../lib/records.js";
import {SecretCrypto, type EncryptedSecret, type SecretContext} from "../secrets/crypto.js";
import type {McpOAuthAttemptRecord, McpOAuthConnectionRecord, McpOAuthConnectionState, DecryptedMcpOAuthAttempt, DecryptedMcpOAuthConnection, McpOAuthInitiator} from "./oauth-types.js";
import {MCP_OAUTH_STATE_VERSION, mcpOAuthAttemptSecretContext, mcpOAuthConnectionSecretContext} from "./oauth-types.js";

type OAuthStore = {
  getConnection(agentKey: string, serverName: string): Promise<McpOAuthConnectionRecord | null>;
  compareAndSetConnection(input: {
    agentKey: string;
    serverName: string;
    resourceUrl?: string;
    authorizationServerUrl?: string;
    encryptedState: EncryptedSecret;
    expectedVersion: number | null;
    authorizedAt?: number;
  }): Promise<McpOAuthConnectionRecord | null>;
  deleteConnection(agentKey: string, serverName: string): Promise<boolean>;
  createAttempt(input: {
    stateHash: string;
    agentKey: string;
    serverName: string;
    encryptedVerifier: EncryptedSecret;
    initiator: McpOAuthInitiator;
    expiresAt: number;
  }): Promise<McpOAuthAttemptRecord>;
  consumeAttempt(stateHash: string, now: number): Promise<McpOAuthAttemptRecord | null>;
  hasActiveAttempt(agentKey: string, serverName: string, now: number): Promise<boolean>;
};

function decrypt(crypto: SecretCrypto, value: EncryptedSecret, context: SecretContext): string {
  return crypto.open(value, context);
}

function parseState(raw: string): McpOAuthConnectionState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Stored MCP OAuth state is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== MCP_OAUTH_STATE_VERSION) throw new Error("Stored MCP OAuth state version is unsupported.");
  const allowed = new Set(["version", "discoveryState", "clientInformation", "tokens", "reauthorizationRequired"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Stored MCP OAuth state contains unsupported field ${unknown}.`);
  for (const key of ["discoveryState", "clientInformation", "tokens"] as const) {
    if (value[key] !== undefined && !isJsonObject(value[key])) throw new Error(`Stored MCP OAuth ${key} must be a JSON object.`);
  }
  if (value.reauthorizationRequired !== undefined && typeof value.reauthorizationRequired !== "boolean") {
    throw new Error("Stored MCP OAuth reauthorizationRequired must be boolean.");
  }
  return value as unknown as McpOAuthConnectionState;
}

function decryptConnection(record: McpOAuthConnectionRecord, crypto: SecretCrypto): DecryptedMcpOAuthConnection {
  const {encryptedState, ...metadata} = record;
  return {
    ...metadata,
    state: parseState(decrypt(crypto, encryptedState, mcpOAuthConnectionSecretContext(record.agentKey, record.serverName))),
  };
}

function jsonState(state: McpOAuthConnectionState): JsonObject {
  const value = JSON.parse(JSON.stringify(state)) as unknown;
  if (!isJsonObject(value)) throw new Error("MCP OAuth state must be a JSON object.");
  return value;
}

export class McpOAuthService {
  constructor(private readonly options: {store: OAuthStore; crypto: SecretCrypto}) {}

  async getConnection(agentKey: string, serverName: string): Promise<DecryptedMcpOAuthConnection | null> {
    const record = await this.options.store.getConnection(agentKey, serverName);
    return record ? decryptConnection(record, this.options.crypto) : null;
  }

  async saveConnection(input: {
    agentKey: string;
    serverName: string;
    state: McpOAuthConnectionState;
    expectedVersion: number | null;
    resourceUrl?: string;
    authorizationServerUrl?: string;
    authorizedAt?: number;
  }): Promise<DecryptedMcpOAuthConnection | null> {
    const encryptedState = this.options.crypto.seal(
      JSON.stringify(jsonState(input.state)),
      mcpOAuthConnectionSecretContext(input.agentKey, input.serverName),
    );
    const record = await this.options.store.compareAndSetConnection({...input, encryptedState});
    return record ? decryptConnection(record, this.options.crypto) : null;
  }

  async deleteConnection(agentKey: string, serverName: string): Promise<boolean> {
    return this.options.store.deleteConnection(agentKey, serverName);
  }

  async createAttempt(input: {
    rawState: string;
    codeVerifier: string;
    agentKey: string;
    serverName: string;
    initiator: McpOAuthInitiator;
    expiresAt: number;
  }): Promise<void> {
    const stateHash = hashOpaqueToken(input.rawState);
    await this.options.store.createAttempt({
      stateHash,
      agentKey: input.agentKey,
      serverName: input.serverName,
      encryptedVerifier: this.options.crypto.seal(
        input.codeVerifier,
        mcpOAuthAttemptSecretContext(stateHash, input.agentKey, input.serverName),
      ),
      initiator: input.initiator,
      expiresAt: input.expiresAt,
    });
  }

  async consumeAttempt(rawState: string, now = Date.now()): Promise<DecryptedMcpOAuthAttempt | null> {
    const record = await this.options.store.consumeAttempt(hashOpaqueToken(rawState), now);
    if (!record) return null;
    const {encryptedVerifier, ...metadata} = record;
    return {
      ...metadata,
      codeVerifier: decrypt(
        this.options.crypto,
        encryptedVerifier,
        mcpOAuthAttemptSecretContext(record.stateHash, record.agentKey, record.serverName),
      ),
    };
  }

  hasActiveAttempt(agentKey: string, serverName: string, now = Date.now()): Promise<boolean> {
    return this.options.store.hasActiveAttempt(agentKey, serverName, now);
  }
}
