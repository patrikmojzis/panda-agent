import {
  a2aHistoryCommandDescriptor,
  a2aInspectCommandDescriptor,
  a2aSendCommandDescriptor,
  createA2AHistoryCommand,
  createA2AInspectCommand,
  createA2ASendCommand,
  type A2ADeliveryReader,
  type MessageAgentCommandQueue,
} from "../../domain/a2a/commands.js";
import {
  createSkillDeleteCommand,
  createSkillListCommand,
  createSkillLoadCommand,
  createSkillPatchCommand,
  createSkillSetCommand,
  createSkillShowCommand,
  type AgentSkillCommandStore,
  skillDeleteCommandDescriptor,
  skillListCommandDescriptor,
  skillLoadCommandDescriptor,
  skillPatchCommandDescriptor,
  skillSetCommandDescriptor,
  skillShowCommandDescriptor,
} from "../../domain/agents/skill-commands.js";
import {
  type AgentAppCommandAuthService,
  type AgentAppCommandService,
  type AppCommandOptions,
  appActionCommandDescriptor,
  appCheckCommandDescriptor,
  appCreateCommandDescriptor,
  appLinkCreateCommandDescriptor,
  appListCommandDescriptor,
  appViewCommandDescriptor,
  createAppActionCommand,
  createAppCheckCommand,
  createAppCreateCommand,
  createAppLinkCreateCommand,
  createAppListCommand,
  createAppViewCommand,
} from "../../domain/apps/commands.js";
import type {CommandFileResolver, CommandWritableFileResolver} from "../../domain/commands/files.js";
import type {
  CommandCatalogModule,
  CommandDescriptor,
  CommandRegistrationPhase,
  RegisteredCommand,
} from "../../domain/commands/types.js";
import {createCommandCatalog, defineCommandCatalogModule, type CommandCatalog} from "../../domain/commands/modules.js";
import type {ExplicitChannelSendCommandServices} from "../../domain/channels/explicit-send-command.js";
import {
  createClearEnvValueCommand,
  createListEnvValuesCommand,
  createSetEnvValueCommand,
  envClearCommandDescriptor,
  envListCommandDescriptor,
  envSetCommandDescriptor,
  type EnvCommandService,
} from "../../domain/credentials/commands.js";
import {
  createEmailAccountListCommand,
  createEmailAttachmentsFetchCommand,
  createEmailListCommand,
  createEmailReadCommand,
  createEmailSearchCommand,
  createEmailSendCommand,
  type EmailAccountListCommandServices,
  type EmailReadCommandServices,
  type EmailSendCommandQueue,
  type EmailSendCommandServices,
  emailAccountListCommandDescriptor,
  emailAttachmentsFetchCommandDescriptor,
  emailListCommandDescriptor,
  emailReadCommandDescriptor,
  emailSearchCommandDescriptor,
  emailSendCommandDescriptor,
} from "../../domain/email/commands.js";
import {
  createEnvironmentCreateCommand,
  createEnvironmentListCommand,
  createEnvironmentLogsCommand,
  createEnvironmentShowCommand,
  createEnvironmentStopCommand,
  environmentCreateCommandDescriptor,
  type EnvironmentCommandLifecycle,
  environmentListCommandDescriptor,
  environmentLogsCommandDescriptor,
  type EnvironmentReadCommandServices,
  environmentShowCommandDescriptor,
  environmentStopCommandDescriptor,
} from "../../domain/execution-environments/commands.js";
import {
  createScheduleCancelCommand,
  createScheduleCreateCommand,
  createScheduleListCommand,
  createScheduleRunsCommand,
  createScheduleShowCommand,
  createScheduleUpdateCommand,
  scheduleCancelCommandDescriptor,
  scheduleCreateCommandDescriptor,
  scheduleListCommandDescriptor,
  scheduleRunsCommandDescriptor,
  scheduleShowCommandDescriptor,
  scheduleUpdateCommandDescriptor,
} from "../../domain/scheduling/tasks/commands.js";
import type {ScheduledTaskStore} from "../../domain/scheduling/tasks/store.js";
import {
  createSessionPromptReadCommand,
  createSessionPromptSetCommand,
  createSessionPromptTransformCommand,
  sessionPromptReadCommandDescriptor,
  sessionPromptSetCommandDescriptor,
  sessionPromptTransformCommandDescriptor,
  type SessionPromptCommandStore,
} from "../../domain/sessions/prompt-commands.js";
import {
  createTodoAddCommand,
  createTodoBlockCommand,
  createTodoClearCommand,
  createTodoDoneCommand,
  createTodoListCommand,
  createTodoShowCommand,
  todoAddCommandDescriptor,
  todoBlockCommandDescriptor,
  todoClearCommandDescriptor,
  todoDoneCommandDescriptor,
  todoListCommandDescriptor,
  todoShowCommandDescriptor,
  type TodoClearCommandStore,
  type TodoItemMutationCommandStore,
  type TodoReadCommandStore,
} from "../../domain/sessions/todo-commands.js";
import {
  createSubagentProfileDisableCommand,
  createSubagentProfileEnableCommand,
  createSubagentProfileListCommand,
  createSubagentProfileShowCommand,
  createSubagentProfileUpsertCommand,
  createSubagentSpawnCommand,
  subagentProfileDisableCommandDescriptor,
  subagentProfileEnableCommandDescriptor,
  subagentProfileListCommandDescriptor,
  subagentProfileShowCommandDescriptor,
  subagentProfileUpsertCommandDescriptor,
  subagentSpawnCommandDescriptor,
  type SubagentSpawnSessionCreator,
  type SubagentProfileListCommandStore,
  type SubagentProfileShowCommandStore,
  type SubagentProfileStateCommandStore,
  type SubagentProfileUpsertCommandStore,
} from "../../domain/subagents/commands.js";
import {
  createTimeNowCommand,
  timeNowCommandDescriptor,
} from "../../domain/time/commands.js";
import {
  createMcpCallCommand,
  createMcpToolsCommand,
  MCP_COMMAND_CAPABILITY,
  mcpCallCommandDescriptor,
  mcpToolsCommandDescriptor,
} from "../../domain/mcp/commands.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import type {WatchMutationService} from "../../domain/watches/mutation-service.js";
import type {WatchStore} from "../../domain/watches/store.js";
import {
  createWatchCreateCommand,
  createWatchDisableCommand,
  createWatchListCommand,
  createWatchRunsCommand,
  createWatchShowCommand,
  createWatchUpdateCommand,
  watchCreateCommandDescriptor,
  watchDisableCommandDescriptor,
  watchListCommandDescriptor,
  watchRunsCommandDescriptor,
  watchShowCommandDescriptor,
  watchUpdateCommandDescriptor,
} from "../../domain/watches/commands.js";
import {
  createWikiArchiveCommand,
  createWikiAttachImageCommand,
  createWikiDeleteAssetCommand,
  createWikiDiffCommand,
  createWikiFetchAssetCommand,
  createWikiListCommand,
  createWikiMoveCommand,
  createWikiReadCommand,
  createWikiRestoreCommand,
  createWikiSearchCommand,
  createWikiWriteCommand,
  createWikiWriteSectionCommand,
  type WikiCommandService,
  wikiArchiveCommandDescriptor,
  wikiAttachImageCommandDescriptor,
  wikiDeleteAssetCommandDescriptor,
  wikiDiffCommandDescriptor,
  wikiFetchAssetCommandDescriptor,
  wikiListCommandDescriptor,
  wikiMoveCommandDescriptor,
  wikiReadCommandDescriptor,
  wikiRestoreCommandDescriptor,
  wikiSearchCommandDescriptor,
  wikiWriteCommandDescriptor,
  wikiWriteSectionCommandDescriptor,
} from "../../domain/wiki/commands.js";
import {
  whisperTranscribeCommandDescriptor,
  createWhisperTranscribeCommand,
  whisperTranslateCommandDescriptor,
  createWhisperTranslateCommand,
} from "../../integrations/audio/commands.js";
import {agentCommandPolicy, type AgentCommandPolicy} from "./agent-command-policy.js";
import {
  createDiscordChannelListCommand,
  createDiscordHistoryCommand,
  createDiscordSendCommand,
  type DiscordChannelListCommandServices,
  discordChannelListCommandDescriptor,
  discordHistoryCommandDescriptor,
  discordSendCommandDescriptor,
} from "../../integrations/channels/discord/commands.js";
import {
  createTelegramChatInfoCommand,
  createTelegramChatListCommand,
  createTelegramDeleteCommand,
  createTelegramEditCommand,
  createTelegramHistoryCommand,
  createTelegramMediaFetchCommand,
  createTelegramPinCommand,
  createTelegramReactCommand,
  createTelegramSendCommand,
  createTelegramStickerSendCommand,
  createTelegramUnpinCommand,
  type TelegramChatListCommandServices,
  type TelegramDeleteCommandQueue,
  type TelegramEditCommandQueue,
  type TelegramHistoryCommandServices,
  type TelegramMediaFetchCommandServices,
  type TelegramPinCommandQueue,
  type TelegramReactCommandQueue,
  type TelegramSendCommandQueue,
  type TelegramStickerSendCommandQueue,
  type TelegramUnpinCommandQueue,
  telegramChatListCommandDescriptor,
  telegramChatInfoCommandDescriptor,
  telegramDeleteCommandDescriptor,
  telegramEditCommandDescriptor,
  telegramHistoryCommandDescriptor,
  telegramMediaFetchCommandDescriptor,
  telegramPinCommandDescriptor,
  telegramReactCommandDescriptor,
  telegramSendCommandDescriptor,
  telegramStickerSendCommandDescriptor,
  telegramUnpinCommandDescriptor,
} from "../../integrations/channels/telegram/commands.js";
import {
  createWhatsAppChatListCommand,
  createWhatsAppHistoryCommand,
  createWhatsAppSendCommand,
  type WhatsAppChatListCommandServices,
  whatsappChatListCommandDescriptor,
  whatsappHistoryCommandDescriptor,
  whatsappSendCommandDescriptor,
} from "../../integrations/channels/whatsapp/commands.js";
import {
  createVentSendCommand,
  ventSendCommandDescriptor,
} from "../../integrations/panda-trace/vent-commands.js";
import {
  createPostgresReadonlyQueryCommand,
  postgresReadonlyQueryCommandDescriptor,
  type PostgresReadonlyQueryCommandOptions,
} from "../../integrations/postgres/readonly-query-command.js";
import {
  braveImageSearchCommandDescriptor,
  braveLlmContextCommandDescriptor,
  braveNewsSearchCommandDescriptor,
  bravePlaceDescriptionCommandDescriptor,
  bravePlacePoiCommandDescriptor,
  bravePlaceSearchCommandDescriptor,
  braveVideoSearchCommandDescriptor,
  braveWebSearchCommandDescriptor,
  createBraveImageSearchCommand,
  createBraveLlmContextCommand,
  createBraveNewsSearchCommand,
  createBravePlaceDescriptionCommand,
  createBravePlacePoiCommand,
  createBravePlaceSearchCommand,
  createBraveVideoSearchCommand,
  createBraveWebSearchCommand,
  createOpenAIWebResearchCommand,
  createWebFetchCommand,
  openAIWebResearchCommandDescriptor,
  webFetchCommandDescriptor,
} from "../../integrations/web/commands.js";
import {
  createImageGenerateCommand,
  imageGenerateCommandDescriptor,
} from "./image-generate-command.js";

