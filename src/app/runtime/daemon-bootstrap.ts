import {A2ASessionBindingRepo} from "../../domain/a2a/repo.js";
import {FileSystemMediaStore} from "../../domain/channels/media-store.js";
import {ChannelTypingDispatcher} from "../../domain/channels/typing.js";
import {PostgresChannelActionStore} from "../../domain/channels/actions/postgres.js";
import {PostgresOutboundDeliveryStore} from "../../domain/channels/deliveries/postgres.js";
import {ChannelOutboundDeliveryWorker} from "../../domain/channels/deliveries/worker.js";
import {PostgresConnectorLeaseRepo} from "../../domain/connector-leases/repo.js";
import {PostgresConnectorAccountStore} from "../../domain/connectors/postgres.js";
import {resolveSecretCrypto} from "../../domain/secrets/crypto.js";
import {PostgresTelegramStickerStore} from "../../domain/agents/telegram-stickers/postgres.js";
import {TelegramStickerLibrary} from "../../domain/agents/telegram-stickers/service.js";
import {HeartbeatRunner} from "../../domain/scheduling/heartbeats/runner.js";
import {
  DEFAULT_SCHEDULED_TASK_CONCURRENCY,
  ScheduledTaskRunner,
} from "../../domain/scheduling/tasks/runner.js";
import {ConversationRepo} from "../../domain/sessions/conversations/repo.js";
import {SessionRouteRepo} from "../../domain/sessions/routes/repo.js";
import {WatchRunner} from "../../domain/watches/runner.js";
import {DEFAULT_RUNTIME_REQUEST_CLAIM_LEASE_MS, RuntimeRequestRepo,} from "../../domain/threads/requests/repo.js";
import {createChannelTypingEventHandler} from "../../domain/threads/runtime/channel-typing.js";
import {A2AMessagingService} from "../../domain/a2a/service.js";
import {createWatchEvaluator} from "../../integrations/watches/evaluator.js";
import {createCommandCatalog, type CommandCatalog} from "../../domain/commands/modules.js";
import type {CommandCatalogModule} from "../../domain/commands/types.js";
import {createRuntime, createThreadDefinition, type RuntimeServices,} from "./create-runtime.js";
import {
  buildDaemonA2ACommandDependencies,
  buildDaemonChannelCommandDependencies,
} from "./command-dependencies.js";
import {resolveVisibleCommandDescriptors} from "./command-visibility.js";
import {DaemonStateRepo} from "./state/repo.js";
import type {DaemonOptions} from "./daemon-shared.js";
import {DEFAULT_DAEMON_KEY} from "./daemon-shared.js";
import {A2A_CONNECTOR_KEY} from "../../domain/a2a/constants.js";
import {resolveA2AMaxMessagesPerHour} from "../../integrations/channels/a2a/config.js";
import {createA2AOutboundAdapter} from "../../integrations/channels/a2a/outbound.js";
import {EMAIL_CONNECTOR_KEY} from "../../domain/email/shared.js";
import {createEmailOutboundAdapter} from "../../integrations/channels/email/outbound.js";
import {EmailSyncRunner} from "../../integrations/channels/email/sync-runner.js";
import {TELEGRAM_SOURCE,} from "../../integrations/channels/telegram/config.js";
import {createTelegramStickerSetReader} from "../../integrations/channels/telegram/sticker-set-reader.js";
import {WHATSAPP_SOURCE} from "../../integrations/channels/whatsapp/config.js";
import {createWhatsAppActorAuthorizer, type WhatsAppActorAuthorizer} from "../../integrations/channels/whatsapp/authorization.js";
import {createDiscordRestClient} from "../../integrations/channels/discord/api.js";
import {createDiscordStickerCatalogReader} from "../../integrations/channels/discord/stickers.js";
import {createDiscordGifService} from "../../integrations/channels/discord/gifs.js";
import {DiscordVoiceControlRepo} from "../../integrations/channels/discord/voice-postgres.js";
import {LiveVoiceRepo} from "../../domain/live-voice/repo.js";
import {createLiveVoiceRuntimeEventHandler} from "../../integrations/voice/request-handler.js";
import {resolveAgentMediaDir, resolveDataDir} from "./data-dir.js";
import {readPositiveIntegerEnv} from "./database.js";
import {trimToNull} from "../../lib/strings.js";
import {FileSystemCommandUploadStore} from "../../integrations/commands/file-uploads.js";
import {resolveRuntimeRequestMediaReceiptOwners} from "./runtime-request-media.js";

