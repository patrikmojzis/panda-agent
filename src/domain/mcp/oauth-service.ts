import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {hashOpaqueToken} from "../../lib/opaque-tokens.js";
import {isRecord} from "../../lib/records.js";
import {CredentialCrypto} from "../credentials/crypto.js";
import type {McpOAuthAttemptRecord, McpOAuthConnectionRecord, McpOAuthConnectionState, DecryptedMcpOAuthAttempt, DecryptedMcpOAuthConnection, McpOAuthInitiator} from "./oauth-types.js";
import {MCP_OAUTH_STATE_VERSION} from "./oauth-types.js";

type OAuthStore = {
  getConnection(agentKey: string, serverName: string): Promise<McpOAuthConnectionRecord | null>;
  compareAndSetConnection(input: {
    agentKey: string;
    serverName: string;
    resourceUrl?: string;
    authorizationServerUrl?: string;
    encryptedState: ReturnType<CredentialCrypto["encrypt"]>;
    expectedVersion: number | null;
    authorizedAt?: number;
  }): Promise<McpOAuthConnectionRecord | null>;
  deleteConnection(agentKey: string, serverName: string): Promise<boolean>;
  createAttempt(input: {
    stateHash: string;
    agentKey: string;
    serverName: string;
    encryptedVerifier: ReturnType<CredentialCrypto["encrypt"]>;
    initiator: McpOAuthInitiator;
    expiresAt: number;
  }): Promise<McpOAuthAttemptRecord>;
  consumeAttempt(stateHash: string, now: number): Promise<McpOAuthAttemptRecord | null>;
  hasActiveAttempt(agentKey: string, serverName: string, now: number): Promise<boolean>;
};

function decrypt(crypto: CredentialCrypto, value: McpOAuthConnectionRecord["encryptedState"]): string {
  return crypto.decrypt({
    valueCiphertext: value.ciphertext,
    valueIv: value.iv,
    valueTag: value.tag,
    keyVersion: value.keyVersion,
  });
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

function decryptConnection(record: McpOAuthConnectionRecord, crypto: CredentialCrypto): DecryptedMcpOAuthConnection {
  const {encryptedState, ...metadata} = record;
  return {...metadata, state: parseState(decrypt(crypto, encryptedState))};
}

function jsonState(state: McpOAuthConnectionState): JsonObject {
  const value = JSON.parse(JSON.stringify(state)) as unknown;
  if (!isJsonObject(value)) throw new Error("MCP OAuth state must be a JSON object.");
  return value;
}

export class McpOAuthService {
  constructor(private readonly options: {store: OAuthStore; crypto: CredentialCrypto}) {}

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
    const encryptedState = this.options.crypto.encrypt(JSON.stringify(jsonState(input.state)));
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
    await this.options.store.createAttempt({
      stateHash: hashOpaqueToken(input.rawState),
      agentKey: input.agentKey,
      serverName: input.serverName,
      encryptedVerifier: this.options.crypto.encrypt(input.codeVerifier),
      initiator: input.initiator,
      expiresAt: input.expiresAt,
    });
  }

  async consumeAttempt(rawState: string, now = Date.now()): Promise<DecryptedMcpOAuthAttempt | null> {
    const record = await this.options.store.consumeAttempt(hashOpaqueToken(rawState), now);
    if (!record) return null;
    const {encryptedVerifier, ...metadata} = record;
    return {...metadata, codeVerifier: decrypt(this.options.crypto, encryptedVerifier)};
  }

  hasActiveAttempt(agentKey: string, serverName: string, now = Date.now()): Promise<boolean> {
    return this.options.store.hasActiveAttempt(agentKey, serverName, now);
  }
}