type AgentCommandFileResolver = CommandFileResolver & CommandWritableFileResolver;
type SessionTodoCommandStore = TodoItemMutationCommandStore & TodoClearCommandStore & TodoReadCommandStore;
type SubagentProfileCommandStore =
  & SubagentProfileListCommandStore
  & SubagentProfileShowCommandStore
  & SubagentProfileStateCommandStore
  & SubagentProfileUpsertCommandStore;
type TelegramActionCommandQueue =
  & TelegramReactCommandQueue
  & TelegramEditCommandQueue
  & TelegramDeleteCommandQueue
  & TelegramPinCommandQueue
  & TelegramUnpinCommandQueue
  & TelegramStickerSendCommandQueue;
type OutboundCommandQueue =
  & ExplicitChannelSendCommandServices
  & EmailSendCommandQueue
  & TelegramSendCommandQueue;
type ChannelCommandConnectorAccounts =
  & TelegramChatListCommandServices["connectorAccounts"]
  & DiscordChannelListCommandServices["connectorAccounts"];
type ChannelCommandConversations =
  & TelegramChatListCommandServices["conversations"]
  & DiscordChannelListCommandServices["conversations"]
  & WhatsAppChatListCommandServices["conversations"];
type ChannelCommandMessages =
  & TelegramHistoryCommandServices["messages"]
  & TelegramMediaFetchCommandServices["messages"];
