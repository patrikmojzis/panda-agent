import {
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {isLoopbackHttpHostname} from "../../lib/http.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {generateOpaqueToken} from "../../lib/opaque-tokens.js";
import type {McpHttpOAuthAuth} from "../../domain/mcp/types.js";
import type {McpOAuthManualClientInput, McpOAuthDiscoverySummary, McpOAuthConnectionState, McpOAuthInitiator} from "../../domain/mcp/oauth-types.js";
import {MCP_OAUTH_ATTEMPT_TTL_MS, MCP_OAUTH_STATE_VERSION} from "../../domain/mcp/oauth-types.js";
import type {McpOAuthService} from "../../domain/mcp/oauth-service.js";

const OAUTH_RESPONSE_MAX_BYTES = 1024 * 1024;

export class McpOAuthOriginError extends Error {
  constructor(readonly origin: string) {
    super("MCP OAuth endpoint origin is not trusted.");
    this.name = "McpOAuthOriginError";
  }
}

export class McpOAuthAuthorizationRequiredError extends Error {
  constructor() {
    super("MCP OAuth authorization is required.");
    this.name = "McpOAuthAuthorizationRequiredError";
  }
}

function assertSecureOAuthUrl(url: URL): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHttpHostname(url.hostname)) return;
  throw new Error("MCP OAuth endpoints must use HTTPS except on loopback hosts.");
}

