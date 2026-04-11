import {ChannelTypingDispatcher} from "../../domain/channels/index.js";
import {PostgresChannelActionStore} from "../../domain/channels/actions/index.js";
import {PostgresOutboundDeliveryStore} from "../../domain/channels/deliveries/index.js";
import {HeartbeatRunner} from "../../domain/scheduling/heartbeats/runner.js";
import {ScheduledTaskRunner} from "../../domain/scheduling/tasks/index.js";
import {ConversationRepo} from "../../domain/threads/conversations/repo.js";
import {PostgresHomeThreadStore} from "../../domain/threads/home/index.js";
import {PandaRuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {createChannelTypingEventHandler} from "../../domain/threads/runtime/channel-typing.js";
import {ThreadRouteRepo} from "../../domain/threads/routes/repo.js";
import {createPandaRuntime, createPandaThreadDefinition, type PandaRuntimeServices,} from "./create-runtime.js";
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
  homeThreads: PostgresHomeThreadStore;
  threadRoutes: ThreadRouteRepo;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  channelActions: PostgresChannelActionStore;
  requests: PandaRuntimeRequestRepo;
  daemonState: PandaDaemonStateRepo;
  scheduledTaskRunner: ScheduledTaskRunner;
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

  let threadRoutes!: ThreadRouteRepo;
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
    resolveDefinition: async (thread, {agentStore, credentialResolver, identityStore, extraTools}) => {
      const identity = await identityStore.getIdentity(thread.identityId);
      return createPandaThreadDefinition({
        thread,
        fallbackContext: {
          ...fallbackContext,
          identityId: identity.id,
          identityHandle: identity.handle,
        },
        agentStore,
        bashToolOptions: {
          credentialResolver,
        },
        extraTools: [...extraTools, new OutboundTool(), new TelegramReactTool()],
        extraContext: {
          routeMemory: {
            getLastRoute: (channel) => threadRoutes.getLastRoute({
              threadId: thread.id,
              channel,
            }),
            saveLastRoute: async (route) => {
              await threadRoutes.saveLastRoute({
                threadId: thread.id,
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
    await conversationBindings.ensureSchema();

    const homeThreads = new PostgresHomeThreadStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await homeThreads.ensureSchema();

    threadRoutes = new ThreadRouteRepo({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await threadRoutes.ensureSchema();

    outboundDeliveries = new PostgresOutboundDeliveryStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await outboundDeliveries.ensureSchema();

    channelActions = new PostgresChannelActionStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await channelActions.ensureSchema();

    const requests = new PandaRuntimeRequestRepo({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await requests.ensureSchema();

    const daemonState = new PandaDaemonStateRepo({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await daemonState.ensureSchema();

    const scheduledTaskRunner = new ScheduledTaskRunner({
      tasks: runtime.scheduledTasks,
      homeThreads,
      threadRoutes,
      outboundDeliveries,
      threadStore: runtime.store,
      coordinator: runtime.coordinator,
    });
    const relationshipHeartbeatRunner = new HeartbeatRunner({
      homeThreads,
      coordinator: runtime.coordinator,
      resolveInstructions: async (home) => {
        const thread = await runtime.store.getThread(home.threadId);
        const heartbeatDoc = await runtime.agentStore.readAgentDocument(thread.agentKey, "heartbeat");
        return heartbeatDoc?.content?.trim() || null;
      },
      onError: (error, identityId) => {
        console.error("Relationship heartbeat runner failed", {
          identityId,
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
      homeThreads,
      threadRoutes,
      outboundDeliveries,
      channelActions,
      requests,
      daemonState,
      scheduledTaskRunner,
      relationshipHeartbeatRunner,
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
