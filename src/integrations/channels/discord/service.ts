import type {Pool} from "pg";

import {
  discardStagedMediaDescriptors,
  FileSystemMediaStore,
} from "../../../domain/channels/media-store.js";
import {ChannelActionWorker} from "../../../domain/channels/actions/worker.js";
import {PostgresChannelActionStore} from "../../../domain/channels/actions/postgres.js";
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
import {deriveRuntimeRequestIngressIdempotencyKey} from "../../../domain/threads/requests/ordering-key.js";
import {LiveVoiceRepo} from "../../../domain/live-voice/repo.js";
import {PostgresThreadRuntimeStore} from "../../../domain/threads/runtime/postgres.js";
import {runCleanupSteps} from "../../../lib/cleanup.js";
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
  type DiscordMediaEventIdentity,
  ingestDiscordMessageCreate,
} from "./message-ingestion.js";
import {
  downloadDiscordSupportedAttachments,
  downloadDiscordSupportedEmbeds,
  downloadDiscordSupportedStickers,
  type DiscordAttachmentDownloadResult,
} from "./media.js";
import {createDiscordOutboundAdapter} from "./outbound.js";
import {sendDiscordStickerAction} from "./stickers.js";
import {DiscordVoiceControlRepo} from "./voice-postgres.js";
import {DiscordVoiceControlWorker, DiscordVoiceSessionManager} from "./voice-manager.js";
import type {DiscordGatewayAdapterCreator} from "@discordjs/voice";
import type {DiscordVoiceGatewayHealth} from "./voice-transport-health.js";
import {
  startConnectorWorkerRuntime,
  stopConnectorWorkerRuntime,
  type ConnectorDaemonRuntimeHandle,
  type ConnectorWorkerRuntimeHandle,
} from "../worker-runtime.js";

type DiscordPostgresPool = Pool & PgPoolLike<PgListenClient>;

export interface DiscordServiceOptions {
  accountKey: string;
  dataDir: string;
  runtime: ConnectorDaemonRuntimeHandle;
  dependencies?: DiscordServiceDependencies;
  onBoundMessage?: DiscordBoundMessageHandler;
}

export interface DiscordWorkerStores {
  connectorLeases: PostgresConnectorLeaseRepo;
  connectorStore: PostgresConnectorAccountStore;
  conversationRepo: ConversationRepo;
  channelActions: PostgresChannelActionStore;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  mediaStore: FileSystemMediaStore;
  pool: DiscordPostgresPool;
  runtimeRequests: RuntimeRequestRepo;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  voiceControls?: DiscordVoiceControlRepo;
  liveVoice?: LiveVoiceRepo;
}

export interface DiscordServiceGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  createVoiceAdapterCreator?(guildId: string): DiscordGatewayAdapterCreator;
  getHealthSnapshot?(): DiscordVoiceGatewayHealth;
}

export interface DiscordServiceVoiceWorker {start(): Promise<void>; stop(): Promise<void>; triggerDrain(): Promise<void>}

export interface DiscordServiceOutboundWorker {
  start(options?: {subscribeToNotifications?: boolean}): Promise<void>;
  stop(): Promise<void>;
  triggerDrain(): Promise<void>;
}

export type DiscordServiceActionWorker = DiscordServiceOutboundWorker;