function boundedBody(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  let bytes = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > OAUTH_RESPONSE_MAX_BYTES) {
        controller.error(new Error("MCP OAuth response exceeded the byte limit."));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

/** Creates a redirect-free OAuth fetch restricted to operator-approved origins. */
export function createMcpOAuthFetch(input: {
  serverUrl: string;
  trustedOrigins?: readonly string[];
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}): typeof fetch {
  const server = new URL(input.serverUrl);
  assertSecureOAuthUrl(server);
  const allowed = new Set([server.origin, ...(input.trustedOrigins ?? [])]);
  return async (requestInput, init = {}) => {
    const request = new Request(requestInput, init);
    const url = new URL(request.url);
    assertSecureOAuthUrl(url);
    if (!allowed.has(url.origin)) throw new McpOAuthOriginError(url.origin);
    const boundarySignal = input.signal ?? AbortSignal.timeout(30_000);
    const signal = request.signal
      ? AbortSignal.any([boundarySignal, request.signal])
      : boundarySignal;
    const response = await (input.fetchFn ?? fetch)(request, {redirect: "manual", signal});
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("MCP OAuth endpoint redirects are not allowed for server-side requests.");
    }
    return new Response(boundedBody(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function defaultResourceMetadataUrl(serverUrl: string): string {
  const server = new URL(serverUrl);
  const suffix = server.pathname === "/" ? "" : server.pathname.replace(/\/$/, "");
  return new URL(`/.well-known/oauth-protected-resource${suffix}`, server.origin).toString();
}

function endpointOrigins(metadata: Record<string, unknown>): string[] {
  const keys = ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"];
  return keys.flatMap((key) => {
    const value = metadata[key];
    if (typeof value !== "string") return [];
    try {
      return [new URL(value).origin];
    } catch {
      return [];
    }
  });
}

export async function discoverMcpOAuth(input: {
  serverUrl: string;
  auth: McpHttpOAuthAuth;
  fetchFn?: typeof fetch;
}): Promise<McpOAuthDiscoverySummary> {
  const server = new URL(input.serverUrl);
  const trusted = new Set([server.origin, ...(input.auth.trustedOrigins ?? [])]);
  const policyFetch = createMcpOAuthFetch({serverUrl: input.serverUrl, trustedOrigins: input.auth.trustedOrigins, fetchFn: input.fetchFn});
  const resourceMetadataUrl = defaultResourceMetadataUrl(input.serverUrl);
  const resourceMetadata = await discoverOAuthProtectedResourceMetadata(input.serverUrl, {resourceMetadataUrl}, policyFetch);
  const authorizationServer = resourceMetadata.authorization_servers?.[0] ?? server.origin;
  const authorizationOrigin = new URL(authorizationServer).origin;
  if (!trusted.has(authorizationOrigin)) {
    return {
      resource: resourceMetadata.resource,
      resourceMetadataUrl,
      authorizationServer,
      supportedScopes: [...(resourceMetadata.scopes_supported ?? [])],
      registrationEndpointAvailable: false,
      tokenEndpointAuthMethods: [],
      blockedOrigins: [authorizationOrigin],
    };
  }
  const metadata = await discoverAuthorizationServerMetadata(authorizationServer, {fetchFn: policyFetch});
  if (!metadata) throw new Error("MCP OAuth authorization server metadata is unavailable.");
  const blockedOrigins = [...new Set(endpointOrigins(metadata as unknown as Record<string, unknown>).filter((origin) => !trusted.has(origin)))];
  return {
    resource: resourceMetadata.resource,
    resourceMetadataUrl,
    authorizationServer,
    supportedScopes: [...(resourceMetadata.scopes_supported ?? metadata.scopes_supported ?? [])],
    registrationEndpointAvailable: Boolean(metadata.registration_endpoint),
    tokenEndpointAuthMethods: [...(metadata.token_endpoint_auth_methods_supported ?? [])],
    blockedOrigins,
  };
}

function asJsonObject(value: unknown, label: string): JsonObject {
  const json = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isJsonObject(json)) throw new Error(`${label} must serialize to a JSON object.`);
  return json;
}

function parseClientInformation(value: JsonObject | undefined): OAuthClientInformationMixed | undefined {
  if (!value) return undefined;
  const full = OAuthClientInformationFullSchema.safeParse(value);
  if (full.success) return full.data;
  const basic = OAuthClientInformationSchema.safeParse(value);
  if (basic.success) return basic.data;
  throw new Error("Stored MCP OAuth client information is invalid.");
}

function parseTokens(value: JsonObject | undefined): OAuthTokens | undefined {
  if (!value) return undefined;
  const parsed = OAuthTokensSchema.safeParse(value);
  if (!parsed.success) throw new Error("Stored MCP OAuth tokens are invalid.");
  return parsed.data;
}

function scopeString(config: McpHttpOAuthAuth): string | undefined {
  return config.scope.mode === "explicit" ? config.scope.values.join(" ") : undefined;
}

export interface McpOAuthProviderSessionOptions {
  service: McpOAuthService;
  agentKey: string;
  serverName: string;
  serverUrl: string;
  authConfig: McpHttpOAuthAuth;
  redirectUrl: string;
  rawState?: string;
  codeVerifier?: string;
}

export class McpOAuthProviderSession {
  private connection!: Awaited<ReturnType<McpOAuthService["getConnection"]>>;
  private codeVerifierValue?: string;
  private authorizationUrlValue?: URL;
  readonly provider!: OAuthClientProvider;

  private constructor(private readonly options: McpOAuthProviderSessionOptions) {
    this.codeVerifierValue = options.codeVerifier;
    const baseProvider: OAuthClientProvider = {
      redirectUrl: options.redirectUrl,
      clientMetadata: this.clientMetadata(),
      state: options.rawState ? () => options.rawState! : undefined,
      clientInformation: () => parseClientInformation(this.connection?.state.clientInformation),
      tokens: () => parseTokens(this.connection?.state.tokens),
      saveTokens: (tokens) => this.patchState(
        {tokens: asJsonObject(tokens, "MCP OAuth tokens"), reauthorizationRequired: false},
        {authorizedAt: Date.now()},
        true,
      ),
      redirectToAuthorization: (url) => { this.authorizationUrlValue = new URL(url); },
      saveCodeVerifier: (verifier) => { this.codeVerifierValue = verifier; },
      codeVerifier: () => {
        if (!this.codeVerifierValue) throw new Error("MCP OAuth PKCE verifier is unavailable.");
        return this.codeVerifierValue;
      },
      saveDiscoveryState: (state) => this.patchState({discoveryState: asJsonObject(state, "MCP OAuth discovery state")}, {
        resourceUrl: state.resourceMetadata?.resource,
        authorizationServerUrl: state.authorizationServerUrl,
      }),
      discoveryState: () => this.connection?.state.discoveryState as unknown as OAuthDiscoveryState | undefined,
      invalidateCredentials: (target) => this.invalidate(target),
    };
    this.provider = options.authConfig.registration.mode === "dynamic"
      ? {...baseProvider, saveClientInformation: (information) => this.patchState({clientInformation: asJsonObject(information, "MCP OAuth client information")})}
      : baseProvider;
  }

  static async create(options: McpOAuthProviderSessionOptions): Promise<McpOAuthProviderSession> {
    const session = new McpOAuthProviderSession(options);
    session.connection = await options.service.getConnection(options.agentKey, options.serverName);
    if (!session.connection) {
      session.connection = await options.service.saveConnection({
        agentKey: options.agentKey,
        serverName: options.serverName,
        expectedVersion: null,
        state: {version: MCP_OAUTH_STATE_VERSION},
      });
      if (!session.connection) session.connection = await options.service.getConnection(options.agentKey, options.serverName);
    }
    if (!session.connection) throw new Error("MCP OAuth connection could not be initialized.");
    return session;
  }

  private clientMetadata(): OAuthClientMetadata {
    const scope = scopeString(this.options.authConfig);
    return {
      redirect_uris: [this.options.redirectUrl],
      client_name: `Panda MCP (${this.options.serverName})`,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(scope ? {scope} : {}),
    };
  }

  async setManualClient(input: McpOAuthManualClientInput): Promise<void> {
    if (this.options.authConfig.registration.mode !== "manual") throw new Error("Manual OAuth client information is not accepted for dynamic registration.");
    await this.patchState({clientInformation: asJsonObject({
      client_id: input.clientId,
      ...(input.clientSecret ? {client_secret: input.clientSecret} : {}),
      redirect_uris: [this.options.redirectUrl],
      token_endpoint_auth_method: input.tokenEndpointAuthMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: `Panda MCP (${this.options.serverName})`,
    }, "MCP OAuth manual client information")});
  }

  requireClientInformation(): void {
    if (!parseClientInformation(this.connection?.state.clientInformation)) throw new McpOAuthAuthorizationRequiredError();
  }

  requireTokens(): void {
    if (!parseTokens(this.connection?.state.tokens)) throw new McpOAuthAuthorizationRequiredError();
  }

  async reload(): Promise<void> {
    this.connection = await this.options.service.getConnection(this.options.agentKey, this.options.serverName);
    this.requireClientInformation();
    this.requireTokens();
  }

  async markReauthorizationRequired(preserveConcurrentWinner = false): Promise<void> {
    if (preserveConcurrentWinner) {
      const current = this.connection;
      if (!current) return;
      const state = {...current.state, reauthorizationRequired: true};
      delete state.tokens;
      const next = await this.options.service.saveConnection({
        agentKey: this.options.agentKey,
        serverName: this.options.serverName,
        expectedVersion: current.version,
        state,
        resourceUrl: current.resourceUrl,
        authorizationServerUrl: current.authorizationServerUrl,
        authorizedAt: current.authorizedAt,
      });
      this.connection = next ?? await this.options.service.getConnection(this.options.agentKey, this.options.serverName);
      return;
    }
    await this.invalidate("tokens");
  }

  async invalidateConfiguration(resetClient: boolean): Promise<void> {
    await this.invalidate(resetClient ? "all" : "tokens");
  }

  async disconnect(): Promise<void> {
    const state = {...this.connection!.state, reauthorizationRequired: false};
    delete state.tokens;
    await this.replaceState(state);
  }

  async revokeAndDisconnect(fetchFn?: typeof fetch): Promise<"succeeded" | "failed" | "unsupported"> {
    const tokens = parseTokens(this.connection?.state.tokens);
    const client = parseClientInformation(this.connection?.state.clientInformation);
    const discovery = this.connection?.state.discoveryState as unknown as OAuthDiscoveryState | undefined;
    const metadata = discovery?.authorizationServerMetadata as unknown as Record<string, unknown> | undefined;
    const endpoint = typeof metadata?.revocation_endpoint === "string" ? metadata.revocation_endpoint : undefined;
    if (!tokens || !client || !endpoint) {
      await this.disconnect();
      return endpoint ? "succeeded" : "unsupported";
    }
    let outcome: "succeeded" | "failed" = "succeeded";
    const policyFetch = createMcpOAuthFetch({serverUrl: this.options.serverUrl, trustedOrigins: this.options.authConfig.trustedOrigins, fetchFn});
    const full = client as OAuthClientInformationMixed & {token_endpoint_auth_method?: string};
    const method = full.token_endpoint_auth_method
      ?? (full.client_secret ? "client_secret_basic" : "none");
    for (const [token, hint] of [[tokens.refresh_token, "refresh_token"], [tokens.access_token, "access_token"]] as const) {
      if (!token) continue;
      const params = new URLSearchParams({token, token_type_hint: hint, client_id: full.client_id});
      const headers = new Headers({"content-type": "application/x-www-form-urlencoded"});
      if (method === "client_secret_basic" && full.client_secret) {
        headers.set("authorization", `Basic ${Buffer.from(`${full.client_id}:${full.client_secret}`, "utf8").toString("base64")}`);
        params.delete("client_id");
      } else if (method === "client_secret_post" && full.client_secret) {
        params.set("client_secret", full.client_secret);
      }
      try {
        const response = await policyFetch(endpoint, {method: "POST", headers, body: params});
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) outcome = "failed";
      } catch {
        outcome = "failed";
      }
    }
    await this.disconnect();
    return outcome;
  }

  authorizationUrl(): URL {
    if (!this.authorizationUrlValue) throw new Error("MCP OAuth authorization URL was not produced.");
    return this.authorizationUrlValue;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) throw new Error("MCP OAuth PKCE verifier was not produced.");
    return this.codeVerifierValue;
  }

  private async patchState(
    patch: Partial<McpOAuthConnectionState>,
    metadata: {resourceUrl?: string; authorizationServerUrl?: string; authorizedAt?: number} = {},
    acceptConcurrentTokens = false,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = this.connection ?? await this.options.service.getConnection(this.options.agentKey, this.options.serverName);
      const next = await this.options.service.saveConnection({
        agentKey: this.options.agentKey,
        serverName: this.options.serverName,
        expectedVersion: current?.version ?? null,
        state: {...current?.state ?? {version: MCP_OAUTH_STATE_VERSION}, ...patch},
        resourceUrl: metadata.resourceUrl ?? current?.resourceUrl,
        authorizationServerUrl: metadata.authorizationServerUrl ?? current?.authorizationServerUrl,
        authorizedAt: metadata.authorizedAt ?? current?.authorizedAt,
      });
      if (next) {
        this.connection = next;
        return;
      }
      this.connection = await this.options.service.getConnection(this.options.agentKey, this.options.serverName);
      if (acceptConcurrentTokens && this.connection?.state.tokens) return;
    }
    throw new Error("MCP OAuth connection changed concurrently.");
  }

  private async replaceState(
    state: McpOAuthConnectionState,
    metadata: {resourceUrl?: string; authorizationServerUrl?: string; authorizedAt?: number; clearDiscoveryMetadata?: boolean} = {},
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = this.connection ?? await this.options.service.getConnection(this.options.agentKey, this.options.serverName);
      const next = await this.options.service.saveConnection({
        agentKey: this.options.agentKey,
        serverName: this.options.serverName,
        expectedVersion: current?.version ?? null,
        state,
        resourceUrl: metadata.clearDiscoveryMetadata ? undefined : metadata.resourceUrl ?? current?.resourceUrl,
        authorizationServerUrl: metadata.clearDiscoveryMetadata ? undefined : metadata.authorizationServerUrl ?? current?.authorizationServerUrl,
        authorizedAt: metadata.authorizedAt ?? current?.authorizedAt,
      });
      if (next) {
        this.connection = next;
        return;
      }
      this.connection = await this.options.service.getConnection(this.options.agentKey, this.options.serverName);
    }
    throw new Error("MCP OAuth connection changed concurrently.");
  }

  private async invalidate(target: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (target === "verifier") {
      this.codeVerifierValue = undefined;
      return;
    }
    const state = {...this.connection!.state};
    if (target === "all" || target === "client") delete state.clientInformation;
    if (target === "all" || target === "tokens") delete state.tokens;
    if (target === "all" || target === "discovery") delete state.discoveryState;
    if (target === "all" || target === "tokens") state.reauthorizationRequired = true;
    await this.replaceState(state, target === "all" ? {clearDiscoveryMetadata: true} : {});
  }
}