interface DaemonContext {
  fallbackContext: {cwd: string};
  daemonKey: string;
  runtime: RuntimeServices;
  a2aBindings: A2ASessionBindingRepo;
  a2aOutboundWorker: ChannelOutboundDeliveryWorker;
  emailOutboundWorker: ChannelOutboundDeliveryWorker;
  emailSyncRunner: EmailSyncRunner;
  conversationBindings: ConversationRepo;
  sessionRoutes: SessionRouteRepo;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  channelActions: PostgresChannelActionStore;
  connectorLeases: PostgresConnectorLeaseRepo;
  requests: RuntimeRequestRepo;
  mediaReceiptJanitor: FileSystemMediaStore;
  daemonState: DaemonStateRepo;
  scheduledTaskRunner: ScheduledTaskRunner;
  watchRunner: WatchRunner;
  sessionHeartbeatRunner: HeartbeatRunner;
  liveVoice: LiveVoiceRepo;
  whatsAppAuthorizer: WhatsAppActorAuthorizer;
  discordVoice: {controls: DiscordVoiceControlRepo; live: LiveVoiceRepo; close(): Promise<void>};
}

function resolveDaemonCommandCatalog(
  options: Pick<DaemonOptions, "commandCatalog" | "commandModules">,
): CommandCatalog<any, CommandCatalogModule<any>> | undefined {
  if (options.commandCatalog && options.commandModules) {
    throw new Error("Pass either commandCatalog or commandModules, not both.");
  }
  if (options.commandCatalog) {
    return options.commandCatalog;
  }
  if (options.commandModules) {
    return createCommandCatalog(options.commandModules);
  }

  return undefined;
}

