import {A2ASessionBindingRepo} from "../../domain/a2a/repo.js";
import {FileSystemMediaStore} from "../../domain/channels/media-store.js";
import {ChannelTypingDispatcher} from "../../domain/channels/typing.js";
import {PostgresChannelActionStore} from "../../domain/channels/actions/postgres.js";
import {PostgresOutboundDeliveryStore} from "../../domain/channels/deliveries/postgres.js";
import {ChannelOutboundDeliveryWorker} from "../../domain/channels/deliveries/worker.js";
import {PostgresConnectorLeaseRepo} from "../../domain/connector-leases/repo.js";
import {PostgresConnectorAccountStore} from "../../domain/connectors/postgres.js";
import {HeartbeatRunner} from "../../domain/scheduling/heartbeats/runner.js";
import {ScheduledTaskRunner} from "../../domain/scheduling/tasks/runner.js";
import {ConversationRepo} from "../../domain/sessions/conversations/repo.js";
import {SessionRouteRepo} from "../../domain/sessions/routes/repo.js";
import {WatchRunner} from "../../domain/watches/runner.js";
import {DEFAULT_RUNTIME_REQUEST_CLAIM_TIMEOUT_MS, RuntimeRequestRepo,} from "../../domain/threads/requests/repo.js";
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
import {ensureSchemas} from "./postgres-bootstrap.js";
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
import {WHATSAPP_SOURCE} from "../../integrations/channels/whatsapp/config.js";
import {resolveAgentMediaDir} from "./data-dir.js";
import {readPositiveIntegerEnv} from "./database.js";
import {trimToNull} from "../../lib/strings.js";

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
  daemonState: DaemonStateRepo;
  scheduledTaskRunner: ScheduledTaskRunner;
  watchRunner: WatchRunner;
  sessionHeartbeatRunner: HeartbeatRunner;
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
  let runtimeForNotifications: RuntimeServices | undefined;
  const notificationPokesInFlight = new Set<string>();

  const typingDispatcher = new ChannelTypingDispatcher([
    {
      channel: TELEGRAM_SOURCE,
      send: async (request) => {
        await channelActions.enqueueAction({
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
  const runtime = await createRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    cwd: options.cwd,
    maxSubagentDepth: options.maxSubagentDepth,
    ...(commandCatalog ? {commandCatalog} : {}),
    onEvent: createChannelTypingEventHandler(typingDispatcher),
    onStoreNotification: (notification) => {
      const runtime = runtimeForNotifications;
      if (!runtime || notificationPokesInFlight.has(notification.threadId)) {
        return;
      }

      notificationPokesInFlight.add(notification.threadId);
      void runtime.coordinator.poke(notification.threadId)
        .catch((error) => {
          console.error("Daemon failed to poke thread from store notification", {
            threadId: notification.threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          notificationPokesInFlight.delete(notification.threadId);
        });
    },
    resolveDefinition: async (thread, {agentStore, backgroundJobService, browserService, credentialResolver, executionEnvironments, scheduledTasks, executionEnvironmentResolver, identityStore, sessionStore, subagentProfiles, store, shellStateStore, wikiBindingService, commandCatalog, mainTools, subagentTools}) => {
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
        identityStore,
        sessionStore,
        sessionRoutes,
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
          refreshCommandAccess: async ({executionEnvironment, currentInput}) => {
            return runtime.executionEnvironmentService.refreshSessionCommandAccess({
              session,
              executionEnvironment,
              ...(currentInput?.identityId ? {identityId: currentInput.identityId} : {}),
              ...(currentInput?.messageId ? {inputMessageId: currentInput.messageId} : {}),
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
            enqueueDelivery: (input) => outboundDeliveries.enqueueDelivery(input),
          },
          channelActionQueue: {
            enqueueAction: (input) => channelActions.enqueueAction(input),
          },
          messageAgent: {
            queueMessage: (input) => a2aMessagingService.queueMessage(input),
          },
        },
      });
    },
  });
  runtimeForNotifications = runtime;
  a2aBindings = runtime.a2aBindings;

  try {
    const conversationBindings = new ConversationRepo({
      pool: runtime.pool,
    });
    const connectorAccounts = new PostgresConnectorAccountStore({
      pool: runtime.pool,
    });

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
      staleRunningRequestMs: readPositiveIntegerEnv(
        "PANDA_RUNTIME_REQUEST_CLAIM_TIMEOUT_MS",
        DEFAULT_RUNTIME_REQUEST_CLAIM_TIMEOUT_MS,
      ),
    });

    const daemonState = new DaemonStateRepo({
      pool: runtime.pool,
    });
    await ensureSchemas([
      conversationBindings,
      sessionRoutes,
      outboundDeliveries,
      a2aBindings,
      channelActions,
      connectorLeases,
      requests,
      daemonState,
    ]);

    a2aMessagingService = new A2AMessagingService({
      bindings: a2aBindings,
      outboundDeliveries,
      sessions: runtime.sessionStore,
      maxMessagesPerHour: resolveA2AMaxMessagesPerHour(process.env),
    });
    runtime.commandExecutor.registerCommands(runtime.commandCatalog.createCommands(
      buildDaemonA2ACommandDependencies({
        commandFileResolver: runtime.commandFileResolver,
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
      threadStore: runtime.store,
      coordinator: runtime.coordinator,
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
      daemonState,
      scheduledTaskRunner,
      watchRunner,
      sessionHeartbeatRunner,
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
