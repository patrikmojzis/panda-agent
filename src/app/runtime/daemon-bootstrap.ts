import {ChannelTypingDispatcher} from "../../domain/channels/index.js";
import {PostgresChannelActionStore} from "../../domain/channels/actions/index.js";
import {PostgresOutboundDeliveryStore} from "../../domain/channels/deliveries/index.js";
import {HeartbeatRunner} from "../../domain/scheduling/heartbeats/runner.js";
import {ScheduledTaskRunner} from "../../domain/scheduling/tasks/index.js";
import {ConversationRepo, SessionRouteRepo} from "../../domain/sessions/index.js";
import {WatchRunner} from "../../domain/watches/index.js";
import {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {createChannelTypingEventHandler} from "../../domain/threads/runtime/channel-typing.js";
import {createWatchEvaluator} from "../../integrations/watches/evaluator.js";
import {createRuntime, createThreadDefinition, type RuntimeServices,} from "./create-runtime.js";
import {ensureSchemas} from "./postgres-bootstrap.js";
import {DaemonStateRepo} from "./state/repo.js";
import {resolveDefaultAgentModelSelector} from "../../panda/defaults.js";
import type {DaemonOptions} from "./daemon-shared.js";
import {DEFAULT_DAEMON_KEY} from "./daemon-shared.js";
import {TELEGRAM_SOURCE,} from "../../integrations/channels/telegram/config.js";
import {TelegramReactTool} from "../../integrations/channels/telegram/telegram-react-tool.js";
import {WHATSAPP_SOURCE} from "../../integrations/channels/whatsapp/config.js";
import {OutboundTool} from "../../panda/tools/outbound-tool.js";

export interface DaemonContext {
  fallbackContext: {cwd: string};
  model: string;
  daemonKey: string;
  runtime: RuntimeServices;
  conversationBindings: ConversationRepo;
  sessionRoutes: SessionRouteRepo;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  channelActions: PostgresChannelActionStore;
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
  const model = resolveDefaultAgentModelSelector();
  const daemonKey = DEFAULT_DAEMON_KEY;

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

  const runtime = await createRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    maxSubagentDepth: options.maxSubagentDepth,
    onEvent: createChannelTypingEventHandler(typingDispatcher),
    resolveDefinition: async (thread, {agentStore, bashJobService, browserService, credentialResolver, sessionStore, store, mainTools}) => {
      const session = await sessionStore.getSession(thread.sessionId);
      return createThreadDefinition({
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
        tools: [...mainTools, new OutboundTool(), new TelegramReactTool()],
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
    });

    sessionRoutes = new SessionRouteRepo({
      pool: runtime.pool,
    });

    outboundDeliveries = new PostgresOutboundDeliveryStore({
      pool: runtime.pool,
    });

    channelActions = new PostgresChannelActionStore({
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