export async function bootstrapDaemonContext(
  options: DaemonOptions,
): Promise<DaemonContext> {
  const fallbackContext = {
    cwd: options.cwd,
  } as const;
  const daemonKey = DEFAULT_DAEMON_KEY;

  let sessionRoutes!: SessionRouteRepo;
  let outboundDeliveries!: PostgresOutboundDeliveryStore;
  let channelActions!: PostgresChannelActionStore;
  let connectorLeases!: PostgresConnectorLeaseRepo;
  let a2aBindings!: A2ASessionBindingRepo;
  let a2aMessagingService!: A2AMessagingService;
  let liveVoiceForEvents: LiveVoiceRepo | undefined;
  let mediaReceiptJanitor: FileSystemMediaStore | null = null;

  const typingDispatcher = new ChannelTypingDispatcher([
    {
      channel: TELEGRAM_SOURCE,
      send: async (request) => {
        await channelActions.enqueueAction({
          threadId: request.threadId,
          channel: TELEGRAM_SOURCE,
          connectorKey: request.target.connectorKey,
          kind: "typing",
          payload: request,
        });
      },
    },
    {
      channel: WHATSAPP_SOURCE,
      send: async (request) => {
        await channelActions.enqueueAction({
          threadId: request.threadId,
          channel: WHATSAPP_SOURCE,
          connectorKey: request.target.connectorKey,
          kind: "typing",
          payload: request,
        });
      },
    },
  ]);

  const commandCatalog = resolveDaemonCommandCatalog(options);
  const readonlyPostgresCommandAllowed = Boolean(
    trimToNull(options.readOnlyDbUrl) ?? trimToNull(process.env.READONLY_DATABASE_URL),
  );
  const typingEventHandler = createChannelTypingEventHandler(typingDispatcher);
  let voiceEventHandler: ((event: import("../../domain/threads/runtime/coordinator.js").ThreadRuntimeEvent) => Promise<void>) | undefined;
  const runtime = await createRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    cwd: options.cwd,
    maxSubagentDepth: options.maxSubagentDepth,
    ...(commandCatalog ? {commandCatalog} : {}),
    onEvent: async (event) => {
      await typingEventHandler(event);
      try {
        await voiceEventHandler?.(event);
      } catch (error) {
        console.error("Live voice runtime event handling failed", {
          eventType: event.type,
          threadId: event.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    resolveDefinition: async (thread, {agentStore, backgroundJobService, browserService, credentialResolver, executionEnvironments, scheduledTasks, executionEnvironmentResolver, pairedIdentities, sessionStore, subagentProfiles, store, shellStateStore, wikiBindingService, commandCatalog, mainTools, subagentTools}) => {
      const session = await sessionStore.getSession(thread.sessionId);
      const sessionPrompts = await sessionStore.listSessionPrompts(session.id);
      const runtimeConfig = await sessionStore.getSessionRuntimeConfig(session.id);
      const executionEnvironment = await executionEnvironmentResolver.resolveDefault(session);
      const commandDescriptors = await resolveVisibleCommandDescriptors({
        commandCatalog,
        commandExecutor: runtime.commandExecutor,
        session,
        executionEnvironment,
        readonlyPostgresCommandAllowed,
      });
      const sessionMainTools = session.kind === "subagent"
        ? subagentTools
        : mainTools;
      const shellSessions = await shellStateStore.listShellSessions({
        sessionId: session.id,
      });
      return createThreadDefinition({
        thread,
        session,
        fallbackContext,
        executionEnvironment,
        agentStore,
        pairedIdentities,
        sessionStore,
        subagentProfiles,
        sessionPrompts,
        runtimeConfig,
        threadStore: store,
        scheduledTasks,
        executionEnvironments,
        wikiBindings: wikiBindingService ?? undefined,
        commandDescriptors,
        bashToolOptions: {
          jobService: backgroundJobService,
          credentialResolver,
          shellStateStore,
        },
        browserToolOptions: {
          service: browserService,
        },
        tools: [
          ...sessionMainTools,
        ],
        extraContext: {
          ...(Object.keys(shellSessions).length > 0 ? {shellSessions} : {}),
          resolveExecutionTarget: (target) => executionEnvironmentResolver.resolve(session, target),
          refreshCommandAccess: async ({executionEnvironment, currentInput, runId, parentToolCallId}) => {
            return runtime.executionEnvironmentService.refreshSessionCommandAccess({
              session,
              executionEnvironment,
              ...(currentInput?.identityId ? {identityId: currentInput.identityId} : {}),
              ...(currentInput?.messageId ? {inputMessageId: currentInput.messageId} : {}),
              ...(runId ? {runId} : {}),
              ...(parentToolCallId ? {parentToolCallId} : {}),
            });
          },
          routeMemory: {
            getLastRoute: (lookup) => sessionRoutes.getLastRoute({
              sessionId: thread.sessionId,
              identityId: lookup?.identityId,
              channel: lookup?.channel,
            }),
            saveLastRoute: async (route, options) => {
              await sessionRoutes.saveLastRoute({
                sessionId: thread.sessionId,
                identityId: options?.identityId,
                route,
              });
            },
          },
          outboundQueue: {
            enqueueDelivery: (input) => outboundDeliveries.enqueueDelivery({
              ...input,
              sessionId: thread.sessionId,
              threadId: input.threadId ?? thread.id,
            }),
          },
          channelActionQueue: {
            enqueueAction: (input) => channelActions.enqueueAction({
              ...input,
              sessionId: thread.sessionId,
              threadId: input.threadId ?? thread.id,
            }),
          },
          messageAgent: {
            queueMessage: (input) => a2aMessagingService.queueMessage(input),
          },
        },
      });
    },
  });
  a2aBindings = runtime.a2aBindings;

  try {
    const conversationBindings = new ConversationRepo({
      pool: runtime.pool,
    });
    const connectorAccounts = new PostgresConnectorAccountStore({
      pool: runtime.pool,
    });
    const telegramStickerStore = new PostgresTelegramStickerStore({
      pool: runtime.pool,
    });
    const telegramStickers = new TelegramStickerLibrary(
      telegramStickerStore,
      createTelegramStickerSetReader({
        accounts: connectorAccounts,
        crypto: resolveSecretCrypto(),
      }),
    );
    const discordStickers = createDiscordStickerCatalogReader({
      accounts: connectorAccounts,
      client: createDiscordRestClient(),
      crypto: resolveSecretCrypto(),
    });
    const discordGifs = createDiscordGifService();
    const discordVoiceControls = new DiscordVoiceControlRepo({pool: runtime.pool});
    const liveVoice = new LiveVoiceRepo({pool: runtime.pool});
    liveVoiceForEvents = liveVoice;
    voiceEventHandler = createLiveVoiceRuntimeEventHandler({
      getVoiceRepo: () => liveVoiceForEvents,
    });
    const discordVoice = {
      controls: discordVoiceControls,
      live: liveVoice,
      async close(): Promise<void> { await Promise.all([discordVoiceControls.close(), liveVoice.close()]); },
    };

    sessionRoutes = new SessionRouteRepo({
      pool: runtime.pool,
    });

    outboundDeliveries = new PostgresOutboundDeliveryStore({
      pool: runtime.pool,
      notificationPool: runtime.notificationPool,
    });

    channelActions = new PostgresChannelActionStore({
      pool: runtime.pool,
      notificationPool: runtime.notificationPool,
    });
    runtime.commandExecutor.registerCommands(runtime.commandCatalog.createCommands(
      buildDaemonChannelCommandDependencies({
        commandFileResolver: runtime.commandFileResolver,
        connectorAccounts,
        conversations: conversationBindings,
        channelMessages: runtime.store,
        outboundDeliveries,
        channelActions,
        discordStickers,
        discordGifs,
        discordVoice,
        telegramStickers,
        email: runtime.email,
      }),
      {registrationPhase: "daemon.channel", requireAll: true},
    ));

    connectorLeases = new PostgresConnectorLeaseRepo({
      pool: runtime.pool,
    });

    const requests = new RuntimeRequestRepo({
      pool: runtime.pool,
      notificationPool: runtime.notificationPool,
      claimLeaseMs: readPositiveIntegerEnv(
        "PANDA_RUNTIME_REQUEST_CLAIM_LEASE_MS",
        DEFAULT_RUNTIME_REQUEST_CLAIM_LEASE_MS,
      ),
    });

    const daemonState = new DaemonStateRepo({
      pool: runtime.pool,
    });
    mediaReceiptJanitor = new FileSystemMediaStore({
      rootDir: resolveDataDir(),
      resolveReceiptOwners: (owners) => resolveRuntimeRequestMediaReceiptOwners(owners, requests),
      onReceiptSweepError: (error) => {
        console.error("Daemon media receipt sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    const commandUploads = new FileSystemCommandUploadStore();
    a2aMessagingService = new A2AMessagingService({
      bindings: a2aBindings,
      outboundDeliveries,
      sessions: runtime.sessionStore,
      maxMessagesPerHour: resolveA2AMaxMessagesPerHour(process.env),
    });
    runtime.commandExecutor.registerCommands(runtime.commandCatalog.createCommands(
      buildDaemonA2ACommandDependencies({
        commandUploads,
        a2aMessaging: a2aMessagingService,
        a2aDeliveries: a2aBindings,
      }),
      {registrationPhase: "daemon.a2a", requireAll: true},
    ));

    const a2aOutboundWorker = new ChannelOutboundDeliveryWorker({
      store: outboundDeliveries,
      adapter: createA2AOutboundAdapter({
        requests,
        sessionStore: runtime.sessionStore,
        createMediaStore: (rootDir) => new FileSystemMediaStore({rootDir}),
        resolveAgentMediaDir: (agentKey) => resolveAgentMediaDir(agentKey),
        commandUploads,
      }),
      connectorKey: A2A_CONNECTOR_KEY,
      onError: (error, deliveryId) => {
        console.error("A2A outbound delivery failed", {
          deliveryId: deliveryId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    const emailOutboundWorker = new ChannelOutboundDeliveryWorker({
      store: outboundDeliveries,
      adapter: createEmailOutboundAdapter({
        store: runtime.email,
        credentialResolver: runtime.credentialResolver,
      }),
      connectorKey: EMAIL_CONNECTOR_KEY,
      onError: (error, deliveryId) => {
        console.error("Email outbound delivery failed", {
          deliveryId: deliveryId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    const scheduledTaskRunner = new ScheduledTaskRunner({
      tasks: runtime.scheduledTasks,
      sessions: runtime.sessionStore,
      coordinator: runtime.coordinator,
      maxConcurrentRuns: readPositiveIntegerEnv(
        "PANDA_SCHEDULED_TASK_CONCURRENCY",
        DEFAULT_SCHEDULED_TASK_CONCURRENCY,
      ),
      onError: (error, taskId) => {
        console.error("Scheduled task execution failed", {
          taskId: taskId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    const evaluateWatch = createWatchEvaluator({
      credentialResolver: runtime.credentialResolver,
    });
    const watchRunner = new WatchRunner({
      watches: runtime.watches,
      sessions: runtime.sessionStore,
      coordinator: runtime.coordinator,
      evaluateWatch,
    });
    const emailSyncRunner = new EmailSyncRunner({
      store: runtime.email,
      sessions: runtime.sessionStore,
      coordinator: runtime.coordinator,
      credentialResolver: runtime.credentialResolver,
      createMediaWriter: (agentKey) => new FileSystemMediaStore({
        rootDir: resolveAgentMediaDir(agentKey),
      }),
      onError: (error, accountKey) => {
        console.error("Email sync failed", {
          accountKey: accountKey ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    const sessionHeartbeatRunner = new HeartbeatRunner({
      sessions: runtime.sessionStore,
      coordinator: runtime.coordinator,
      resolveInstructions: async (session) => {
        const heartbeatDoc = await runtime.sessionStore.readSessionPrompt(session.id, "heartbeat");
        return heartbeatDoc?.content?.trim() || null;
      },
      onError: (error, sessionId) => {
        console.error("Session heartbeat runner failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    const whatsAppAuthorizer = createWhatsAppActorAuthorizer({pool: runtime.pool});
    return {
      fallbackContext,
      daemonKey,
      runtime,
      a2aBindings,
      a2aOutboundWorker,
      emailOutboundWorker,
      emailSyncRunner,
      conversationBindings,
      sessionRoutes,
      outboundDeliveries,
      channelActions,
      connectorLeases,
      requests,
      mediaReceiptJanitor,
      daemonState,
      scheduledTaskRunner,
      watchRunner,
      sessionHeartbeatRunner,
      liveVoice,
      whatsAppAuthorizer,
      discordVoice,
    };
  } catch (error) {
    await mediaReceiptJanitor?.stopReceiptJanitor().catch(() => {});
    await runtime.close();
    throw error;
  }
}