export async function startMcpOAuthAuthorization(input: McpOAuthProviderSessionOptions & {
  manualClient?: McpOAuthManualClientInput;
  initiator: McpOAuthInitiator;
  now?: number;
  fetchFn?: typeof fetch;
}): Promise<{authorizationUrl: string; expiresAt: number}> {
  const session = await McpOAuthProviderSession.create(input);
  if (input.authConfig.registration.mode === "manual") {
    if (input.manualClient) await session.setManualClient(input.manualClient);
    session.requireClientInformation();
  }
  const policyFetch = createMcpOAuthFetch({serverUrl: input.serverUrl, trustedOrigins: input.authConfig.trustedOrigins, fetchFn: input.fetchFn});
  const result = await auth(session.provider, {serverUrl: input.serverUrl, scope: scopeString(input.authConfig), fetchFn: policyFetch});
  if (result !== "REDIRECT" || !input.rawState) throw new Error("MCP OAuth authorization did not produce a redirect.");
  const expiresAt = (input.now ?? Date.now()) + MCP_OAUTH_ATTEMPT_TTL_MS;
  await input.service.createAttempt({
    rawState: input.rawState,
    codeVerifier: session.codeVerifier(),
    agentKey: input.agentKey,
    serverName: input.serverName,
    initiator: input.initiator,
    expiresAt,
  });
  return {authorizationUrl: session.authorizationUrl().toString(), expiresAt};
}