type ChannelCommandDeliveries =
  & TelegramHistoryCommandServices["deliveries"]
  & OutboundCommandQueue;
type EmailCommandStore =
  & EmailSendCommandServices["store"]
  & EmailReadCommandServices["store"]
  & EmailAccountListCommandServices["store"];

export interface AgentCommandModuleDependencies {
  env?: NodeJS.ProcessEnv;
  backgroundJobService?: BackgroundToolJobService;
  commandFileResolver?: AgentCommandFileResolver;
  watchStore?: WatchStore;
  watchMutations?: WatchMutationService;
  scheduledTasks?: ScheduledTaskStore;
  apps?: AgentAppCommandService;
  appAuth?: AgentAppCommandAuthService;
  resolveAppUrls?: AppCommandOptions["resolveUrls"];
  resolveAppLaunchUrls?: AppCommandOptions["resolveLaunchUrls"];
  agentSkills?: AgentSkillCommandStore;
  sessionPrompts?: SessionPromptCommandStore;
  sessionTodos?: SessionTodoCommandStore;
  subagentProfiles?: SubagentProfileCommandStore;
  credentials?: EnvCommandService;
  postgresReadonly?: PostgresReadonlyQueryCommandOptions;
  executionEnvironments?: EnvironmentReadCommandServices["environments"];
  environmentLifecycle?: EnvironmentCommandLifecycle;
  wiki?: WikiCommandService;
  subagentSessions?: SubagentSpawnSessionCreator;
  connectorAccounts?: ChannelCommandConnectorAccounts;
  conversations?: ChannelCommandConversations;
  channelMessages?: ChannelCommandMessages;
  outboundDeliveries?: ChannelCommandDeliveries;
  channelActions?: TelegramActionCommandQueue;
  email?: EmailCommandStore;
  a2aMessaging?: MessageAgentCommandQueue;
  a2aDeliveries?: A2ADeliveryReader;
}

export type AgentCommandModule = CommandCatalogModule<AgentCommandModuleDependencies>;

export interface CreateDefaultAgentCommandCatalogOptions {
  extraModules?: readonly CommandCatalogModule<any>[];
}

/** @deprecated Prefer CreateDefaultAgentCommandCatalogOptions. */
export type BuildDefaultAgentCommandModulesOptions = CreateDefaultAgentCommandCatalogOptions;

function agentCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput = "@payload.json",
  policy: AgentCommandPolicy | undefined = undefined,
  createCommand?: (dependencies: AgentCommandModuleDependencies) => RegisteredCommand | null,
  registrationPhase: CommandRegistrationPhase = "runtime",
): AgentCommandModule {
  return defineCommandCatalogModule<AgentCommandModuleDependencies>({
    descriptor,
    helpArgv,
    jsonInput,
    policy,
    registrationPhase,
    ...(createCommand ? {createCommand} : {}),
  });
}

function agentCommandModuleForPhase(registrationPhase: CommandRegistrationPhase) {
  return (
    descriptor: CommandDescriptor,
    helpArgv: readonly string[],
    jsonInput = "@payload.json",
    policy: AgentCommandPolicy | undefined = undefined,
    createCommand?: (dependencies: AgentCommandModuleDependencies) => RegisteredCommand | null,
  ): AgentCommandModule => agentCommandModule(
    descriptor,
    helpArgv,
    jsonInput,
    policy,
    createCommand,
    registrationPhase,
  );
}

const runtimeSubagentCommandModule = agentCommandModuleForPhase("runtime.subagent");
const daemonChannelCommandModule = agentCommandModuleForPhase("daemon.channel");
const daemonA2ACommandModule = agentCommandModuleForPhase("daemon.a2a");

function requireBackgroundJobService(dependencies: AgentCommandModuleDependencies): BackgroundToolJobService {
  if (!dependencies.backgroundJobService) {
    throw new Error("Agent command module requires backgroundJobService.");
  }

  return dependencies.backgroundJobService;
}

function requireCommandFileResolver(dependencies: AgentCommandModuleDependencies): AgentCommandFileResolver {
  if (!dependencies.commandFileResolver) {
    throw new Error("Agent command module requires commandFileResolver.");
  }

  return dependencies.commandFileResolver;
}