export interface DiscordServiceDependencies {
  acquireLease?: (options: AcquireManagedConnectorLeaseOptions) => Promise<ManagedConnectorLease>;
  createChannelResolver?: (options: {
    botToken: string;
    client: Pick<DiscordWorkerRestClient, "getChannelMetadata">;
  }) => DiscordChannelResolver;
  createActionWorker?: (options: {
    botToken: string;
    client: Pick<DiscordWorkerRestClient, "createMessage">;
    connectorKey: string;
    store: PostgresChannelActionStore;
  }) => DiscordServiceActionWorker;
  createGateway?: (options: DiscordGatewayClientOptions) => DiscordServiceGateway;
  createOutboundWorker?: (options: {
    adapter: ChannelOutboundAdapter;
    connectorKey: string;
    store: PostgresOutboundDeliveryStore;
  }) => DiscordServiceOutboundWorker;
  createRestClient?: () => DiscordWorkerRestClient;
  createStores?: (pool: DiscordPostgresPool) => DiscordWorkerStores;
  createVoiceWorker?: (options: {
    botToken: string;
    connectorKey: string;
    gateway: DiscordServiceGateway;
    restClient: Pick<DiscordWorkerRestClient, "getChannelMetadata">;
    stores: DiscordWorkerStores;
    log(event: string, payload: Record<string, unknown>): void;
  }) => DiscordServiceVoiceWorker;
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

export function createDiscordWorkerStores(pool: DiscordPostgresPool, dataDir: string): DiscordWorkerStores {
  const runtimeRequests = new RuntimeRequestRepo({pool});
  const stores: DiscordWorkerStores = {
    connectorLeases: new PostgresConnectorLeaseRepo({pool}),
    connectorStore: new PostgresConnectorAccountStore({pool}),
    conversationRepo: new ConversationRepo({pool}),
    channelActions: new PostgresChannelActionStore({pool}),
    outboundDeliveries: new PostgresOutboundDeliveryStore({pool}),
    mediaStore: new FileSystemMediaStore({rootDir: dataDir}),
    pool,
    runtimeRequests,
    sessionStore: new PostgresSessionStore({pool}),
    threadStore: new PostgresThreadRuntimeStore({pool}),
    voiceControls: new DiscordVoiceControlRepo({pool}),
    liveVoice: new LiveVoiceRepo({pool}),
  };
  return stores;
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

function createDefaultActionWorker(options: {
  botToken: string;
  client: Pick<DiscordWorkerRestClient, "createMessage">;
  connectorKey: string;
  store: PostgresChannelActionStore;
  onError: (error: unknown, actionId?: string) => void;
}): DiscordServiceActionWorker {
  return new ChannelActionWorker({
    store: options.store,
    lookup: {
      channel: DISCORD_SOURCE,
      connectorKey: options.connectorKey,
    },
    dispatch: async (action) => {
      if (action.kind !== "discord_sticker_send") {
        throw new Error(`Unsupported Discord channel action ${action.kind}.`);
      }
      await sendDiscordStickerAction(action.payload, {
        botToken: options.botToken,
        client: options.client,
      });
    },
    onError: options.onError,
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
    }, {idempotencyKey: deriveRuntimeRequestIngressIdempotencyKey({
      kind: "discord_message",
      connectorKey: message.requestPayload.connectorKey,
      externalEventScope: message.requestPayload.externalConversationId,
      externalEventId: message.requestPayload.externalMessageId,
    })});
    if (request.status === "completed" || request.status === "failed") {
      await discardStagedMediaDescriptors(message.requestPayload.media);
    }
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
      mediaCount: message.requestPayload.media.length,
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
  private readonly runtime: ConnectorDaemonRuntimeHandle;
  private readonly dependencies: DiscordServiceDependencies;
  private readonly onBoundMessage?: DiscordBoundMessageHandler;
  private readonly stores: DiscordWorkerStores;
  private botTokenForRedaction: string | null = null;
  private gateway: DiscordServiceGateway | null = null;
  private workerRuntime: ConnectorWorkerRuntimeHandle<DiscordServiceOutboundWorker, DiscordServiceActionWorker> | null = null;
  private runStopPromise: Promise<void> | null = null;
  private resolveRunStop: (() => void) | null = null;
  private voiceWorker: DiscordServiceVoiceWorker | null = null;
  private stopping = false;

  constructor(options: DiscordServiceOptions) {
    this.accountKey = options.accountKey;
    this.runtime = options.runtime;
    this.dependencies = options.dependencies ?? {};
    this.onBoundMessage = options.onBoundMessage;
    const pool = options.runtime.pool as DiscordPostgresPool;
    this.stores = this.dependencies.createStores
      ? this.dependencies.createStores(pool)
      : createDiscordWorkerStores(pool, options.dataDir);
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

  private createActionWorker(input: {
    botToken: string;
    connectorKey: string;
    restClient: Pick<DiscordWorkerRestClient, "createMessage">;
    stores: DiscordWorkerStores;
  }): DiscordServiceActionWorker {
    return (this.dependencies.createActionWorker ?? ((options) => createDefaultActionWorker({
      ...options,
      onError: (error, actionId) => {
        this.log("channel_action_failed", {
          connectorKey: input.connectorKey,
          actionId: actionId ?? null,
          message: errorMessage(error, this.botTokenForRedaction),
        });
      },
    })))(
      {
        botToken: input.botToken,
        client: input.restClient,
        connectorKey: input.connectorKey,
        store: input.stores.channelActions,
      },
    );
  }

  private async downloadSupportedAttachments(
    attachments: unknown,
    stores: DiscordWorkerStores,
    connectorKey: string,
    identity: DiscordMediaEventIdentity,
  ): Promise<DiscordAttachmentDownloadResult> {
    return downloadDiscordSupportedAttachments(attachments, {
      connectorKey,
      mediaStore: stores.mediaStore,
      ...identity,
      onUnavailable: (item) => {
        this.log("media_download_skipped", {
          connectorKey,
          attachmentId: item.id,
          contentType: item.contentType ?? null,
          sizeBytes: item.sizeBytes ?? null,
          reason: item.reason,
          httpStatus: item.httpStatus ?? null,
          attempts: item.attempts.map((attempt) => ({
            candidate: attempt.candidate,
            reason: attempt.reason,
            httpStatus: attempt.httpStatus ?? null,
          })),
        });
      },
    });
  }

  private createGateway(input: {
    botToken: string;
    connectorKey: string;
    restClient: Pick<DiscordWorkerRestClient, "getChannelMetadata" | "getGatewayBot">;
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
      fetchGatewayInformation: async () => {
        if (!input.restClient.getGatewayBot) throw new Error("Discord REST adapter does not support Gateway discovery.");
        return input.restClient.getGatewayBot(input.botToken);
      },
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
          downloadAttachments: (attachments, identity) => this.downloadSupportedAttachments(
            attachments,
            input.stores,
            input.connectorKey,
            identity,
          ),
          downloadEmbeds: (embeds, identity) => downloadDiscordSupportedEmbeds(embeds, {
            connectorKey: input.connectorKey,
            mediaStore: input.stores.mediaStore,
            ...identity,
          }),
          downloadStickers: (stickerItems, identity) => downloadDiscordSupportedStickers(stickerItems, {
            connectorKey: input.connectorKey,
            mediaStore: input.stores.mediaStore,
            ...identity,
          }),
          log: (event, eventPayload) => this.log(event, eventPayload),
          onBoundMessage,
          resolveParentChannelId: (actualChannelId) => channelResolver.resolveParentChannelId(actualChannelId),
        });
      },
    });
  }

  async start(): Promise<void> {
    if (this.gateway || this.workerRuntime) {
      return;
    }

    this.stopping = false;
    this.createStopWaiter();

    try {
      const stores = this.stores;
      const poolConfig = this.runtime.poolConfig;
      const account = await this.loadEnabledAccount(stores);
      const botToken = await this.loadBotToken(stores, account);
      const restClient = (this.dependencies.createRestClient ?? createDiscordRestClient)();
      await this.validateBotIdentity(restClient, botToken, account);

      const outboundWorker = this.createOutboundWorker({
        botToken,
        connectorKey: account.connectorKey,
        restClient,
        stores,
      });
      const actionWorker = this.createActionWorker({
        botToken,
        connectorKey: account.connectorKey,
        restClient,
        stores,
      });
      this.workerRuntime = await startConnectorWorkerRuntime({
        acquireLease: () => this.acquireConnectorLease(stores, account.connectorKey),
        outboundWorker,
        actionWorker,
        connectorKey: account.connectorKey,
        notificationRouter: this.runtime.notifications,
        additionalNotificationTargets: {
          discord_voice: {
            triggerDrain: async () => this.voiceWorker?.triggerDrain(),
          },
        },
        onCleanupError: (step, cleanupError) => {
          this.log("worker_cleanup_failed", {
            accountKey: this.accountKey,
            step: step.label,
            message: errorMessage(cleanupError, this.botTokenForRedaction),
          });
        },
      });
      this.gateway = this.createGateway({
        botToken,
        connectorKey: account.connectorKey,
        restClient,
        stores,
      });
      await this.gateway.start();
      if (process.env.PANDA_DISCORD_VOICE_EXPERIMENTAL?.trim().toLowerCase() === "true") {
        const gateway = this.gateway;
        if (!gateway.createVoiceAdapterCreator) throw new Error("Discord Gateway voice adapter is unavailable.");
        if (!stores.voiceControls || !stores.liveVoice) throw new Error("Discord voice repositories are unavailable.");
        this.voiceWorker = this.dependencies.createVoiceWorker?.({
          botToken,
          connectorKey: account.connectorKey,
          gateway,
          restClient,
          stores,
          log: (event, payload) => this.log(event, payload),
        }) ?? new DiscordVoiceControlWorker({
          connectorKey: account.connectorKey,
          controls: stores.voiceControls,
          manager: new DiscordVoiceSessionManager({
            connectorKey: account.connectorKey,
            botToken,
            env: process.env,
            gatewayAdapter: (guildId) => gateway.createVoiceAdapterCreator!(guildId),
            restClient,
            controls: stores.voiceControls,
            voice: stores.liveVoice,
            getInfrastructureHealth: () => ({
              ...(gateway.getHealthSnapshot ? {gateway: gateway.getHealthSnapshot()} : {}),
              listener: this.runtime.getNotificationSnapshot(),
              pool: {
                max: poolConfig.max,
                totalCount: stores.pool.totalCount,
                idleCount: stores.pool.idleCount,
                waitingCount: stores.pool.waitingCount,
              },
            }),
            log: (event, payload) => this.log(event, payload),
          }),
          log: (event, payload) => this.log(event, payload),
        });
        await this.voiceWorker.start();
      }
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
    const workerRuntime = this.workerRuntime;
    const voiceWorker = this.voiceWorker;
    this.gateway = null;
    this.workerRuntime = null;
    this.voiceWorker = null;

    await runCleanupSteps([
      {
        label: "voice-worker",
        run: async () => { await voiceWorker?.stop(); },
      },
      {
        label: "gateway",
        run: async () => {
          await gateway?.stop();
        },
      },
      {
        label: "worker-runtime",
        run: async () => {
          await stopConnectorWorkerRuntime(workerRuntime, (step, cleanupError) => {
            this.log("worker_cleanup_failed", {
              accountKey: this.accountKey,
              step: step.label,
              message: errorMessage(cleanupError, this.botTokenForRedaction),
            });
          });
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