export async function finishMcpOAuthAuthorization(input: Omit<McpOAuthProviderSessionOptions, "rawState" | "codeVerifier"> & {
  authorizationCode: string;
  codeVerifier: string;
  fetchFn?: typeof fetch;
}): Promise<void> {
  const session = await McpOAuthProviderSession.create({...input, codeVerifier: input.codeVerifier});
  session.requireClientInformation();
  const policyFetch = createMcpOAuthFetch({serverUrl: input.serverUrl, trustedOrigins: input.authConfig.trustedOrigins, fetchFn: input.fetchFn});
  const result = await auth(session.provider, {
    serverUrl: input.serverUrl,
    authorizationCode: input.authorizationCode,
    scope: scopeString(input.authConfig),
    fetchFn: policyFetch,
  });
  if (result !== "AUTHORIZED") throw new Error("MCP OAuth authorization code exchange did not complete.");
}

export function newMcpOAuthState(): string {
  return generateOpaqueToken("mcp_oauth_state");
}

export interface McpOAuthRuntimeProviderFactory {
  create(input: {
    agentKey: string;
    serverName: string;
    serverUrl: string;
    authConfig: McpHttpOAuthAuth;
  }): Promise<McpOAuthProviderSession>;
  runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export class McpOAuthRuntime implements McpOAuthRuntimeProviderFactory {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly options: {service: McpOAuthService; redirectUrl: string}) {}

  async create(input: {
    agentKey: string;
    serverName: string;
    serverUrl: string;
    authConfig: McpHttpOAuthAuth;
  }): Promise<McpOAuthProviderSession> {
    const session = await McpOAuthProviderSession.create({...input, service: this.options.service, redirectUrl: this.options.redirectUrl});
    session.requireClientInformation();
    session.requireTokens();
    return session;
  }

  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}
