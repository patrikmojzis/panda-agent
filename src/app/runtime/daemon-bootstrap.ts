import {A2ASessionBindingRepo} from "../../domain/a2a/index.js";
import {ChannelTypingDispatcher, FileSystemMediaStore} from "../../domain/channels/index.js";
import {PostgresChannelActionStore} from "../../domain/channels/actions/index.js";
import {ChannelOutboundDeliveryWorker, PostgresOutboundDeliveryStore} from "../../domain/channels/deliveries/index.js";
import {PostgresConnectorLeaseRepo} from "../../domain/connector-leases/index.js";
import {HeartbeatRunner} from "../../domain/scheduling/heartbeats/runner.js";
import {ScheduledTaskRunner} from "../../domain/scheduling/tasks/index.js";
import {ConversationRepo, SessionRouteRepo} from "../../domain/sessions/index.js";
import {WatchRunner} from "../../domain/watches/index.js";
import {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {createChannelTypingEventHandler} from "../../domain/threads/runtime/channel-typing.js";
import {A2AMessagingService} from "../../domain/a2a/service.js";
import {createWatchEvaluator} from "../../integrations/watches/evaluator.js";
import {createRuntime, createThreadDefinition, type RuntimeServices,} from "./create-runtime.js";
import {ensureSchemas} from "./postgres-bootstrap.js";
import {DaemonStateRepo} from "./state/repo.js";
import type {DaemonOptions} from "./daemon-shared.js";
import {DEFAULT_DAEMON_KEY} from "./daemon-shared.js";
import {A2A_CONNECTOR_KEY, resolveA2AMaxMessagesPerHour} from "../../integrations/channels/a2a/config.js";
import {createA2AOutboundAdapter} from "../../integrations/channels/a2a/outbound.js";
import {TELEGRAM_SOURCE,} from "../../integrations/channels/telegram/config.js";
import {TelegramReactTool} from "../../integrations/channels/telegram/telegram-react-tool.js";
import {WHATSAPP_SOURCE} from "../../integrations/channels/whatsapp/config.js";
import {resolveAgentMediaDir} from "./data-dir.js";
import {OutboundTool} from "../../panda/tools/outbound-tool.js";
import {MessageAgentTool} from "../../panda/tools/message-agent-tool.js";

export interface DaemonContext {
  fallbackContext: {cwd: string};
  daemonKey: string;
  runtime: RuntimeServices;
  a2aBindings: A2ASessionBindingRepo;
  a2aOutboundWorker: ChannelOutboundDeliveryWorker;
  conversationBindings: ConversationRepo;
  sessionRoutes: SessionRouteRepo;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  channelActions: PostgresChannelActionStore;
  connectorLeases: PostgresConnectorLeaseRepo;
  requests: RuntimeRequestRepo;
  daemonState: DaemonStateRepo;
  scheduledTaskRunner: ScheduledTaskRunner;
  watchRunner: WatchRunner;
  relationshipHeartbeatRunner: HeartbeatRunner;
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

  const runtime = await createRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    maxSubagentDepth: options.maxSubagentDepth,
    onEvent: createChannelTypingEventHandler(typingDispatcher),
    resolveDefinition: async (thread, {agentStore, bashJobService, browserService, credentialResolver, sessionStore, store, wikiBindingService, mainTools}) => {
      const session = await sessionStore.getSession(thread.sessionId);
      return createThreadDefinition({
        thread,
        session,
        fallbackContext,
        agentStore,
        threadStore: store,
        wikiBindings: wikiBindingService ?? undefined,
        bashToolOptions: {
          jobService: bashJobService,
          credentialResolver,
        },
        browserToolOptions: {
          service: browserService,
        },
        tools: [...mainTools, new OutboundTool(), new MessageAgentTool(), new TelegramReactTool()],
        extraContext: {
          routeMemory: {
            getLastRoute: (channel) => sessionRoutes.getLastRoute({
              sessionId: thread.sessionId,
              channel,
            }),
            saveLastRoute: async (route) => {
              await sessionRoutes.saveLastRoute({
                sessionId: thread.sessionId,
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

  try {
    const conversationBindings = new ConversationRepo({
      pool: runtime.pool,
    });

    sessionRoutes = new SessionRouteRepo({
      pool: runtime.pool,
    });

    outboundDeliveries = new PostgresOutboundDeliveryStore({
      pool: runtime.pool,
    });

    a2aBindings = new A2ASessionBindingRepo({
      pool: runtime.pool,
    });

    channelActions = new PostgresChannelActionStore({
      pool: runtime.pool,
    });

    connectorLeases = new PostgresConnectorLeaseRepo({
      pool: runtime.pool,
    });

    const requests = new RuntimeRequestRepo({
      pool: runtime.pool,
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

    const scheduledTaskRunner = new ScheduledTaskRunner({
      tasks: runtime.scheduledTasks,
      sessions: runtime.sessionStore,
      sessionRoutes,
      outboundDeliveries,
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
    const relationshipHeartbeatRunner = new HeartbeatRunner({
      sessions: runtime.sessionStore,
      coordinator: runtime.coordinator,
      resolveInstructions: async (session) => {
        const heartbeatDoc = await runtime.agentStore.readAgentPrompt(session.agentKey, "heartbeat");
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
      conversationBindings,
      sessionRoutes,
      outboundDeliveries,
      channelActions,
      connectorLeases,
      requests,
      daemonState,
      scheduledTaskRunner,
      watchRunner,
      relationshipHeartbeatRunner,
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