function requireWatchStore(dependencies: AgentCommandModuleDependencies): WatchStore {
  if (!dependencies.watchStore) {
    throw new Error("Agent command module requires watchStore.");
  }

  return dependencies.watchStore;
}

function requireWatchMutations(dependencies: AgentCommandModuleDependencies): WatchMutationService {
  if (!dependencies.watchMutations) {
    throw new Error("Agent command module requires watchMutations.");
  }

  return dependencies.watchMutations;
}

function requireScheduledTasks(dependencies: AgentCommandModuleDependencies): ScheduledTaskStore {
  if (!dependencies.scheduledTasks) {
    throw new Error("Agent command module requires scheduledTasks.");
  }

  return dependencies.scheduledTasks;
}

function requireApps(dependencies: AgentCommandModuleDependencies): AgentAppCommandService {
  if (!dependencies.apps) {
    throw new Error("Agent command module requires apps.");
  }

  return dependencies.apps;
}

function requireAppAuth(dependencies: AgentCommandModuleDependencies): AgentAppCommandAuthService {
  if (!dependencies.appAuth) {
    throw new Error("Agent command module requires appAuth.");
  }

  return dependencies.appAuth;
}

function requireAgentSkills(dependencies: AgentCommandModuleDependencies): AgentSkillCommandStore {
  if (!dependencies.agentSkills) {
    throw new Error("Agent command module requires agentSkills.");
  }

  return dependencies.agentSkills;
}

function requireSessionPrompts(dependencies: AgentCommandModuleDependencies): SessionPromptCommandStore {
  if (!dependencies.sessionPrompts) {
    throw new Error("Agent command module requires sessionPrompts.");
  }

  return dependencies.sessionPrompts;
}

function requireSessionTodos(dependencies: AgentCommandModuleDependencies): SessionTodoCommandStore {
  if (!dependencies.sessionTodos) {
    throw new Error("Agent command module requires sessionTodos.");
  }

  return dependencies.sessionTodos;
}

function requireSubagentProfiles(dependencies: AgentCommandModuleDependencies): SubagentProfileCommandStore {
  if (!dependencies.subagentProfiles) {
    throw new Error("Agent command module requires subagentProfiles.");
  }

  return dependencies.subagentProfiles;
}

function requirePostgresReadonly(
  dependencies: AgentCommandModuleDependencies,
): PostgresReadonlyQueryCommandOptions {
  if (!dependencies.postgresReadonly) {
    throw new Error("Agent command module requires postgresReadonly.");
  }

  return dependencies.postgresReadonly;
}

function requireExecutionEnvironments(
  dependencies: AgentCommandModuleDependencies,
): EnvironmentReadCommandServices["environments"] {
  if (!dependencies.executionEnvironments) {
    throw new Error("Agent command module requires executionEnvironments.");
  }

  return dependencies.executionEnvironments;
}

function requireEnvironmentLifecycle(dependencies: AgentCommandModuleDependencies): EnvironmentCommandLifecycle {
  if (!dependencies.environmentLifecycle) {
    throw new Error("Agent command module requires environmentLifecycle.");
  }

  return dependencies.environmentLifecycle;
}

function requireConnectorAccounts(
  dependencies: AgentCommandModuleDependencies,
): ChannelCommandConnectorAccounts {
  if (!dependencies.connectorAccounts) {
    throw new Error("Agent command module requires connectorAccounts.");
  }

  return dependencies.connectorAccounts;
}

function requireConversations(dependencies: AgentCommandModuleDependencies): ChannelCommandConversations {
  if (!dependencies.conversations) {
    throw new Error("Agent command module requires conversations.");
  }

  return dependencies.conversations;
}

function requireChannelMessages(dependencies: AgentCommandModuleDependencies): ChannelCommandMessages {
  if (!dependencies.channelMessages) {
    throw new Error("Agent command module requires channelMessages.");
  }

  return dependencies.channelMessages;
}

function requireOutboundDeliveries(dependencies: AgentCommandModuleDependencies): ChannelCommandDeliveries {
  if (!dependencies.outboundDeliveries) {
    throw new Error("Agent command module requires outboundDeliveries.");
  }

  return dependencies.outboundDeliveries;
}

function requireChannelActions(dependencies: AgentCommandModuleDependencies): TelegramActionCommandQueue {
  if (!dependencies.channelActions) {
    throw new Error("Agent command module requires channelActions.");
  }

  return dependencies.channelActions;
}

function requireEmail(dependencies: AgentCommandModuleDependencies): EmailCommandStore {
  if (!dependencies.email) {
    throw new Error("Agent command module requires email.");
  }

  return dependencies.email;
}

function requireA2AMessaging(dependencies: AgentCommandModuleDependencies): MessageAgentCommandQueue {
  if (!dependencies.a2aMessaging) {
    throw new Error("Agent command module requires a2aMessaging.");
  }

  return dependencies.a2aMessaging;
}

function requireA2ADeliveries(dependencies: AgentCommandModuleDependencies): A2ADeliveryReader {
  if (!dependencies.a2aDeliveries) {
    throw new Error("Agent command module requires a2aDeliveries.");
  }

  return dependencies.a2aDeliveries;
}

/**
 * Source of truth for the default model-facing Panda Command catalog.
 *
 * Keep this list ordered for agent scanability: common core, mutable domains,
 * messaging/channels, environment/secret helpers, and media/provider commands.
 */
