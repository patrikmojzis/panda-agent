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
import type {CommandUploadStore} from "../../domain/commands/uploads.js";
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
  createCronCreateCommand,
  createCronDeleteCommand,
  createCronDisableCommand,
  createCronEnableCommand,
  createCronListCommand,
  createCronRunCommand,
  createCronRunsCommand,
  createCronShowCommand,
  createCronUpdateCommand,
  cronCreateCommandDescriptor,
  cronDeleteCommandDescriptor,
  cronDisableCommandDescriptor,
  cronEnableCommandDescriptor,
  cronListCommandDescriptor,
  cronRunCommandDescriptor,
  cronRunsCommandDescriptor,
  cronShowCommandDescriptor,
  cronUpdateCommandDescriptor,
} from "../../domain/scheduling/scheduled-commands/commands.js";
import type {ScheduledCommandService} from "../../domain/scheduling/scheduled-commands/service.js";
import {
  createSessionPromptReadCommand,
  createSessionPromptSetCommand,
  createSessionPromptTransformCommand,
  sessionPromptReadCommandDescriptor,
  sessionPromptSetCommandDescriptor,
  sessionPromptTransformCommandDescriptor,
  type SessionPromptCommandStore,
} from "../../domain/sessions/prompt-commands.js";
import {createSessionCompactCommand, sessionCompactCommandDescriptor} from "../../domain/sessions/compaction-commands.js";
import type {SessionCompactionStore} from "../../domain/sessions/compaction.js";
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
  SUBAGENT_SPAWN_COMMAND_NAME,
  type SubagentSpawnSessionCreator,
  type SubagentProfileListCommandStore,
  type SubagentProfileShowCommandStore,
  type SubagentProfileStateCommandStore,
  type SubagentProfileUpsertCommandStore,
} from "../../domain/subagents/commands.js";
import {
  createSubagentListCommand,
  createSubagentShowCommand,
  subagentListCommandDescriptor,
  subagentShowCommandDescriptor,
} from "../../domain/subagents/inventory-commands.js";
import type {SubagentInventoryReader} from "../../domain/subagents/inventory.js";
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
import type {CredentialResolver} from "../../domain/credentials/resolver.js";
import type {McpConfigReader} from "../../domain/mcp/store.js";
import type {McpRunner} from "../../domain/mcp/types.js";
import {
  createMcpOauthDiscoverCommand,
  createMcpOauthDisconnectCommand,
  createMcpOauthStartCommand,
  createMcpOauthStatusCommand,
  createMcpServerAddCommand,
  createMcpServerDeleteCommand,
  createMcpServerDisableCommand,
  createMcpServerEnableCommand,
  createMcpServerListCommand,
  createMcpServerShowCommand,
  createMcpServerTestCommand,
  createMcpServerUpdateCommand,
  MCP_MANAGEMENT_CAPABILITY,
  mcpOauthDiscoverCommandDescriptor,
  mcpOauthDisconnectCommandDescriptor,
  mcpOauthStartCommandDescriptor,
  mcpOauthStatusCommandDescriptor,
  mcpServerAddCommandDescriptor,
  mcpServerDeleteCommandDescriptor,
  mcpServerDisableCommandDescriptor,
  mcpServerEnableCommandDescriptor,
  mcpServerListCommandDescriptor,
  mcpServerShowCommandDescriptor,
  mcpServerTestCommandDescriptor,
  mcpServerUpdateCommandDescriptor,
} from "../../domain/mcp/management-commands.js";
import type {McpManagementService} from "../../domain/mcp/management-service.js";
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
  createWikiOverviewCommand,
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
  wikiOverviewCommandDescriptor,
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
  createDiscordGifSendCommand,
  createDiscordHistoryCommand,
  createDiscordSendCommand,
  createDiscordStickerListCommand,
  createDiscordStickerSendCommand,
  type DiscordChannelListCommandServices,
  type DiscordGifSendCommandServices,
  type DiscordStickerCatalogReader,
  type DiscordStickerSendCommandServices,
  discordChannelListCommandDescriptor,
  discordGifSendCommandDescriptor,
  discordHistoryCommandDescriptor,
  discordSendCommandDescriptor,
  discordStickerListCommandDescriptor,
  discordStickerSendCommandDescriptor,
} from "../../integrations/channels/discord/commands.js";
import type {DiscordGifService} from "../../integrations/channels/discord/gifs.js";
import {
  createDiscordVoiceJoinCommand,
  createDiscordVoiceLeaveCommand,
  createDiscordVoiceSendCommand,
  createDiscordVoiceStatusCommand,
  discordVoiceJoinCommandDescriptor,
  discordVoiceLeaveCommandDescriptor,
  discordVoiceSendCommandDescriptor,
  discordVoiceStatusCommandDescriptor,
  type DiscordVoiceCommandServices,
} from "../../integrations/channels/discord/voice-commands.js";
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
import type {TelegramStickerLibrary} from "../../domain/agents/telegram-stickers/service.js";
import {
  createTelegramStickerInspectCommand,
  createTelegramStickerListCommand,
  createTelegramStickerSaveCommand,
  createTelegramStickerSetSaveCommand,
  createTelegramStickerSetShowCommand,
  telegramStickerInspectCommandDescriptor,
  telegramStickerListCommandDescriptor,
  telegramStickerSaveCommandDescriptor,
  telegramStickerSetSaveCommandDescriptor,
  telegramStickerSetShowCommandDescriptor,
} from "../../integrations/channels/telegram/sticker-commands.js";
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
  createWhatsAppCallHangupCommand,
  createWhatsAppCallSendCommand,
  createWhatsAppCallStatusCommand,
  whatsappCallHangupCommandDescriptor,
  whatsappCallSendCommandDescriptor,
  whatsappCallStatusCommandDescriptor,
  type WhatsAppCallCommandServices,
} from "../../integrations/channels/whatsapp/calls/commands.js";
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
  createWebReadCommand,
  openAIWebResearchCommandDescriptor,
  webFetchCommandDescriptor,
  webReadCommandDescriptor,
} from "../../integrations/web/commands.js";
import type {BraveThrottleGate} from "../../integrations/web/brave-throttle.js";
import {
  createHeartbeatShowCommand,
  createHeartbeatSetCommand,
  heartbeatShowCommandDescriptor,
  heartbeatSetCommandDescriptor,
} from "../../domain/scheduling/heartbeats/commands.js";
import type {HeartbeatCadenceBounds} from "../../domain/scheduling/heartbeats/config.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {
  createImageGenerateCommand,
  imageGenerateCommandDescriptor,
} from "./image-generate-command.js";

