import type {AgentCommandModuleDependencies} from "../../panda/commands/agent-command-modules.js";
import type {ChannelActionInput, ChannelActionKind, ChannelActionRecord} from "../../domain/channels/actions/types.js";
import type {
  OutboundDeliveryInput,
  OutboundDeliveryRecord,
  OutboundDeliveryTargetHistoryFilter,
} from "../../domain/channels/deliveries/types.js";
import {buildAgentAppOpenPath, resolveAgentAppUrls} from "../../integrations/apps/http-config.js";

type RequiredCommandDependency<K extends keyof AgentCommandModuleDependencies> =
  NonNullable<AgentCommandModuleDependencies[K]>;

export interface RuntimeCommandDependenciesInput {
  env: NodeJS.ProcessEnv;
  backgroundJobService: RequiredCommandDependency<"backgroundJobService">;
  commandFileResolver: RequiredCommandDependency<"commandFileResolver">;
  watchStore: RequiredCommandDependency<"watchStore">;
  watchMutations: RequiredCommandDependency<"watchMutations">;
  scheduledTasks: RequiredCommandDependency<"scheduledTasks">;
  apps: RequiredCommandDependency<"apps">;
  appAuth: RequiredCommandDependency<"appAuth">;
  agentSkills: RequiredCommandDependency<"agentSkills">;
  sessionPrompts: RequiredCommandDependency<"sessionPrompts">;
  sessionTodos: RequiredCommandDependency<"sessionTodos">;
  subagentProfiles: RequiredCommandDependency<"subagentProfiles">;
  credentials?: AgentCommandModuleDependencies["credentials"];
  credentialResolver: RequiredCommandDependency<"credentialResolver">;
  mcpConfigs: RequiredCommandDependency<"mcpConfigs">;
  mcpRunner: RequiredCommandDependency<"mcpRunner">;
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
  email: RequiredCommandDependency<"email">;
}

export interface DaemonA2ACommandDependenciesInput {
  commandUploads: RequiredCommandDependency<"commandUploads">;
  a2aMessaging: RequiredCommandDependency<"a2aMessaging">;
  a2aDeliveries: RequiredCommandDependency<"a2aDeliveries">;
}

export function buildRuntimeCommandDependencies(
  input: RuntimeCommandDependenciesInput,
): AgentCommandModuleDependencies {
  return {
    env: input.env,
    backgroundJobService: input.backgroundJobService,
    commandFileResolver: input.commandFileResolver,
    watchStore: input.watchStore,
    watchMutations: input.watchMutations,
    scheduledTasks: input.scheduledTasks,
    apps: input.apps,
    appAuth: input.appAuth,
    resolveAppUrls: (appInput) => resolveAgentAppUrls({...appInput, env: input.env}),
    resolveAppLaunchUrls: ({agentKey, appSlug, token}) => {
      const urls = resolveAgentAppUrls({agentKey, appSlug, env: input.env});
      return {
        ...urls,
        openUrl: new URL(buildAgentAppOpenPath(token), urls.appUrl).toString(),
      };
    },
    agentSkills: input.agentSkills,
    sessionPrompts: input.sessionPrompts,
    sessionTodos: input.sessionTodos,
    subagentProfiles: input.subagentProfiles,
    credentials: input.credentials,
    credentialResolver: input.credentialResolver,
    mcpConfigs: input.mcpConfigs,
    mcpRunner: input.mcpRunner,
    postgresReadonly: input.postgresReadonly,
    executionEnvironments: input.executionEnvironments,
    environmentLifecycle: input.environmentLifecycle,
    wiki: input.wiki,
  };
}

export function buildSubagentCommandDependencies(
  subagentSessions: RequiredCommandDependency<"subagentSessions">,
): AgentCommandModuleDependencies {
  return {subagentSessions};
}

export function buildDaemonChannelCommandDependencies(
  input: DaemonChannelCommandDependenciesInput,
): AgentCommandModuleDependencies {
  const channelActions = {
    enqueueAction: <K extends ChannelActionKind>(action: ChannelActionInput<K>) => input.channelActions.enqueueAction(action),
    listConversationBindings: (filter: Parameters<typeof input.conversations.listConversationBindings>[0]) =>
      input.conversations.listConversationBindings(filter),
  };

  return {
    commandFileResolver: input.commandFileResolver,
    connectorAccounts: input.connectorAccounts,
    conversations: input.conversations,
    channelMessages: input.channelMessages,
    outboundDeliveries: {
      enqueueDelivery: (delivery) => input.outboundDeliveries.enqueueDelivery(delivery),
      listDeliveriesForTarget: (filter) => input.outboundDeliveries.listDeliveriesForTarget(filter),
      listConversationBindings: (filter) => input.conversations.listConversationBindings(filter),
    },
    channelActions,
    email: input.email,
  };
}

export function buildDaemonA2ACommandDependencies(
  input: DaemonA2ACommandDependenciesInput,
): AgentCommandModuleDependencies {
  return {
    commandUploads: input.commandUploads,
    a2aMessaging: input.a2aMessaging,
    a2aDeliveries: input.a2aDeliveries,
  };
}
