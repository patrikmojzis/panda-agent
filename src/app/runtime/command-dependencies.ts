import type {AgentCommandModuleDependencies} from "../../panda/commands/agent-command-modules.js";
import type {ChannelActionInput, ChannelActionKind, ChannelActionRecord} from "../../domain/channels/actions/types.js";
import type {
  OutboundDeliveryInput,
  OutboundDeliveryRecord,
  OutboundDeliveryTargetHistoryFilter,
} from "../../domain/channels/deliveries/types.js";
import {buildAgentAppOpenPath, readPublicAppsPathPrefix, resolveAgentAppUrls} from "../../integrations/apps/http-config.js";
import {resolveHeartbeatCadenceBounds} from "../../domain/scheduling/heartbeats/config.js";

type RequiredCommandDependency<K extends keyof AgentCommandModuleDependencies> =
  NonNullable<AgentCommandModuleDependencies[K]>;

export interface RuntimeCommandDependenciesInput {
  env: NodeJS.ProcessEnv;
  braveThrottleGate: RequiredCommandDependency<"braveThrottleGate">;
  backgroundJobService: RequiredCommandDependency<"backgroundJobService">;
  commandFileResolver: RequiredCommandDependency<"commandFileResolver">;
  watchStore: RequiredCommandDependency<"watchStore">;
  watchMutations: RequiredCommandDependency<"watchMutations">;
  scheduledTasks: RequiredCommandDependency<"scheduledTasks">;
  scheduledCommands?: AgentCommandModuleDependencies["scheduledCommands"];
  apps: RequiredCommandDependency<"apps">;
  appAuth: RequiredCommandDependency<"appAuth">;
  agentSkills: RequiredCommandDependency<"agentSkills">;
  sessionPrompts: RequiredCommandDependency<"sessionPrompts">;
  sessionTodos: RequiredCommandDependency<"sessionTodos">;
  sessionHeartbeats: RequiredCommandDependency<"sessionHeartbeats">;
  sessionCompactionRequests?: AgentCommandModuleDependencies["sessionCompactionRequests"];
  subagentProfiles: RequiredCommandDependency<"subagentProfiles">;
  subagentInventory: RequiredCommandDependency<"subagentInventory">;
  credentials?: AgentCommandModuleDependencies["credentials"];
  credentialResolver: RequiredCommandDependency<"credentialResolver">;
  mcpConfigs: RequiredCommandDependency<"mcpConfigs">;
  mcpRunner: RequiredCommandDependency<"mcpRunner">;
  mcpManagement: RequiredCommandDependency<"mcpManagement">;
  postgresReadonly: RequiredCommandDependency<"postgresReadonly">;
  executionEnvironments: RequiredCommandDependency<"executionEnvironments">;
  environmentLifecycle: RequiredCommandDependency<"environmentLifecycle">;
  wiki?: AgentCommandModuleDependencies["wiki"];
}

export interface DaemonChannelCommandDependenciesInput {
  commandFileResolver: RequiredCommandDependency<"commandFileResolver">;
  connectorAccounts: RequiredCommandDependency<"connectorAccounts">;
  conversations: RequiredCommandDependency<"conversations">;
  channelMessages: RequiredCommandDependency<"channelMessages">;
  outboundDeliveries: {
    enqueueDelivery(input: OutboundDeliveryInput): Promise<OutboundDeliveryRecord>;
    listDeliveriesForTarget(filter: OutboundDeliveryTargetHistoryFilter): Promise<readonly OutboundDeliveryRecord[]>;
  };
  channelActions: {
    enqueueAction<K extends ChannelActionKind>(input: ChannelActionInput<K>): Promise<ChannelActionRecord<K>>;
  };
  discordStickers: RequiredCommandDependency<"discordStickers">;
  discordGifs: RequiredCommandDependency<"discordGifs">;
  discordVoice: RequiredCommandDependency<"discordVoice">;
  whatsappCalls: RequiredCommandDependency<"whatsappCalls">;
  telegramStickers: RequiredCommandDependency<"telegramStickers">;
  email: RequiredCommandDependency<"email">;
}

export function buildRuntimeCommandDependencies(
  input: RuntimeCommandDependenciesInput,
): RuntimeCommandDependenciesInput & Required<Pick<
  AgentCommandModuleDependencies,
  "resolveAppUrls" | "resolveAppLaunchUrls" | "heartbeatBounds"
>> {
  return {
    ...input,
    resolveAppUrls: (appInput) => resolveAgentAppUrls({...appInput, env: input.env}),
    resolveAppLaunchUrls: ({agentKey, appSlug, token}) => {
      const urls = resolveAgentAppUrls({agentKey, appSlug, env: input.env});
      const pathPrefix = readPublicAppsPathPrefix(input.env);
      return {
        ...urls,
        openUrl: new URL(buildAgentAppOpenPath(token, pathPrefix), urls.appUrl).toString(),
      };
    },
    heartbeatBounds: resolveHeartbeatCadenceBounds(input.env),
  } satisfies AgentCommandModuleDependencies;
}

export function buildDaemonChannelCommandDependencies(
  input: DaemonChannelCommandDependenciesInput,
) {
  const channelActions = {
    enqueueAction: <K extends ChannelActionKind>(action: ChannelActionInput<K>) => input.channelActions.enqueueAction(action),
    getConversationBinding: (inputKey: Parameters<typeof input.conversations.getConversationBinding>[0]) =>
      input.conversations.getConversationBinding(inputKey),
  };

  return {
    commandFileResolver: input.commandFileResolver,
    connectorAccounts: input.connectorAccounts,
    conversations: input.conversations,
    channelMessages: input.channelMessages,
    outboundDeliveries: {
      enqueueDelivery: (delivery) => input.outboundDeliveries.enqueueDelivery(delivery),
      listDeliveriesForTarget: (filter) => input.outboundDeliveries.listDeliveriesForTarget(filter),
      getConversationBinding: (inputKey) => input.conversations.getConversationBinding(inputKey),
    },
    channelActions,
    discordStickers: input.discordStickers,
    discordGifs: input.discordGifs,
    discordVoice: input.discordVoice,
    whatsappCalls: input.whatsappCalls,
    telegramStickers: input.telegramStickers,
    email: input.email,
  } satisfies AgentCommandModuleDependencies;
}