type WatchCommandStore = Pick<WatchStore, "listWatches" | "getWatch" | "listWatchRuns" | "disableWatch">;
type WatchCommandMutations = Pick<WatchMutationService, "createWatch" | "updateWatch">;
type ScheduledTaskCommandStore = Pick<
  ScheduledTaskStore,
  "listTasks" | "getTask" | "listTaskRuns" | "createTask" | "updateTask" | "cancelTask"
>;

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
type ChannelActionCommandQueue = TelegramActionCommandQueue & DiscordStickerSendCommandServices;
type OutboundCommandQueue =
  & ExplicitChannelSendCommandServices
  & DiscordGifSendCommandServices
  & EmailSendCommandQueue
  & TelegramSendCommandQueue;
type ChannelCommandConnectorAccounts =
  & TelegramChatListCommandServices["connectorAccounts"]
  & DiscordChannelListCommandServices["connectorAccounts"];
type ChannelCommandConversations =
  TelegramHistoryCommandServices["conversations"]
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
  braveThrottleGate?: BraveThrottleGate;
  backgroundJobService?: BackgroundToolJobService;
  commandFileResolver?: AgentCommandFileResolver;
  commandUploads?: CommandUploadStore;
  watchStore?: WatchCommandStore;
  watchMutations?: WatchCommandMutations;
  scheduledTasks?: ScheduledTaskCommandStore;
  scheduledCommands?: ScheduledCommandService;
  apps?: AgentAppCommandService;
  appAuth?: AgentAppCommandAuthService;
  resolveAppUrls?: AppCommandOptions["resolveUrls"];
  resolveAppLaunchUrls?: AppCommandOptions["resolveLaunchUrls"];
  agentSkills?: AgentSkillCommandStore;
  sessionPrompts?: SessionPromptCommandStore;
  sessionTodos?: SessionTodoCommandStore;
  sessionHeartbeats?: Pick<SessionStore, "getHeartbeat" | "updateHeartbeatConfig">;
  heartbeatBounds?: HeartbeatCadenceBounds;
  sessionCompactionRequests?: Pick<SessionCompactionStore, "request">;
  subagentProfiles?: SubagentProfileCommandStore;
  subagentInventory?: SubagentInventoryReader;
  credentials?: EnvCommandService;
  credentialResolver?: Pick<CredentialResolver, "resolveCredential">;
  mcpConfigs?: McpConfigReader;
  mcpRunner?: McpRunner;
  mcpManagement?: McpManagementService;
  postgresReadonly?: PostgresReadonlyQueryCommandOptions;
  executionEnvironments?: EnvironmentReadCommandServices["environments"];
  environmentLifecycle?: EnvironmentCommandLifecycle;
  wiki?: WikiCommandService;
  subagentSessions?: SubagentSpawnSessionCreator;
  connectorAccounts?: ChannelCommandConnectorAccounts;
  conversations?: ChannelCommandConversations;
  channelMessages?: ChannelCommandMessages;
  outboundDeliveries?: ChannelCommandDeliveries;
  channelActions?: ChannelActionCommandQueue;
  discordStickers?: DiscordStickerCatalogReader;
  discordGifs?: DiscordGifService;
  discordVoice?: DiscordVoiceCommandServices["voice"];
  whatsappCalls?: WhatsAppCallCommandServices["calls"];
  telegramStickers?: TelegramStickerLibrary;
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

function mcpManagementCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  createCommand: (service: McpManagementService) => RegisteredCommand,
  jsonInput = "@payload.json",
): AgentCommandModule {
  return agentCommandModule(
    descriptor,
    helpArgv,
    jsonInput,
    agentCommandPolicy(["operate"], {defaultAllowed: false, capability: MCP_MANAGEMENT_CAPABILITY}),
    (dependencies) => {
      if (!dependencies.mcpManagement) throw new Error("Agent command module requires MCP management service.");
      return createCommand(dependencies.mcpManagement);
    },
  );
}

// Public catalog callers may supply only selected services. Family adapters validate that
// compatibility boundary; their command constructors receive required, narrow services.
function watchStoreCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  createCommand: (services: WatchCommandStore) => RegisteredCommand,
  jsonInput = "@payload.json",
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, agentCommandPolicy(["operate"], {defaultAllowed: true}), (dependencies) => {
    if (!dependencies.watchStore) throw new Error("Agent command module requires watchStore.");
    return createCommand(dependencies.watchStore);
  });
}

function watchMutationCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  createCommand: (services: WatchCommandMutations) => RegisteredCommand,
  jsonInput = "@payload.json",
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, agentCommandPolicy(["operate"], {defaultAllowed: true}), (dependencies) => {
    if (!dependencies.watchMutations) throw new Error("Agent command module requires watchMutations.");
    return createCommand(dependencies.watchMutations);
  });
}

function scheduledTaskCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  createCommand: (services: ScheduledTaskCommandStore) => RegisteredCommand,
  jsonInput = "@payload.json",
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, agentCommandPolicy(["operate"], {defaultAllowed: true}), (dependencies) => {
    if (!dependencies.scheduledTasks) throw new Error("Agent command module requires scheduledTasks.");
    return createCommand(dependencies.scheduledTasks);
  });
}

function agentSkillCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  policy: AgentCommandPolicy,
  createCommand: (services: AgentSkillCommandStore) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, "@payload.json", policy, (dependencies) => {
    if (!dependencies.agentSkills) throw new Error("Agent command module requires agentSkills.");
    return createCommand(dependencies.agentSkills);
  });
}

function sessionPromptCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  createCommand: (services: SessionPromptCommandStore) => RegisteredCommand,
  jsonInput = "@payload.json",
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, agentCommandPolicy(["operate"], {defaultAllowed: true}), (dependencies) => {
    if (!dependencies.sessionPrompts) throw new Error("Agent command module requires sessionPrompts.");
    return createCommand(dependencies.sessionPrompts);
  });
}

function todoCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  createCommand: (services: SessionTodoCommandStore) => RegisteredCommand,
  jsonInput = "@payload.json",
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, agentCommandPolicy(["core"], {defaultAllowed: true}), (dependencies) => {
    if (!dependencies.sessionTodos) throw new Error("Agent command module requires sessionTodos.");
    return createCommand(dependencies.sessionTodos);
  });
}

function subagentProfileCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  createCommand: (services: SubagentProfileCommandStore) => RegisteredCommand,
  jsonInput = "@payload.json",
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, agentCommandPolicy(["operate"], {defaultAllowed: true}), (dependencies) => {
    if (!dependencies.subagentProfiles) throw new Error("Agent command module requires subagentProfiles.");
    return createCommand(dependencies.subagentProfiles);
  });
}

function subagentInventoryCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  createCommand: (services: SubagentInventoryReader) => RegisteredCommand,
  jsonInput = "@payload.json",
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, agentCommandPolicy([], {defaultAllowed: true, capability: SUBAGENT_SPAWN_COMMAND_NAME}), (dependencies) => {
    if (!dependencies.subagentInventory) throw new Error("Agent command module requires subagentInventory.");
    return createCommand(dependencies.subagentInventory);
  });
}

function mcpCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (services: Parameters<typeof createMcpToolsCommand>[0]) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.mcpConfigs || !dependencies.mcpRunner || !dependencies.credentialResolver) {
      throw new Error("Agent command module requires MCP registry, runner, and credential resolver.");
    }
    return createCommand({configs: dependencies.mcpConfigs, runner: dependencies.mcpRunner, credentials: dependencies.credentialResolver});
  });
}

function appCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (apps: AgentAppCommandService, options: AppCommandOptions) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.apps) throw new Error("Agent command module requires apps.");
    return createCommand(dependencies.apps, {resolveUrls: dependencies.resolveAppUrls});
  });
}

function environmentReadCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (services: EnvironmentReadCommandServices) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.executionEnvironments) throw new Error("Agent command module requires executionEnvironments.");
    return createCommand({environments: dependencies.executionEnvironments});
  });
}

function environmentControlCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (services: EnvironmentReadCommandServices & {lifecycle: EnvironmentCommandLifecycle}) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.executionEnvironments) throw new Error("Agent command module requires executionEnvironments.");
    if (!dependencies.environmentLifecycle) throw new Error("Agent command module requires environmentLifecycle.");
    return createCommand({environments: dependencies.executionEnvironments, lifecycle: dependencies.environmentLifecycle});
  });
}

function emailReadCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (services: {store: EmailCommandStore}) => RegisteredCommand,
): AgentCommandModule {
  return daemonChannelCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.email) throw new Error("Agent command module requires email.");
    return createCommand({store: dependencies.email});
  });
}

function channelDiscoveryCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (services: TelegramChatListCommandServices & {conversations: ChannelCommandConversations}) => RegisteredCommand,
): AgentCommandModule {
  return daemonChannelCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.connectorAccounts) throw new Error("Agent command module requires connectorAccounts.");
    if (!dependencies.conversations) throw new Error("Agent command module requires conversations.");
    return createCommand({connectorAccounts: dependencies.connectorAccounts, conversations: dependencies.conversations});
  });
}

function channelHistoryCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (services: TelegramHistoryCommandServices) => RegisteredCommand,
): AgentCommandModule {
  return daemonChannelCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.connectorAccounts) throw new Error("Agent command module requires connectorAccounts.");
    if (!dependencies.conversations) throw new Error("Agent command module requires conversations.");
    if (!dependencies.channelMessages) throw new Error("Agent command module requires channelMessages.");
    if (!dependencies.outboundDeliveries) throw new Error("Agent command module requires outboundDeliveries.");
    return createCommand({connectorAccounts: dependencies.connectorAccounts, conversations: dependencies.conversations, messages: dependencies.channelMessages, deliveries: dependencies.outboundDeliveries});
  });
}

function channelActionCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (queue: ChannelActionCommandQueue) => RegisteredCommand,
): AgentCommandModule {
  return daemonChannelCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.channelActions) throw new Error("Agent command module requires channelActions.");
    return createCommand(dependencies.channelActions);
  });
}

function channelSendCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (queue: ChannelCommandDeliveries, files: AgentCommandFileResolver) => RegisteredCommand,
): AgentCommandModule {
  return daemonChannelCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.outboundDeliveries) throw new Error("Agent command module requires outboundDeliveries.");
    if (!dependencies.commandFileResolver) throw new Error("Agent command module requires commandFileResolver.");
    return createCommand(dependencies.outboundDeliveries, dependencies.commandFileResolver);
  });
}

function telegramStickerCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (services: Parameters<typeof createTelegramStickerInspectCommand>[0]) => RegisteredCommand,
): AgentCommandModule {
  return daemonChannelCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.telegramStickers) throw new Error("Agent command module requires telegramStickers.");
    if (!dependencies.channelMessages) throw new Error("Agent command module requires channelMessages.");
    if (!dependencies.conversations) throw new Error("Agent command module requires conversations.");
    if (!dependencies.connectorAccounts) throw new Error("Agent command module requires connectorAccounts.");
    return createCommand({library: dependencies.telegramStickers, messages: dependencies.channelMessages, conversations: dependencies.conversations, connectorAccounts: dependencies.connectorAccounts});
  });
}

function discordVoiceCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (services: DiscordVoiceCommandServices) => RegisteredCommand,
): AgentCommandModule {
  return daemonChannelCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.discordVoice) throw new Error("Agent command module requires discordVoice.");
    if (!dependencies.connectorAccounts) throw new Error("Agent command module requires connectorAccounts.");
    if (!dependencies.conversations) throw new Error("Agent command module requires conversations.");
    return createCommand({env: dependencies.env ?? process.env, voice: dependencies.discordVoice, connectorAccounts: dependencies.connectorAccounts, conversations: dependencies.conversations});
  });
}

function whatsappCallCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (services: WhatsAppCallCommandServices) => RegisteredCommand,
): AgentCommandModule {
  return daemonChannelCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.whatsappCalls) throw new Error("Agent command module requires whatsappCalls.");
    if (!dependencies.connectorAccounts) throw new Error("Agent command module requires connectorAccounts.");
    if (!dependencies.conversations) throw new Error("Agent command module requires conversations.");
    return createCommand({env: dependencies.env ?? process.env, calls: dependencies.whatsappCalls, connectorAccounts: dependencies.connectorAccounts, conversations: dependencies.conversations});
  });
}

function a2aReadCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (deliveries: A2ADeliveryReader) => RegisteredCommand,
): AgentCommandModule {
  return daemonA2ACommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.a2aDeliveries) throw new Error("Agent command module requires a2aDeliveries.");
    return createCommand(dependencies.a2aDeliveries);
  });
}

function cronCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (service: ScheduledCommandService) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    return dependencies.scheduledCommands ? createCommand(dependencies.scheduledCommands) : null;
  });
}

function wikiCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (service: WikiCommandService) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    return dependencies.wiki ? createCommand(dependencies.wiki) : null;
  });
}

function credentialCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (service: EnvCommandService) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    return dependencies.credentials ? createCommand(dependencies.credentials) : null;
  });
}

function heartbeatCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (store: NonNullable<AgentCommandModuleDependencies["sessionHeartbeats"]>, bounds: HeartbeatCadenceBounds) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    return dependencies.sessionHeartbeats && dependencies.heartbeatBounds
      ? createCommand(dependencies.sessionHeartbeats, dependencies.heartbeatBounds)
      : null;
  });
}

function audioCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (options: {env?: NodeJS.ProcessEnv}, files: AgentCommandFileResolver) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    if (!dependencies.commandFileResolver) throw new Error("Agent command module requires commandFileResolver.");
    return createCommand({env: dependencies.env}, dependencies.commandFileResolver);
  });
}