const DEFAULT_AGENT_COMMAND_MODULE_LIST: readonly AgentCommandModule[] = [
  agentCommandModule(
    timeNowCommandDescriptor,
    ["time", "now"],
    "{}",
    undefined,
    () => createTimeNowCommand(),
  ),
  agentCommandModule(
    mcpToolsCommandDescriptor,
    ["mcp", "tools"],
    "@payload.json",
    agentCommandPolicy(["mcp"], {capability: MCP_COMMAND_CAPABILITY}),
    (dependencies) => createMcpToolsCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    mcpCallCommandDescriptor,
    ["mcp", "call"],
    "@payload.json",
    agentCommandPolicy(["mcp"], {capability: MCP_COMMAND_CAPABILITY}),
    (dependencies) => createMcpCallCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    watchListCommandDescriptor,
    ["watch", "list"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createWatchListCommand(requireWatchStore(dependencies)),
  ),
  agentCommandModule(
    watchShowCommandDescriptor,
    ["watch", "show"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createWatchShowCommand(requireWatchStore(dependencies)),
  ),
  agentCommandModule(
    watchRunsCommandDescriptor,
    ["watch", "runs"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createWatchRunsCommand(requireWatchStore(dependencies)),
  ),
  agentCommandModule(
    watchCreateCommandDescriptor,
    ["watch", "create"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createWatchCreateCommand(requireWatchMutations(dependencies)),
  ),
  agentCommandModule(
    watchUpdateCommandDescriptor,
    ["watch", "update"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createWatchUpdateCommand(requireWatchMutations(dependencies)),
  ),
  agentCommandModule(
    watchDisableCommandDescriptor,
    ["watch", "disable"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createWatchDisableCommand(requireWatchStore(dependencies)),
  ),
  agentCommandModule(
    scheduleListCommandDescriptor,
    ["schedule", "list"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createScheduleListCommand(requireScheduledTasks(dependencies)),
  ),
  agentCommandModule(
    scheduleShowCommandDescriptor,
    ["schedule", "show"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createScheduleShowCommand(requireScheduledTasks(dependencies)),
  ),
  agentCommandModule(
    scheduleRunsCommandDescriptor,
    ["schedule", "runs"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createScheduleRunsCommand(requireScheduledTasks(dependencies)),
  ),
  agentCommandModule(
    scheduleCreateCommandDescriptor,
    ["schedule", "create"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createScheduleCreateCommand(requireScheduledTasks(dependencies)),
  ),
  agentCommandModule(
    scheduleUpdateCommandDescriptor,
    ["schedule", "update"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createScheduleUpdateCommand(requireScheduledTasks(dependencies)),
  ),
  agentCommandModule(
    scheduleCancelCommandDescriptor,
    ["schedule", "cancel"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createScheduleCancelCommand(requireScheduledTasks(dependencies)),
  ),
  agentCommandModule(
    appCheckCommandDescriptor,
    ["micro-app", "check"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createAppCheckCommand(requireApps(dependencies)),
  ),
  agentCommandModule(
    appCreateCommandDescriptor,
    ["micro-app", "create"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createAppCreateCommand(requireApps(dependencies), {
      resolveUrls: dependencies.resolveAppUrls,
    }),
  ),
  agentCommandModule(
    appLinkCreateCommandDescriptor,
    ["micro-app", "link", "create"],
    "@payload.json",
    agentCommandPolicy(["operate"], {
      requiresIdentity: true,
    }),
    (dependencies) => createAppLinkCreateCommand(
      requireApps(dependencies),
      requireAppAuth(dependencies),
      {
        resolveLaunchUrls: dependencies.resolveAppLaunchUrls,
      },
    ),
  ),
  agentCommandModule(
    appListCommandDescriptor,
    ["micro-app", "list"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createAppListCommand(requireApps(dependencies), {
      resolveUrls: dependencies.resolveAppUrls,
    }),
  ),
  agentCommandModule(
    appViewCommandDescriptor,
    ["micro-app", "view"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createAppViewCommand(requireApps(dependencies)),
  ),
  agentCommandModule(
    appActionCommandDescriptor,
    ["micro-app", "action"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createAppActionCommand(requireApps(dependencies)),
  ),
  agentCommandModule(
    environmentCreateCommandDescriptor,
    ["environment", "create"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createEnvironmentCreateCommand({
      lifecycle: requireEnvironmentLifecycle(dependencies),
    }, requireCommandFileResolver(dependencies)),
  ),
  agentCommandModule(
    environmentListCommandDescriptor,
    ["environment", "list"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createEnvironmentListCommand({
      environments: requireExecutionEnvironments(dependencies),
    }),
  ),
  agentCommandModule(
    environmentShowCommandDescriptor,
    ["environment", "show"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createEnvironmentShowCommand({
      environments: requireExecutionEnvironments(dependencies),
    }),
  ),
  agentCommandModule(
    environmentStopCommandDescriptor,
    ["environment", "stop"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createEnvironmentStopCommand({
      environments: requireExecutionEnvironments(dependencies),
      lifecycle: requireEnvironmentLifecycle(dependencies),
    }),
  ),
  agentCommandModule(
    environmentLogsCommandDescriptor,
    ["environment", "logs"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createEnvironmentLogsCommand({
      environments: requireExecutionEnvironments(dependencies),
      lifecycle: requireEnvironmentLifecycle(dependencies),
    }),
  ),
  agentCommandModule(skillListCommandDescriptor, ["skill", "list"], "@payload.json", agentCommandPolicy(["core", "operate", "skill_maintenance"], {
    requiredAgentSkillOperation: "load",
  }), (dependencies) => createSkillListCommand(requireAgentSkills(dependencies))),
  agentCommandModule(skillShowCommandDescriptor, ["skill", "show"], "@payload.json", agentCommandPolicy(["core", "operate", "skill_maintenance"], {
    requiredAgentSkillOperation: "load",
  }), (dependencies) => createSkillShowCommand(requireAgentSkills(dependencies))),
  agentCommandModule(skillLoadCommandDescriptor, ["skill", "load"], "@payload.json", agentCommandPolicy(["core", "operate", "skill_maintenance"], {
    requiredAgentSkillOperation: "load",
  }), (dependencies) => createSkillLoadCommand(requireAgentSkills(dependencies))),
  agentCommandModule(skillSetCommandDescriptor, ["skill", "set"], "@payload.json", agentCommandPolicy(["operate", "skill_maintenance"], {
    requiredAgentSkillOperation: "set",
  }), (dependencies) => createSkillSetCommand(requireAgentSkills(dependencies))),
  agentCommandModule(skillPatchCommandDescriptor, ["skill", "patch"], "@payload.json", agentCommandPolicy(["operate", "skill_maintenance"], {
    requiredAgentSkillOperation: "patch",
  }), (dependencies) => createSkillPatchCommand(requireAgentSkills(dependencies))),
  agentCommandModule(skillDeleteCommandDescriptor, ["skill", "delete"], "@payload.json", agentCommandPolicy(["operate", "skill_maintenance"], {
    requiredAgentSkillOperation: "delete",
  }), (dependencies) => createSkillDeleteCommand(requireAgentSkills(dependencies))),
  agentCommandModule(postgresReadonlyQueryCommandDescriptor, ["postgres", "readonly", "query"], "@payload.json", agentCommandPolicy(["memory"], {
    requiresReadonlyPostgres: true,
  }), (dependencies) => createPostgresReadonlyQueryCommand(requirePostgresReadonly(dependencies))),
  agentCommandModule(
    wikiReadCommandDescriptor,
    ["wiki", "read"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiReadCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    wikiSearchCommandDescriptor,
    ["wiki", "search"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiSearchCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    wikiListCommandDescriptor,
    ["wiki", "list"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiListCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    wikiDiffCommandDescriptor,
    ["wiki", "diff"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiDiffCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    wikiWriteCommandDescriptor,
    ["wiki", "write", "page"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiWriteCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    wikiWriteSectionCommandDescriptor,
    ["wiki", "write", "section"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiWriteSectionCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    wikiMoveCommandDescriptor,
    ["wiki", "move"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiMoveCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    wikiArchiveCommandDescriptor,
    ["wiki", "archive"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiArchiveCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    wikiRestoreCommandDescriptor,
    ["wiki", "restore"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiRestoreCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    wikiAttachImageCommandDescriptor,
    ["wiki", "attach", "image"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki
      ? createWikiAttachImageCommand(dependencies.wiki, requireCommandFileResolver(dependencies))
      : null,
  ),
  agentCommandModule(
    wikiFetchAssetCommandDescriptor,
    ["wiki", "fetch", "asset"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiFetchAssetCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    wikiDeleteAssetCommandDescriptor,
    ["wiki", "delete", "asset"],
    "@payload.json",
    agentCommandPolicy(["memory"]),
    (dependencies) => dependencies.wiki ? createWikiDeleteAssetCommand(dependencies.wiki) : null,
  ),
  agentCommandModule(
    sessionPromptReadCommandDescriptor,
    ["session", "prompt", "current", "read"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createSessionPromptReadCommand(requireSessionPrompts(dependencies)),
  ),
  agentCommandModule(
    sessionPromptSetCommandDescriptor,
    ["session", "prompt", "current", "set"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createSessionPromptSetCommand(requireSessionPrompts(dependencies)),
  ),
  agentCommandModule(
    sessionPromptTransformCommandDescriptor,
    ["session", "prompt", "current", "transform"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createSessionPromptTransformCommand(requireSessionPrompts(dependencies)),
  ),
  agentCommandModule(
    todoAddCommandDescriptor,
    ["todo", "add"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createTodoAddCommand(requireSessionTodos(dependencies)),
  ),
  agentCommandModule(
    todoListCommandDescriptor,
    ["todo", "list"],
    "{}",
    agentCommandPolicy(["core"]),
    (dependencies) => createTodoListCommand(requireSessionTodos(dependencies)),
  ),
  agentCommandModule(
    todoShowCommandDescriptor,
    ["todo", "show"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createTodoShowCommand(requireSessionTodos(dependencies)),
  ),
  agentCommandModule(
    todoDoneCommandDescriptor,
    ["todo", "done"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createTodoDoneCommand(requireSessionTodos(dependencies)),
  ),
  agentCommandModule(
    todoBlockCommandDescriptor,
    ["todo", "block"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createTodoBlockCommand(requireSessionTodos(dependencies)),
  ),
  agentCommandModule(
    todoClearCommandDescriptor,
    ["todo", "clear"],
    "{}",
    agentCommandPolicy(["core"]),
    (dependencies) => createTodoClearCommand(requireSessionTodos(dependencies)),
  ),
  runtimeSubagentCommandModule(
    subagentSpawnCommandDescriptor,
    ["subagent", "spawn"],
    "@payload.json",
    undefined,
    (dependencies) => dependencies.subagentSessions
      ? createSubagentSpawnCommand(dependencies.subagentSessions)
      : null,
  ),
  agentCommandModule(
    subagentProfileListCommandDescriptor,
    ["subagent", "profile", "list"],
    "{}",
    agentCommandPolicy(["operate"]),
    (dependencies) => createSubagentProfileListCommand(requireSubagentProfiles(dependencies)),
  ),
  agentCommandModule(
    subagentProfileShowCommandDescriptor,
    ["subagent", "profile", "show"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createSubagentProfileShowCommand(requireSubagentProfiles(dependencies)),
  ),
  agentCommandModule(
    subagentProfileUpsertCommandDescriptor,
    ["subagent", "profile", "upsert"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createSubagentProfileUpsertCommand(requireSubagentProfiles(dependencies)),
  ),
  agentCommandModule(
    subagentProfileEnableCommandDescriptor,
    ["subagent", "profile", "enable"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createSubagentProfileEnableCommand(requireSubagentProfiles(dependencies)),
  ),
  agentCommandModule(
    subagentProfileDisableCommandDescriptor,
    ["subagent", "profile", "disable"],
    "@payload.json",
    agentCommandPolicy(["operate"]),
    (dependencies) => createSubagentProfileDisableCommand(requireSubagentProfiles(dependencies)),
  ),
  daemonA2ACommandModule(
    a2aSendCommandDescriptor,
    ["a2a", "send"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createA2ASendCommand(
      requireA2AMessaging(dependencies),
      requireCommandFileResolver(dependencies),
    ),
  ),
  daemonA2ACommandModule(
    a2aInspectCommandDescriptor,
    ["a2a", "inspect"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createA2AInspectCommand(requireA2ADeliveries(dependencies)),
  ),
  daemonA2ACommandModule(
    a2aHistoryCommandDescriptor,
    ["a2a", "history"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createA2AHistoryCommand(requireA2ADeliveries(dependencies)),
  ),
  daemonChannelCommandModule(
    emailAccountListCommandDescriptor,
    ["email", "account", "list"],
    "{}",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createEmailAccountListCommand({
      store: requireEmail(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    emailListCommandDescriptor,
    ["email", "list"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createEmailListCommand({
      store: requireEmail(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    emailReadCommandDescriptor,
    ["email", "read"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createEmailReadCommand({
      store: requireEmail(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    emailSearchCommandDescriptor,
    ["email", "search"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createEmailSearchCommand({
      store: requireEmail(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    emailAttachmentsFetchCommandDescriptor,
    ["email", "attachments", "fetch"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createEmailAttachmentsFetchCommand({
      store: requireEmail(dependencies),
    }, requireCommandFileResolver(dependencies)),
  ),
  daemonChannelCommandModule(
    emailSendCommandDescriptor,
    ["email", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createEmailSendCommand({
      store: requireEmail(dependencies),
      queue: requireOutboundDeliveries(dependencies),
    }, requireCommandFileResolver(dependencies)),
  ),
  daemonChannelCommandModule(
    telegramChatListCommandDescriptor,
    ["telegram", "chat", "list"],
    "{}",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramChatListCommand({
      connectorAccounts: requireConnectorAccounts(dependencies),
      conversations: requireConversations(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    telegramChatInfoCommandDescriptor,
    ["telegram", "chat", "info"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramChatInfoCommand({
      connectorAccounts: requireConnectorAccounts(dependencies),
      conversations: requireConversations(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    telegramHistoryCommandDescriptor,
    ["telegram", "history"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramHistoryCommand({
      connectorAccounts: requireConnectorAccounts(dependencies),
      conversations: requireConversations(dependencies),
      messages: requireChannelMessages(dependencies),
      deliveries: requireOutboundDeliveries(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    telegramMediaFetchCommandDescriptor,
    ["telegram", "media", "fetch"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramMediaFetchCommand({
      connectorAccounts: requireConnectorAccounts(dependencies),
      conversations: requireConversations(dependencies),
      messages: requireChannelMessages(dependencies),
    }, requireCommandFileResolver(dependencies)),
  ),
  daemonChannelCommandModule(
    telegramSendCommandDescriptor,
    ["telegram", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramSendCommand(
      requireOutboundDeliveries(dependencies),
      requireCommandFileResolver(dependencies),
    ),
  ),
  daemonChannelCommandModule(
    telegramReactCommandDescriptor,
    ["telegram", "react"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramReactCommand(requireChannelActions(dependencies)),
  ),
  daemonChannelCommandModule(
    telegramEditCommandDescriptor,
    ["telegram", "edit"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramEditCommand(requireChannelActions(dependencies)),
  ),
  daemonChannelCommandModule(
    telegramDeleteCommandDescriptor,
    ["telegram", "delete"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramDeleteCommand(requireChannelActions(dependencies)),
  ),
  daemonChannelCommandModule(
    telegramPinCommandDescriptor,
    ["telegram", "pin"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramPinCommand(requireChannelActions(dependencies)),
  ),
  daemonChannelCommandModule(
    telegramUnpinCommandDescriptor,
    ["telegram", "unpin"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramUnpinCommand(requireChannelActions(dependencies)),
  ),
  daemonChannelCommandModule(
    telegramStickerSendCommandDescriptor,
    ["telegram", "sticker", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createTelegramStickerSendCommand(
      requireChannelActions(dependencies),
      requireCommandFileResolver(dependencies),
    ),
  ),
  daemonChannelCommandModule(
    discordChannelListCommandDescriptor,
    ["discord", "channel", "list"],
    "{}",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createDiscordChannelListCommand({
      connectorAccounts: requireConnectorAccounts(dependencies),
      conversations: requireConversations(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    discordHistoryCommandDescriptor,
    ["discord", "history"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createDiscordHistoryCommand({
      connectorAccounts: requireConnectorAccounts(dependencies),
      conversations: requireConversations(dependencies),
      messages: requireChannelMessages(dependencies),
      deliveries: requireOutboundDeliveries(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    discordSendCommandDescriptor,
    ["discord", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createDiscordSendCommand(
      requireOutboundDeliveries(dependencies),
      requireCommandFileResolver(dependencies),
    ),
  ),
  daemonChannelCommandModule(
    whatsappChatListCommandDescriptor,
    ["whatsapp", "chat", "list"],
    "{}",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createWhatsAppChatListCommand({
      conversations: requireConversations(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    whatsappHistoryCommandDescriptor,
    ["whatsapp", "history"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createWhatsAppHistoryCommand({
      conversations: requireConversations(dependencies),
      messages: requireChannelMessages(dependencies),
      deliveries: requireOutboundDeliveries(dependencies),
    }),
  ),
  daemonChannelCommandModule(
    whatsappSendCommandDescriptor,
    ["whatsapp", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"]),
    (dependencies) => createWhatsAppSendCommand(
      requireOutboundDeliveries(dependencies),
      requireCommandFileResolver(dependencies),
    ),
  ),
  agentCommandModule(
    envListCommandDescriptor,
    ["env", "list"],
    "{}",
    agentCommandPolicy(["operate"]),
    (dependencies) => dependencies.credentials
      ? createListEnvValuesCommand(dependencies.credentials)
      : null,
  ),
  agentCommandModule(envSetCommandDescriptor, ["env", "set"], "@payload.json", agentCommandPolicy(["operate"], {
    requiresCredentialMutation: true,
  }), (dependencies) => dependencies.credentials
    ? createSetEnvValueCommand(dependencies.credentials)
    : null),
  agentCommandModule(envClearCommandDescriptor, ["env", "clear"], "@payload.json", agentCommandPolicy(["operate"], {
    requiresCredentialMutation: true,
  }), (dependencies) => dependencies.credentials
    ? createClearEnvValueCommand(dependencies.credentials)
    : null),
  agentCommandModule(
    ventSendCommandDescriptor,
    ["vent"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createVentSendCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    webFetchCommandDescriptor,
    ["web", "fetch"],
    "@payload.json",
    agentCommandPolicy(["internet"]),
    (dependencies) => createWebFetchCommand({
      fileResolver: requireCommandFileResolver(dependencies),
    }),
  ),
  agentCommandModule(
    braveWebSearchCommandDescriptor,
    ["brave", "web", "search"],
    "@payload.json",
    agentCommandPolicy(["internet"]),
    (dependencies) => createBraveWebSearchCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    braveNewsSearchCommandDescriptor,
    ["brave", "news", "search"],
    "@payload.json",
    agentCommandPolicy(["internet"]),
    (dependencies) => createBraveNewsSearchCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    braveVideoSearchCommandDescriptor,
    ["brave", "video", "search"],
    "@payload.json",
    agentCommandPolicy(["internet"]),
    (dependencies) => createBraveVideoSearchCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    braveImageSearchCommandDescriptor,
    ["brave", "image", "search"],
    "@payload.json",
    agentCommandPolicy(["internet"]),
    (dependencies) => createBraveImageSearchCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    braveLlmContextCommandDescriptor,
    ["brave", "llm", "context"],
    "@payload.json",
    agentCommandPolicy(["internet"]),
    (dependencies) => createBraveLlmContextCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    bravePlaceSearchCommandDescriptor,
    ["brave", "place", "search"],
    "@payload.json",
    agentCommandPolicy(["internet"]),
    (dependencies) => createBravePlaceSearchCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    bravePlacePoiCommandDescriptor,
    ["brave", "place", "poi"],
    "@payload.json",
    agentCommandPolicy(["internet"]),
    (dependencies) => createBravePlacePoiCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    bravePlaceDescriptionCommandDescriptor,
    ["brave", "place", "description"],
    "@payload.json",
    agentCommandPolicy(["internet"]),
    (dependencies) => createBravePlaceDescriptionCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    openAIWebResearchCommandDescriptor,
    ["openai", "web-research"],
    "@payload.json",
    agentCommandPolicy(["internet"]),
    (dependencies) => createOpenAIWebResearchCommand({
      env: dependencies.env,
      jobService: requireBackgroundJobService(dependencies),
    }),
  ),
  agentCommandModule(
    imageGenerateCommandDescriptor,
    ["image", "generate"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createImageGenerateCommand({
      env: dependencies.env,
      jobService: requireBackgroundJobService(dependencies),
    }, requireCommandFileResolver(dependencies)),
  ),
  agentCommandModule(
    whisperTranscribeCommandDescriptor,
    ["whisper", "transcribe"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createWhisperTranscribeCommand({
      env: dependencies.env,
    }, requireCommandFileResolver(dependencies)),
  ),
  agentCommandModule(
    whisperTranslateCommandDescriptor,
    ["whisper", "translate"],
    "@payload.json",
    agentCommandPolicy(["core"]),
    (dependencies) => createWhisperTranslateCommand({
      env: dependencies.env,
    }, requireCommandFileResolver(dependencies)),
  ),
];

export function createDefaultAgentCommandCatalog(
  options: CreateDefaultAgentCommandCatalogOptions = {},
): CommandCatalog<AgentCommandModuleDependencies, CommandCatalogModule<any>> {
  return createCommandCatalog<AgentCommandModuleDependencies, CommandCatalogModule<any>>(
    DEFAULT_AGENT_COMMAND_MODULE_LIST,
    options.extraModules ?? [],
  );
}

export const DEFAULT_AGENT_COMMAND_CATALOG: CommandCatalog<
  AgentCommandModuleDependencies,
  CommandCatalogModule<any>
> = createDefaultAgentCommandCatalog();

export const DEFAULT_AGENT_COMMAND_MODULES: readonly AgentCommandModule[] =
  DEFAULT_AGENT_COMMAND_MODULE_LIST;

/** @deprecated Prefer createDefaultAgentCommandCatalog(...).modules. */
export function buildDefaultAgentCommandModules(
  options: BuildDefaultAgentCommandModulesOptions = {},
): readonly CommandCatalogModule<any>[] {
  return createDefaultAgentCommandCatalog(options).modules;
}
