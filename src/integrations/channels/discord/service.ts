import type {Pool} from "pg";

import {ChannelOutboundDeliveryWorker} from "../../../domain/channels/deliveries/worker.js";
import {PostgresOutboundDeliveryStore} from "../../../domain/channels/deliveries/postgres.js";
import type {ChannelOutboundAdapter} from "../../../domain/channels/outbound.js";
import {
  acquireManagedConnectorLease,
  type AcquireManagedConnectorLeaseOptions,
  type ManagedConnectorLease,
  PostgresConnectorLeaseRepo,
} from "../../../domain/connector-leases/repo.js";
import {PostgresConnectorAccountStore} from "../../../domain/connectors/postgres.js";
import type {ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import {resolveCredentialCrypto, type CredentialCrypto} from "../../../domain/credentials/crypto.js";
import {ConversationRepo} from "../../../domain/sessions/conversations/repo.js";
import {PostgresSessionStore} from "../../../domain/sessions/postgres.js";
import {RuntimeRequestRepo} from "../../../domain/threads/requests/repo.js";
import {PostgresThreadRuntimeStore} from "../../../domain/threads/runtime/postgres.js";
import {runCleanupSteps} from "../../../lib/cleanup.js";
import {ensureSchemas} from "../../../lib/postgres-bootstrap.js";
import {
  buildObservedPoolConfig,
  createPostgresPool,
  observePostgresPool,
  type PostgresPoolObserver,
  requireDatabaseUrl,
} from "../../../lib/postgres-database.js";
import type {PgListenClient, PgPoolLike} from "../../../lib/postgres-query.js";
import {createDiscordRestClient, type DiscordCurrentUser, type DiscordWorkerRestClient} from "./api.js";
import {DISCORD_BOT_TOKEN_SECRET_KEY, DISCORD_SOURCE} from "./config.js";
import {
  DiscordChannelResolver,
  DiscordGatewayClient,
  type DiscordGatewayClientOptions,
} from "./gateway.js";
import {
  type DiscordBoundMessageHandler,
  ingestDiscordMessageCreate,
} from "./message-ingestion.js";
import {createDiscordOutboundAdapter} from "./outbound.js";

const DISCORD_POOL_MAX_FALLBACK = 5;

type DiscordPostgresPool = Pool & PgPoolLike<PgListenClient>;

export interface DiscordServiceOptions {
  accountKey: string;
  dbUrl?: string;
  dependencies?: DiscordServiceDependencies;
  onBoundMessage?: DiscordBoundMessageHandler;
  poolMaxFallback?: number;
}

export interface DiscordServicePoolFactoryInput {
  accountKey: string;
  applicationName: string;
  dbUrl?: string;
  max: number;
  idleTimeoutMillis: number;
  acquireTimeoutMillis: number;
}

export interface DiscordWorkerStores {
  connectorLeases: PostgresConnectorLeaseRepo;
  connectorStore: PostgresConnectorAccountStore;
  conversationRepo: ConversationRepo;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  pool: DiscordPostgresPool;
  runtimeRequests: RuntimeRequestRepo;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
}

export interface DiscordServiceGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscordServiceOutboundWorker {
  start(options?: {subscribeToNotifications?: boolean}): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscordServiceDependencies {
  acquireLease?: (options: AcquireManagedConnectorLeaseOptions) => Promise<ManagedConnectorLease>;
  createChannelResolver?: (options: {
    botToken: string;
    client: Pick<DiscordWorkerRestClient, "getChannelMetadata">;
  }) => DiscordChannelResolver;
  createGateway?: (options: DiscordGatewayClientOptions) => DiscordServiceGateway;
  createOutboundWorker?: (options: {
    adapter: ChannelOutboundAdapter;
    connectorKey: string;
    store: PostgresOutboundDeliveryStore;
  }) => DiscordServiceOutboundWorker;
  createPool?: (input: DiscordServicePoolFactoryInput) => DiscordPostgresPool;
  createRestClient?: () => DiscordWorkerRestClient;
  createStores?: (pool: DiscordPostgresPool) => DiscordWorkerStores;
  observePool?: (input: {
    applicationName: string;
    connectorKey?: string;
    max: number;
    idleTimeoutMillis: number;
    pool: DiscordPostgresPool;
  }) => PostgresPoolObserver;
  resolveCrypto?: () => CredentialCrypto | null;
}

function buildSecretRedactionFragments(secret: string): readonly string[] {
  const exact = secret.trim();
  if (!exact) {
    return [];
  }

  const pieces = exact
    .split(/[^A-Za-z0-9]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 8);
  return [...new Set([exact, ...pieces])];
}

function sanitizeSecretMessage(message: string, secret: string | null): string {
  if (!secret) {
    return message;
  }

  let sanitized = message;
  for (const fragment of buildSecretRedactionFragments(secret)) {
    sanitized = sanitized.split(fragment).join("[redacted]");
  }

  return sanitized;
}

function errorMessage(error: unknown, secret: string | null = null): string {
  return sanitizeSecretMessage(error instanceof Error ? error.message : String(error), secret);
}

async function withSecretErrorSafety<T>(secret: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(errorMessage(error, secret));
  }
}

function createDefaultPool(input: DiscordServicePoolFactoryInput): DiscordPostgresPool {
  return createPostgresPool({
    connectionString: requireDatabaseUrl(input.dbUrl),
    applicationName: input.applicationName,
    max: input.max,
    idleTimeoutMillis: input.idleTimeoutMillis,
    connectionTimeoutMillis: input.acquireTimeoutMillis,
  }) as DiscordPostgresPool;
}

function createDefaultStores(pool: DiscordPostgresPool): DiscordWorkerStores {
  return {
    connectorLeases: new PostgresConnectorLeaseRepo({pool}),
    connectorStore: new PostgresConnectorAccountStore({pool}),
    conversationRepo: new ConversationRepo({pool}),
    outboundDeliveries: new PostgresOutboundDeliveryStore({pool}),
    pool,
    runtimeRequests: new RuntimeRequestRepo({pool}),
    sessionStore: new PostgresSessionStore({pool}),
    threadStore: new PostgresThreadRuntimeStore({pool}),
  };
}

function createDefaultOutboundWorker(options: {
  adapter: ChannelOutboundAdapter;
  connectorKey: string;
  store: PostgresOutboundDeliveryStore;
}): DiscordServiceOutboundWorker {
  return new ChannelOutboundDeliveryWorker({
    adapter: options.adapter,
    connectorKey: options.connectorKey,
    store: options.store,
  });
}

function createRuntimeRequestDiscordBoundMessageHandler(input: {
  log: (event: string, payload: Record<string, unknown>) => void;
  requests: RuntimeRequestRepo;
}): DiscordBoundMessageHandler {
  return async (message) => {
    const request = await input.requests.enqueueRequest({
      kind: "discord_message",
      payload: message.requestPayload,
    });
    input.log("message_queued", {
      kind: request.kind,
      requestId: request.id,
      connectorKey: message.route.connectorKey,
      accountKey: message.route.accountKey,
      externalConversationId: message.route.externalConversationId,
      actualChannelId: message.route.actualChannelId,
      threadId: message.route.threadId ?? null,
      guildId: message.route.guildId ?? null,
      externalMessageId: message.route.externalMessageId,
      attachmentCount: message.requestPayload.attachmentSummaries.length,
    });
  };
}

function requireEnabledDiscordAccount(account: ConnectorAccountRecord | null, accountKey: string): ConnectorAccountRecord {
  if (!account) {
    throw new Error(`Unknown Discord account ${accountKey}.`);
  }
  if (account.status !== "enabled") {
    throw new Error(`Discord account ${accountKey} is not enabled.`);
  }

  return account;
}

export class DiscordService {
  private readonly accountKey: string;
  private readonly dbUrl?: string;
  private readonly dependencies: DiscordServiceDependencies;
  private readonly onBoundMessage?: DiscordBoundMessageHandler;
  private readonly poolMaxFallback?: number;
  private botTokenForRedaction: string | null = null;
  private gateway: DiscordServiceGateway | null = null;
  private lease: ManagedConnectorLease | null = null;
  private outboundWorker: DiscordServiceOutboundWorker | null = null;
  private poolObserver: PostgresPoolObserver | null = null;
  private runStopPromise: Promise<void> | null = null;
  private resolveRunStop: (() => void) | null = null;
  private stores: DiscordWorkerStores | null = null;
  private stopping = false;

  constructor(options: DiscordServiceOptions) {
    this.accountKey = options.accountKey;
    this.dbUrl = options.dbUrl;
    this.dependencies = options.dependencies ?? {};
    this.onBoundMessage = options.onBoundMessage;
    this.poolMaxFallback = options.poolMaxFallback;
  }

  private log(event: string, payload: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({
      source: DISCORD_SOURCE,
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    })}\n`);
  }

  private createStopWaiter(): Promise<void> {
    if (!this.runStopPromise) {
      this.runStopPromise = new Promise((resolve) => {
        this.resolveRunStop = resolve;
      });
    }

    return this.runStopPromise;
  }

  private resolveStopWaiter(): void {
    this.resolveRunStop?.();
    this.resolveRunStop = null;
    this.runStopPromise = null;
  }

  private createPoolAndStores(): {
    stores: DiscordWorkerStores;
    poolConfig: ReturnType<typeof buildObservedPoolConfig>;
  } {
    const poolConfig = buildObservedPoolConfig(
      `panda/discord/${this.accountKey}`,
      "PANDA_DISCORD_DB_POOL_MAX",
      this.poolMaxFallback ?? DISCORD_POOL_MAX_FALLBACK,
    );
    const pool = (this.dependencies.createPool ?? createDefaultPool)({
      accountKey: this.accountKey,
      applicationName: poolConfig.applicationName,
      dbUrl: this.dbUrl,
      max: poolConfig.max,
      idleTimeoutMillis: poolConfig.idleTimeoutMillis,
      acquireTimeoutMillis: poolConfig.acquireTimeoutMillis,
    });
    const stores = (this.dependencies.createStores ?? createDefaultStores)(pool);
    this.stores = stores;
    this.poolObserver = (this.dependencies.observePool ?? ((input) => observePostgresPool({
      pool: input.pool,
      applicationName: input.applicationName,
      max: input.max,
      idleTimeoutMillis: input.idleTimeoutMillis,
      log: (event, payload) => this.log(event, {
        ...(input.connectorKey ? {connectorKey: input.connectorKey} : {}),
        ...payload,
      }),
    })))({
      applicationName: poolConfig.applicationName,
      max: poolConfig.max,
      idleTimeoutMillis: poolConfig.idleTimeoutMillis,
      pool: stores.pool,
    });

    return {
      stores,
      poolConfig,
    };
  }

  private async ensureSchemas(stores: DiscordWorkerStores): Promise<void> {
    await ensureSchemas([
      stores.connectorStore,
      stores.sessionStore,
      stores.threadStore,
      stores.conversationRepo,
      stores.outboundDeliveries,
      stores.runtimeRequests,
      stores.connectorLeases,
    ]);
  }

  private async loadEnabledAccount(stores: DiscordWorkerStores): Promise<ConnectorAccountRecord> {
    const account = await stores.connectorStore.getAccountByKey(DISCORD_SOURCE, this.accountKey);
    return requireEnabledDiscordAccount(account, this.accountKey);
  }

  private async loadBotToken(stores: DiscordWorkerStores, account: ConnectorAccountRecord): Promise<string> {
    const crypto = (this.dependencies.resolveCrypto ?? resolveCredentialCrypto)();
    if (!crypto) {
      throw new Error("CREDENTIALS_MASTER_KEY is required for Discord worker.");
    }

    const botToken = await stores.connectorStore.getSecret(account.id, DISCORD_BOT_TOKEN_SECRET_KEY, crypto);
    if (!botToken) {
      throw new Error(`Discord account ${this.accountKey} does not have a stored bot token.`);
    }

    this.botTokenForRedaction = botToken;
    return botToken;
  }

  private async validateBotIdentity(
    client: Pick<DiscordWorkerRestClient, "getCurrentUser">,
    botToken: string,
    account: ConnectorAccountRecord,
  ): Promise<DiscordCurrentUser> {
    const botUser = await withSecretErrorSafety(botToken, () => client.getCurrentUser(botToken));
    if (botUser.id !== account.connectorKey) {
      throw new Error("Stored Discord token identity does not match the connector account.");
    }

    return botUser;
  }

  private async acquireConnectorLease(
    stores: DiscordWorkerStores,
    connectorKey: string,
  ): Promise<ManagedConnectorLease> {
    return (this.dependencies.acquireLease ?? acquireManagedConnectorLease)({
      repo: stores.connectorLeases,
      source: DISCORD_SOURCE,
      connectorKey,
      alreadyHeldMessage: `Discord connector ${connectorKey} is already running.`,
      onError: async (error) => {
        this.log("connector_lease_renew_failed", {
          connectorKey,
          message: errorMessage(error, this.botTokenForRedaction),
        });
      },
      onLeaseLost: async (error) => {
        this.log("connector_lease_lost", {
          connectorKey,
          message: errorMessage(error, this.botTokenForRedaction),
        });
        await this.stop();
      },
    });
  }

  private createOutboundWorker(input: {
    botToken: string;
    connectorKey: string;
    restClient: Pick<DiscordWorkerRestClient, "createMessage">;
    stores: DiscordWorkerStores;
  }): DiscordServiceOutboundWorker {
    const adapter = createDiscordOutboundAdapter({
      botToken: input.botToken,
      client: input.restClient,
      connectorKey: input.connectorKey,
    });

    return (this.dependencies.createOutboundWorker ?? createDefaultOutboundWorker)({
      adapter,
      connectorKey: input.connectorKey,
      store: input.stores.outboundDeliveries,
    });
  }

  private createGateway(input: {
    botToken: string;
    connectorKey: string;
    restClient: Pick<DiscordWorkerRestClient, "getChannelMetadata">;
    stores: DiscordWorkerStores;
  }): DiscordServiceGateway {
    const channelResolver = (this.dependencies.createChannelResolver ?? ((options) => new DiscordChannelResolver(options)))({
      botToken: input.botToken,
      client: input.restClient,
    });
    const onBoundMessage = this.onBoundMessage ?? createRuntimeRequestDiscordBoundMessageHandler({
      log: (event, payload) => this.log(event, payload),
      requests: input.stores.runtimeRequests,
    });

    return (this.dependencies.createGateway ?? ((options) => new DiscordGatewayClient(options)))({
      accountKey: this.accountKey,
      botToken: input.botToken,
      channelResolver,
      connectorKey: input.connectorKey,
      log: (event, payload) => this.log(event, payload),
      onFatal: async (error) => {
        this.log("gateway_fatal", {
          connectorKey: input.connectorKey,
          message: errorMessage(error, this.botTokenForRedaction),
        });
        await this.stop();
      },
      onMessageCreate: async (payload) => {
        await ingestDiscordMessageCreate(payload, {
          accountKey: this.accountKey,
          connectorKey: input.connectorKey,
          conversationRepo: input.stores.conversationRepo,
          log: (event, eventPayload) => this.log(event, eventPayload),
          onBoundMessage,
          resolveParentChannelId: (actualChannelId) => channelResolver.resolveParentChannelId(actualChannelId),
        });
      },
    });
  }

  async start(): Promise<void> {
    if (this.gateway || this.outboundWorker || this.lease) {
      return;
    }

    this.stopping = false;
    this.createStopWaiter();

    try {
      const {stores, poolConfig} = this.createPoolAndStores();
      await this.ensureSchemas(stores);
      const account = await this.loadEnabledAccount(stores);
      const botToken = await this.loadBotToken(stores, account);
      const restClient = (this.dependencies.createRestClient ?? createDiscordRestClient)();
      await this.validateBotIdentity(restClient, botToken, account);

      this.poolObserver?.stop();
      this.poolObserver = (this.dependencies.observePool ?? ((input) => observePostgresPool({
        pool: input.pool,
        applicationName: input.applicationName,
        max: input.max,
        idleTimeoutMillis: input.idleTimeoutMillis,
        log: (event, payload) => this.log(event, {
          ...(input.connectorKey ? {connectorKey: input.connectorKey} : {}),
          ...payload,
        }),
      })))({
        applicationName: poolConfig.applicationName,
        connectorKey: account.connectorKey,
        max: poolConfig.max,
        idleTimeoutMillis: poolConfig.idleTimeoutMillis,
        pool: stores.pool,
      });

      this.lease = await this.acquireConnectorLease(stores, account.connectorKey);
      this.outboundWorker = this.createOutboundWorker({
        botToken,
        connectorKey: account.connectorKey,
        restClient,
        stores,
      });
      await this.outboundWorker.start();
      this.gateway = this.createGateway({
        botToken,
        connectorKey: account.connectorKey,
        restClient,
        stores,
      });
      await this.gateway.start();
      this.log("worker_started", {
        accountKey: this.accountKey,
        connectorKey: account.connectorKey,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async run(): Promise<void> {
    await this.start();
    await this.createStopWaiter();
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    const gateway = this.gateway;
    const outboundWorker = this.outboundWorker;
    const lease = this.lease;
    const stores = this.stores;
    const poolObserver = this.poolObserver;
    this.gateway = null;
    this.outboundWorker = null;
    this.lease = null;
    this.stores = null;
    this.poolObserver = null;

    await runCleanupSteps([
      {
        label: "gateway",
        run: async () => {
          await gateway?.stop();
        },
      },
      {
        label: "outbound-worker",
        run: async () => {
          await outboundWorker?.stop();
        },
      },
      {
        label: "connector-lease",
        run: async () => {
          await lease?.release();
        },
      },
      {
        label: "pool-observer",
        run: () => {
          poolObserver?.stop();
        },
      },
      {
        label: "postgres-pool",
        run: async () => {
          await stores?.pool.end();
        },
      },
    ], (step, error) => {
      this.log("worker_cleanup_failed", {
        accountKey: this.accountKey,
        step: step.label,
        message: errorMessage(error, this.botTokenForRedaction),
      });
    });

    this.botTokenForRedaction = null;
    this.stopping = false;
    this.resolveStopWaiter();
  }
}