function braveCommandModule(
  descriptor: CommandDescriptor,
  helpArgv: readonly string[],
  jsonInput: string,
  policy: AgentCommandPolicy,
  createCommand: (options: NonNullable<Parameters<typeof createBraveWebSearchCommand>[0]>) => RegisteredCommand,
): AgentCommandModule {
  return agentCommandModule(descriptor, helpArgv, jsonInput, policy, (dependencies) => {
    return createCommand({env: dependencies.env, throttleGate: dependencies.braveThrottleGate});
  });
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
    agentCommandPolicy([], {defaultAllowed: true}),
    () => createTimeNowCommand(),
  ),
  mcpCommandModule(
    mcpToolsCommandDescriptor,
    ["mcp", "tools"],
    "@payload.json",
    agentCommandPolicy(["mcp"], {defaultAllowed: true, capability: MCP_COMMAND_CAPABILITY}),
    createMcpToolsCommand,
  ),
  mcpCommandModule(
    mcpCallCommandDescriptor,
    ["mcp", "call"],
    "@payload.json",
    agentCommandPolicy(["mcp"], {defaultAllowed: true, capability: MCP_COMMAND_CAPABILITY}),
    createMcpCallCommand,
  ),
  mcpManagementCommandModule(mcpServerListCommandDescriptor, ["mcp", "server", "list"], createMcpServerListCommand, "{}"),
  mcpManagementCommandModule(mcpServerShowCommandDescriptor, ["mcp", "server", "show"], createMcpServerShowCommand),
  mcpManagementCommandModule(mcpServerAddCommandDescriptor, ["mcp", "server", "add"], createMcpServerAddCommand),
  mcpManagementCommandModule(mcpServerUpdateCommandDescriptor, ["mcp", "server", "update"], createMcpServerUpdateCommand),
  mcpManagementCommandModule(mcpServerEnableCommandDescriptor, ["mcp", "server", "enable"], createMcpServerEnableCommand),
  mcpManagementCommandModule(mcpServerDisableCommandDescriptor, ["mcp", "server", "disable"], createMcpServerDisableCommand),
  mcpManagementCommandModule(mcpServerDeleteCommandDescriptor, ["mcp", "server", "delete"], createMcpServerDeleteCommand),
  mcpManagementCommandModule(mcpServerTestCommandDescriptor, ["mcp", "server", "test"], createMcpServerTestCommand),
  mcpManagementCommandModule(mcpOauthDiscoverCommandDescriptor, ["mcp", "oauth", "discover"], createMcpOauthDiscoverCommand),
  mcpManagementCommandModule(mcpOauthStartCommandDescriptor, ["mcp", "oauth", "start"], createMcpOauthStartCommand),
  mcpManagementCommandModule(mcpOauthStatusCommandDescriptor, ["mcp", "oauth", "status"], createMcpOauthStatusCommand),
  mcpManagementCommandModule(mcpOauthDisconnectCommandDescriptor, ["mcp", "oauth", "disconnect"], createMcpOauthDisconnectCommand),
  heartbeatCommandModule(
    heartbeatShowCommandDescriptor,
    ["heartbeat", "show"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createHeartbeatShowCommand,
  ),
  heartbeatCommandModule(
    heartbeatSetCommandDescriptor,
    ["heartbeat", "set"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createHeartbeatSetCommand,
  ),
  watchStoreCommandModule(watchListCommandDescriptor, ["watch", "list"], createWatchListCommand),
  watchStoreCommandModule(watchShowCommandDescriptor, ["watch", "show"], createWatchShowCommand),
  watchStoreCommandModule(watchRunsCommandDescriptor, ["watch", "runs"], createWatchRunsCommand),
  watchMutationCommandModule(watchCreateCommandDescriptor, ["watch", "create"], createWatchCreateCommand),
  watchMutationCommandModule(watchUpdateCommandDescriptor, ["watch", "update"], createWatchUpdateCommand),
  watchStoreCommandModule(watchDisableCommandDescriptor, ["watch", "disable"], createWatchDisableCommand),
  scheduledTaskCommandModule(scheduleListCommandDescriptor, ["schedule", "list"], createScheduleListCommand),
  scheduledTaskCommandModule(scheduleShowCommandDescriptor, ["schedule", "show"], createScheduleShowCommand),
  scheduledTaskCommandModule(scheduleRunsCommandDescriptor, ["schedule", "runs"], createScheduleRunsCommand),
  scheduledTaskCommandModule(scheduleCreateCommandDescriptor, ["schedule", "create"], createScheduleCreateCommand),
  scheduledTaskCommandModule(scheduleUpdateCommandDescriptor, ["schedule", "update"], createScheduleUpdateCommand),
  scheduledTaskCommandModule(scheduleCancelCommandDescriptor, ["schedule", "cancel"], createScheduleCancelCommand),
  cronCommandModule(
    cronListCommandDescriptor,
    ["cron", "list"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createCronListCommand,
  ),
  cronCommandModule(
    cronShowCommandDescriptor,
    ["cron", "show"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createCronShowCommand,
  ),
  cronCommandModule(
    cronRunsCommandDescriptor,
    ["cron", "runs"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createCronRunsCommand,
  ),
  cronCommandModule(
    cronCreateCommandDescriptor,
    ["cron", "create"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true, requiresBash: true}),
    createCronCreateCommand,
  ),
  cronCommandModule(
    cronUpdateCommandDescriptor,
    ["cron", "update"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true, requiresBash: true}),
    createCronUpdateCommand,
  ),
  cronCommandModule(
    cronEnableCommandDescriptor,
    ["cron", "enable"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true, requiresBash: true}),
    createCronEnableCommand,
  ),
  cronCommandModule(
    cronDisableCommandDescriptor,
    ["cron", "disable"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createCronDisableCommand,
  ),
  cronCommandModule(
    cronDeleteCommandDescriptor,
    ["cron", "delete"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createCronDeleteCommand,
  ),
  cronCommandModule(
    cronRunCommandDescriptor,
    ["cron", "run"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true, requiresBash: true}),
    createCronRunCommand,
  ),
  appCommandModule(
    appCheckCommandDescriptor,
    ["micro-app", "check"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createAppCheckCommand,
  ),
  appCommandModule(
    appCreateCommandDescriptor,
    ["micro-app", "create"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createAppCreateCommand,
  ),
  agentCommandModule(
    appLinkCreateCommandDescriptor,
    ["micro-app", "link", "create"],
    "@payload.json",
    agentCommandPolicy(["operate"], {
    defaultAllowed: true,
      requiresIdentity: true,
    }),
    (dependencies) => {
      if (!dependencies.apps) throw new Error("Agent command module requires apps.");
      if (!dependencies.appAuth) throw new Error("Agent command module requires appAuth.");
      return createAppLinkCreateCommand(
      dependencies.apps,
      dependencies.appAuth,
      {
        resolveLaunchUrls: dependencies.resolveAppLaunchUrls,
      },
    );
    },
  ),
  appCommandModule(
    appListCommandDescriptor,
    ["micro-app", "list"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createAppListCommand,
  ),
  appCommandModule(
    appViewCommandDescriptor,
    ["micro-app", "view"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createAppViewCommand,
  ),
  appCommandModule(
    appActionCommandDescriptor,
    ["micro-app", "action"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createAppActionCommand,
  ),
  agentCommandModule(
    environmentCreateCommandDescriptor,
    ["environment", "create"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.environmentLifecycle) throw new Error("Agent command module requires environmentLifecycle.");
      if (!dependencies.commandFileResolver) throw new Error("Agent command module requires commandFileResolver.");
      return createEnvironmentCreateCommand({
      lifecycle: dependencies.environmentLifecycle,
    }, dependencies.commandFileResolver);
    },
  ),
  environmentReadCommandModule(
    environmentListCommandDescriptor,
    ["environment", "list"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createEnvironmentListCommand,
  ),
  environmentReadCommandModule(
    environmentShowCommandDescriptor,
    ["environment", "show"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createEnvironmentShowCommand,
  ),
  environmentControlCommandModule(
    environmentStopCommandDescriptor,
    ["environment", "stop"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createEnvironmentStopCommand,
  ),
  environmentControlCommandModule(
    environmentLogsCommandDescriptor,
    ["environment", "logs"],
    "@payload.json",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createEnvironmentLogsCommand,
  ),
  agentSkillCommandModule(skillListCommandDescriptor, ["skill", "list"], agentCommandPolicy(["core", "operate", "skill_maintenance"], {
    defaultAllowed: true,
    requiredAgentSkillOperation: "load",
  }), createSkillListCommand),
  agentSkillCommandModule(skillShowCommandDescriptor, ["skill", "show"], agentCommandPolicy(["core", "operate", "skill_maintenance"], {
    defaultAllowed: true,
    requiredAgentSkillOperation: "load",
  }), createSkillShowCommand),
  agentSkillCommandModule(skillLoadCommandDescriptor, ["skill", "load"], agentCommandPolicy(["core", "operate", "skill_maintenance"], {
    defaultAllowed: true,
    requiredAgentSkillOperation: "load",
  }), createSkillLoadCommand),
  agentSkillCommandModule(skillSetCommandDescriptor, ["skill", "set"], agentCommandPolicy(["operate", "skill_maintenance"], {
    defaultAllowed: true,
    requiredAgentSkillOperation: "set",
  }), createSkillSetCommand),
  agentSkillCommandModule(skillPatchCommandDescriptor, ["skill", "patch"], agentCommandPolicy(["operate", "skill_maintenance"], {
    defaultAllowed: true,
    requiredAgentSkillOperation: "patch",
  }), createSkillPatchCommand),
  agentSkillCommandModule(skillDeleteCommandDescriptor, ["skill", "delete"], agentCommandPolicy(["operate", "skill_maintenance"], {
    defaultAllowed: true,
    requiredAgentSkillOperation: "delete",
  }), createSkillDeleteCommand),
  agentCommandModule(postgresReadonlyQueryCommandDescriptor, ["postgres", "readonly", "query"], "@payload.json", agentCommandPolicy(["memory"], {
    defaultAllowed: true,
    requiresReadonlyPostgres: true,
  }), (dependencies) => {
      if (!dependencies.postgresReadonly) throw new Error("Agent command module requires postgresReadonly.");
      return createPostgresReadonlyQueryCommand(dependencies.postgresReadonly);
    }),
  wikiCommandModule(
    wikiOverviewCommandDescriptor,
    ["wiki", "overview"],
    "{}",
    agentCommandPolicy(["memory"], {defaultAllowed: false}),
    createWikiOverviewCommand,
  ),
  wikiCommandModule(
    wikiReadCommandDescriptor,
    ["wiki", "read"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiReadCommand,
  ),
  wikiCommandModule(
    wikiSearchCommandDescriptor,
    ["wiki", "search"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiSearchCommand,
  ),
  wikiCommandModule(
    wikiListCommandDescriptor,
    ["wiki", "list"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiListCommand,
  ),
  wikiCommandModule(
    wikiDiffCommandDescriptor,
    ["wiki", "diff"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiDiffCommand,
  ),
  wikiCommandModule(
    wikiWriteCommandDescriptor,
    ["wiki", "write", "page"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiWriteCommand,
  ),
  wikiCommandModule(
    wikiWriteSectionCommandDescriptor,
    ["wiki", "write", "section"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiWriteSectionCommand,
  ),
  wikiCommandModule(
    wikiMoveCommandDescriptor,
    ["wiki", "move"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiMoveCommand,
  ),
  wikiCommandModule(
    wikiArchiveCommandDescriptor,
    ["wiki", "archive"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiArchiveCommand,
  ),
  wikiCommandModule(
    wikiRestoreCommandDescriptor,
    ["wiki", "restore"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiRestoreCommand,
  ),
  agentCommandModule(
    wikiAttachImageCommandDescriptor,
    ["wiki", "attach", "image"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.wiki) return null;
      if (!dependencies.commandFileResolver) throw new Error("Agent command module requires commandFileResolver.");
      return createWikiAttachImageCommand(dependencies.wiki, dependencies.commandFileResolver);
    },
  ),
  wikiCommandModule(
    wikiFetchAssetCommandDescriptor,
    ["wiki", "fetch", "asset"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiFetchAssetCommand,
  ),
  wikiCommandModule(
    wikiDeleteAssetCommandDescriptor,
    ["wiki", "delete", "asset"],
    "@payload.json",
    agentCommandPolicy(["memory"], {defaultAllowed: true}),
    createWikiDeleteAssetCommand,
  ),
  sessionPromptCommandModule(sessionPromptReadCommandDescriptor, ["session", "prompt", "current", "read"], createSessionPromptReadCommand),
  agentCommandModule(
    sessionCompactCommandDescriptor,
    ["session", "compact", "current"],
    "{}",
    agentCommandPolicy(["core"], {defaultAllowed: true}),
    (dependencies) => dependencies.sessionCompactionRequests
      ? createSessionCompactCommand(dependencies.sessionCompactionRequests)
      : null,
  ),
  sessionPromptCommandModule(sessionPromptSetCommandDescriptor, ["session", "prompt", "current", "set"], createSessionPromptSetCommand),
  sessionPromptCommandModule(sessionPromptTransformCommandDescriptor, ["session", "prompt", "current", "transform"], createSessionPromptTransformCommand),
  todoCommandModule(todoAddCommandDescriptor, ["todo", "add"], createTodoAddCommand),
  todoCommandModule(todoListCommandDescriptor, ["todo", "list"], createTodoListCommand, "{}"),
  todoCommandModule(todoShowCommandDescriptor, ["todo", "show"], createTodoShowCommand),
  todoCommandModule(todoDoneCommandDescriptor, ["todo", "done"], createTodoDoneCommand),
  todoCommandModule(todoBlockCommandDescriptor, ["todo", "block"], createTodoBlockCommand),
  todoCommandModule(todoClearCommandDescriptor, ["todo", "clear"], createTodoClearCommand, "{}"),
  runtimeSubagentCommandModule(
    subagentSpawnCommandDescriptor,
    ["subagent", "spawn"],
    "@payload.json",
    agentCommandPolicy([], {defaultAllowed: true}),
    (dependencies) => dependencies.subagentSessions
      ? createSubagentSpawnCommand(dependencies.subagentSessions)
      : null,
  ),
  subagentInventoryCommandModule(subagentListCommandDescriptor, ["subagent", "list"], createSubagentListCommand),
  subagentInventoryCommandModule(subagentShowCommandDescriptor, ["subagent", "show"], createSubagentShowCommand),
  subagentProfileCommandModule(subagentProfileListCommandDescriptor, ["subagent", "profile", "list"], createSubagentProfileListCommand, "{}"),
  subagentProfileCommandModule(subagentProfileShowCommandDescriptor, ["subagent", "profile", "show"], createSubagentProfileShowCommand),
  subagentProfileCommandModule(subagentProfileUpsertCommandDescriptor, ["subagent", "profile", "upsert"], createSubagentProfileUpsertCommand),
  subagentProfileCommandModule(subagentProfileEnableCommandDescriptor, ["subagent", "profile", "enable"], createSubagentProfileEnableCommand),
  subagentProfileCommandModule(subagentProfileDisableCommandDescriptor, ["subagent", "profile", "disable"], createSubagentProfileDisableCommand),
  daemonA2ACommandModule(
    a2aSendCommandDescriptor,
    ["a2a", "send"],
    "@payload.json",
    agentCommandPolicy(["core"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.a2aMessaging) throw new Error("Agent command module requires a2aMessaging.");
      if (!dependencies.commandUploads) throw new Error("Agent command module requires commandUploads.");
      return createA2ASendCommand(
      dependencies.a2aMessaging,
      dependencies.commandUploads,
    );
    },
  ),
  a2aReadCommandModule(
    a2aInspectCommandDescriptor,
    ["a2a", "inspect"],
    "@payload.json",
    agentCommandPolicy(["core"], {defaultAllowed: true}),
    createA2AInspectCommand,
  ),
  a2aReadCommandModule(
    a2aHistoryCommandDescriptor,
    ["a2a", "history"],
    "@payload.json",
    agentCommandPolicy(["core"], {defaultAllowed: true}),
    createA2AHistoryCommand,
  ),
  emailReadCommandModule(
    emailAccountListCommandDescriptor,
    ["email", "account", "list"],
    "{}",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createEmailAccountListCommand,
  ),
  emailReadCommandModule(
    emailListCommandDescriptor,
    ["email", "list"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createEmailListCommand,
  ),
  emailReadCommandModule(
    emailReadCommandDescriptor,
    ["email", "read"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createEmailReadCommand,
  ),
  emailReadCommandModule(
    emailSearchCommandDescriptor,
    ["email", "search"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createEmailSearchCommand,
  ),
  daemonChannelCommandModule(
    emailAttachmentsFetchCommandDescriptor,
    ["email", "attachments", "fetch"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.email) throw new Error("Agent command module requires email.");
      if (!dependencies.commandFileResolver) throw new Error("Agent command module requires commandFileResolver.");
      return createEmailAttachmentsFetchCommand({
      store: dependencies.email,
    }, dependencies.commandFileResolver);
    },
  ),
  daemonChannelCommandModule(
    emailSendCommandDescriptor,
    ["email", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.email) throw new Error("Agent command module requires email.");
      if (!dependencies.outboundDeliveries) throw new Error("Agent command module requires outboundDeliveries.");
      if (!dependencies.commandFileResolver) throw new Error("Agent command module requires commandFileResolver.");
      return createEmailSendCommand({
      store: dependencies.email,
      queue: dependencies.outboundDeliveries,
    }, dependencies.commandFileResolver);
    },
  ),
  channelDiscoveryCommandModule(
    telegramChatListCommandDescriptor,
    ["telegram", "chat", "list"],
    "{}",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramChatListCommand,
  ),
  channelDiscoveryCommandModule(
    telegramChatInfoCommandDescriptor,
    ["telegram", "chat", "info"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramChatInfoCommand,
  ),
  channelHistoryCommandModule(
    telegramHistoryCommandDescriptor,
    ["telegram", "history"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramHistoryCommand,
  ),
  daemonChannelCommandModule(
    telegramMediaFetchCommandDescriptor,
    ["telegram", "media", "fetch"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.connectorAccounts) throw new Error("Agent command module requires connectorAccounts.");
      if (!dependencies.conversations) throw new Error("Agent command module requires conversations.");
      if (!dependencies.channelMessages) throw new Error("Agent command module requires channelMessages.");
      if (!dependencies.commandFileResolver) throw new Error("Agent command module requires commandFileResolver.");
      return createTelegramMediaFetchCommand({
      connectorAccounts: dependencies.connectorAccounts,
      conversations: dependencies.conversations,
      messages: dependencies.channelMessages,
    }, dependencies.commandFileResolver);
    },
  ),
  channelSendCommandModule(
    telegramSendCommandDescriptor,
    ["telegram", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramSendCommand,
  ),
  channelActionCommandModule(
    telegramReactCommandDescriptor,
    ["telegram", "react"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramReactCommand,
  ),
  channelActionCommandModule(
    telegramEditCommandDescriptor,
    ["telegram", "edit"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramEditCommand,
  ),
  channelActionCommandModule(
    telegramDeleteCommandDescriptor,
    ["telegram", "delete"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramDeleteCommand,
  ),
  channelActionCommandModule(
    telegramPinCommandDescriptor,
    ["telegram", "pin"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramPinCommand,
  ),
  channelActionCommandModule(
    telegramUnpinCommandDescriptor,
    ["telegram", "unpin"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramUnpinCommand,
  ),
  telegramStickerCommandModule(
    telegramStickerInspectCommandDescriptor,
    ["telegram", "sticker", "inspect"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramStickerInspectCommand,
  ),
  telegramStickerCommandModule(
    telegramStickerSaveCommandDescriptor,
    ["telegram", "sticker", "save"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramStickerSaveCommand,
  ),
  telegramStickerCommandModule(
    telegramStickerListCommandDescriptor,
    ["telegram", "sticker", "list"],
    "{}",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramStickerListCommand,
  ),
  telegramStickerCommandModule(
    telegramStickerSetShowCommandDescriptor,
    ["telegram", "sticker", "set", "show"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramStickerSetShowCommand,
  ),
  telegramStickerCommandModule(
    telegramStickerSetSaveCommandDescriptor,
    ["telegram", "sticker", "set", "save"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createTelegramStickerSetSaveCommand,
  ),
  daemonChannelCommandModule(
    telegramStickerSendCommandDescriptor,
    ["telegram", "sticker", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.channelActions) throw new Error("Agent command module requires channelActions.");
      if (!dependencies.commandFileResolver) throw new Error("Agent command module requires commandFileResolver.");
      if (!dependencies.telegramStickers) throw new Error("Agent command module requires telegramStickers.");
      return createTelegramStickerSendCommand(
      dependencies.channelActions,
      dependencies.commandFileResolver,
      dependencies.telegramStickers,
    );
    },
  ),
  channelDiscoveryCommandModule(
    discordChannelListCommandDescriptor,
    ["discord", "channel", "list"],
    "{}",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createDiscordChannelListCommand,
  ),
  discordVoiceCommandModule(
    discordVoiceJoinCommandDescriptor,
    ["discord", "voice", "join"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createDiscordVoiceJoinCommand,
  ),
  discordVoiceCommandModule(
    discordVoiceLeaveCommandDescriptor,
    ["discord", "voice", "leave"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createDiscordVoiceLeaveCommand,
  ),
  discordVoiceCommandModule(
    discordVoiceSendCommandDescriptor,
    ["discord", "voice", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createDiscordVoiceSendCommand,
  ),
  discordVoiceCommandModule(
    discordVoiceStatusCommandDescriptor,
    ["discord", "voice", "status"],
    "{}",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createDiscordVoiceStatusCommand,
  ),
  channelHistoryCommandModule(
    discordHistoryCommandDescriptor,
    ["discord", "history"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createDiscordHistoryCommand,
  ),
  daemonChannelCommandModule(
    discordStickerListCommandDescriptor,
    ["discord", "sticker", "list"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.conversations) throw new Error("Agent command module requires conversations.");
      if (!dependencies.discordStickers) throw new Error("Agent command module requires discordStickers.");
      return createDiscordStickerListCommand({
      conversations: dependencies.conversations,
      stickers: dependencies.discordStickers,
    });
    },
  ),
  channelActionCommandModule(
    discordStickerSendCommandDescriptor,
    ["discord", "sticker", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createDiscordStickerSendCommand,
  ),
  daemonChannelCommandModule(
    discordGifSendCommandDescriptor,
    ["discord", "gif", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.outboundDeliveries) throw new Error("Agent command module requires outboundDeliveries.");
      if (!dependencies.commandFileResolver) throw new Error("Agent command module requires commandFileResolver.");
      if (!dependencies.discordGifs) throw new Error("Agent command module requires discordGifs.");
      return createDiscordGifSendCommand(
      dependencies.outboundDeliveries,
      dependencies.commandFileResolver,
      dependencies.discordGifs,
    );
    },
  ),
  channelSendCommandModule(
    discordSendCommandDescriptor,
    ["discord", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createDiscordSendCommand,
  ),
  daemonChannelCommandModule(
    whatsappChatListCommandDescriptor,
    ["whatsapp", "chat", "list"],
    "{}",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.conversations) throw new Error("Agent command module requires conversations.");
      return createWhatsAppChatListCommand({
      conversations: dependencies.conversations,
    });
    },
  ),
  daemonChannelCommandModule(
    whatsappHistoryCommandDescriptor,
    ["whatsapp", "history"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.conversations) throw new Error("Agent command module requires conversations.");
      if (!dependencies.channelMessages) throw new Error("Agent command module requires channelMessages.");
      if (!dependencies.outboundDeliveries) throw new Error("Agent command module requires outboundDeliveries.");
      return createWhatsAppHistoryCommand({
      conversations: dependencies.conversations,
      messages: dependencies.channelMessages,
      deliveries: dependencies.outboundDeliveries,
    });
    },
  ),
  channelSendCommandModule(
    whatsappSendCommandDescriptor,
    ["whatsapp", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: true}),
    createWhatsAppSendCommand,
  ),
  whatsappCallCommandModule(
    whatsappCallStatusCommandDescriptor,
    ["whatsapp", "call", "status"],
    "{}",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: false}),
    createWhatsAppCallStatusCommand,
  ),
  whatsappCallCommandModule(
    whatsappCallSendCommandDescriptor,
    ["whatsapp", "call", "send"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: false}),
    createWhatsAppCallSendCommand,
  ),
  whatsappCallCommandModule(
    whatsappCallHangupCommandDescriptor,
    ["whatsapp", "call", "hangup"],
    "@payload.json",
    agentCommandPolicy(["communicate_human"], {defaultAllowed: false}),
    createWhatsAppCallHangupCommand,
  ),
  credentialCommandModule(
    envListCommandDescriptor,
    ["env", "list"],
    "{}",
    agentCommandPolicy(["operate"], {defaultAllowed: true}),
    createListEnvValuesCommand,
  ),
  credentialCommandModule(envSetCommandDescriptor, ["env", "set"], "@payload.json", agentCommandPolicy(["operate"], {
    defaultAllowed: true,
    requiresCredentialMutation: true,
  }), createSetEnvValueCommand),
  credentialCommandModule(envClearCommandDescriptor, ["env", "clear"], "@payload.json", agentCommandPolicy(["operate"], {
    defaultAllowed: true,
    requiresCredentialMutation: true,
  }), createClearEnvValueCommand),
  agentCommandModule(
    ventSendCommandDescriptor,
    ["vent"],
    "@payload.json",
    agentCommandPolicy(["core"], {defaultAllowed: true}),
    (dependencies) => createVentSendCommand({env: dependencies.env}),
  ),
  agentCommandModule(
    webFetchCommandDescriptor,
    ["web", "fetch"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: true}),
    (dependencies) => createWebFetchCommand({
      env: dependencies.env,
      fileResolver: dependencies.commandFileResolver,
    }),
  ),
  agentCommandModule(
    webReadCommandDescriptor,
    ["web", "read"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: false}),
    (dependencies) => createWebReadCommand({env: dependencies.env}),
  ),
  braveCommandModule(
    braveWebSearchCommandDescriptor,
    ["brave", "web", "search"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: true}),
    createBraveWebSearchCommand,
  ),
  braveCommandModule(
    braveNewsSearchCommandDescriptor,
    ["brave", "news", "search"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: true}),
    createBraveNewsSearchCommand,
  ),
  braveCommandModule(
    braveVideoSearchCommandDescriptor,
    ["brave", "video", "search"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: true}),
    createBraveVideoSearchCommand,
  ),
  braveCommandModule(
    braveImageSearchCommandDescriptor,
    ["brave", "image", "search"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: true}),
    createBraveImageSearchCommand,
  ),
  braveCommandModule(
    braveLlmContextCommandDescriptor,
    ["brave", "llm", "context"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: true}),
    createBraveLlmContextCommand,
  ),
  braveCommandModule(
    bravePlaceSearchCommandDescriptor,
    ["brave", "place", "search"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: true}),
    createBravePlaceSearchCommand,
  ),
  braveCommandModule(
    bravePlacePoiCommandDescriptor,
    ["brave", "place", "poi"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: true}),
    createBravePlacePoiCommand,
  ),
  braveCommandModule(
    bravePlaceDescriptionCommandDescriptor,
    ["brave", "place", "description"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: true}),
    createBravePlaceDescriptionCommand,
  ),
  agentCommandModule(
    openAIWebResearchCommandDescriptor,
    ["openai", "web-research"],
    "@payload.json",
    agentCommandPolicy(["internet"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.backgroundJobService) throw new Error("Agent command module requires backgroundJobService.");
      return createOpenAIWebResearchCommand({
      env: dependencies.env,
      jobService: dependencies.backgroundJobService,
    });
    },
  ),
  agentCommandModule(
    imageGenerateCommandDescriptor,
    ["image", "generate"],
    "@payload.json",
    agentCommandPolicy(["core"], {defaultAllowed: true}),
    (dependencies) => {
      if (!dependencies.backgroundJobService) throw new Error("Agent command module requires backgroundJobService.");
      if (!dependencies.commandFileResolver) throw new Error("Agent command module requires commandFileResolver.");
      return createImageGenerateCommand({
      env: dependencies.env,
      jobService: dependencies.backgroundJobService,
    }, dependencies.commandFileResolver);
    },
  ),
  audioCommandModule(
    whisperTranscribeCommandDescriptor,
    ["whisper", "transcribe"],
    "@payload.json",
    agentCommandPolicy(["core"], {defaultAllowed: true}),
    createWhisperTranscribeCommand,
  ),
  audioCommandModule(
    whisperTranslateCommandDescriptor,
    ["whisper", "translate"],
    "@payload.json",
    agentCommandPolicy(["core"], {defaultAllowed: true}),
    createWhisperTranslateCommand,
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
