import {ChannelTypingDispatcher} from "../../domain/channels/index.js";
import {PostgresChannelActionStore} from "../../domain/channels/actions/index.js";
import {PostgresOutboundDeliveryStore} from "../../domain/channels/deliveries/index.js";
import {HeartbeatRunner} from "../../domain/scheduling/heartbeats/runner.js";
import {ScheduledTaskRunner} from "../../domain/scheduling/tasks/index.js";
import {ConversationRepo, SessionRouteRepo} from "../../domain/sessions/index.js";
import {WatchRunner} from "../../domain/watches/index.js";
import {PandaRuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {createChannelTypingEventHandler} from "../../domain/threads/runtime/channel-typing.js";
import {createWatchEvaluator} from "../../integrations/watches/evaluator.js";
import {createPandaRuntime, createPandaThreadDefinition, type PandaRuntimeServices,} from "./create-runtime.js";
import {ensureSchemas} from "./postgres-bootstrap.js";
import {PandaDaemonStateRepo} from "./state/repo.js";
import {resolveDefaultPandaModelSelector} from "../../personas/panda/defaults.js";
import type {PandaDaemonOptions} from "./daemon-shared.js";
import {DEFAULT_PANDA_DAEMON_KEY} from "./daemon-shared.js";
import {TELEGRAM_SOURCE,} from "../../integrations/channels/telegram/config.js";
import {TelegramReactTool} from "../../integrations/channels/telegram/telegram-react-tool.js";
import {WHATSAPP_SOURCE} from "../../integrations/channels/whatsapp/config.js";
import {OutboundTool} from "../../personas/panda/tools/outbound-tool.js";

export interface PandaDaemonContext {
  fallbackContext: {cwd: string};
  model: string;
  daemonKey: string;
  runtime: PandaRuntimeServices;
  conversationBindings: ConversationRepo;
  sessionRoutes: SessionRouteRepo;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  channelActions: PostgresChannelActionStore;
  requests: PandaRuntimeRequestRepo;
  daemonState: PandaDaemonStateRepo;
  scheduledTaskRunner: ScheduledTaskRunner;
  watchRunner: WatchRunner;
  relationshipHeartbeatRunner: HeartbeatRunner;
}

export async function bootstrapPandaDaemonContext(
  options: PandaDaemonOptions,
): Promise<PandaDaemonContext> {
  const fallbackContext = {
    cwd: options.cwd,
  } as const;
  const model = resolveDefaultPandaModelSelector();
  const daemonKey = DEFAULT_PANDA_DAEMON_KEY;

  let sessionRoutes!: SessionRouteRepo;
  let outboundDeliveries!: PostgresOutboundDeliveryStore;
  let channelActions!: PostgresChannelActionStore;

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

  const runtime = await createPandaRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    maxSubagentDepth: options.maxSubagentDepth,
    tablePrefix: options.tablePrefix,
    onEvent: createChannelTypingEventHandler(typingDispatcher),
    resolveDefinition: async (thread, {agentStore, bashJobService, browserService, credentialResolver, sessionStore, store, extraTools}) => {
      const session = await sessionStore.getSession(thread.sessionId);
      return createPandaThreadDefinition({
        thread,
        session,
        fallbackContext,
        agentStore,
        threadStore: store,
        bashToolOptions: {
          jobService: bashJobService,
          credentialResolver,
        },
        browserToolOptions: {
          service: browserService,
        },
        extraTools: [...extraTools, new OutboundTool(), new TelegramReactTool()],
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
        },
      });
    },
  });

  try {
    const conversationBindings = new ConversationRepo({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });

    sessionRoutes = new SessionRouteRepo({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });

    outboundDeliveries = new PostgresOutboundDeliveryStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });

    channelActions = new PostgresChannelActionStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });

    const requests = new PandaRuntimeRequestRepo({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });

    const daemonState = new PandaDaemonStateRepo({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await ensureSchemas([
      conversationBindings,
      sessionRoutes,
      outboundDeliveries,
      channelActions,
      requests,
      daemonState,
    ]);

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
      model,
      daemonKey,
      runtime,
      conversationBindings,
      sessionRoutes,
      outboundDeliveries,
      channelActions,
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
