import {execFile} from "node:child_process";
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {commandStaleVersionConflict} from "../src/domain/commands/errors.js";
import {FileSystemCommandUploadStore} from "../src/integrations/commands/file-uploads.js";
import {FileSystemWebResourceStore} from "../src/integrations/web/web-resources.js";
import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import {READONLY_SESSION_VIEW_BASENAMES} from "../src/domain/threads/runtime/postgres-readonly.js";
import {
  createA2AHistoryCommand,
  createA2AInspectCommand,
  createA2ASendCommand,
} from "../src/domain/a2a/commands.js";
import {
  createEmailAccountListCommand,
  createEmailAttachmentsFetchCommand,
  createEmailListCommand,
  createEmailReadCommand,
  createEmailSearchCommand,
  createEmailSendCommand,
} from "../src/domain/email/commands.js";
import {
  createAppActionCommand,
  createAppCheckCommand,
  createAppCreateCommand,
  createAppLinkCreateCommand,
  createAppListCommand,
  createAppViewCommand,
} from "../src/domain/apps/commands.js";
import {
  createSkillDeleteCommand,
  createSkillListCommand,
  createSkillLoadCommand,
  createSkillPatchCommand,
  createSkillSetCommand,
  createSkillShowCommand,
} from "../src/domain/agents/skill-commands.js";
import {
  createClearEnvValueCommand,
  createListEnvValuesCommand,
  createSetEnvValueCommand,
} from "../src/domain/credentials/commands.js";
import {
  createEnvironmentCreateCommand,
  createEnvironmentListCommand,
  createEnvironmentLogsCommand,
  createEnvironmentShowCommand,
  createEnvironmentStopCommand,
} from "../src/domain/execution-environments/commands.js";
import {
  createScheduleCancelCommand,
  createScheduleCreateCommand,
  createScheduleListCommand,
  createScheduleRunsCommand,
  createScheduleShowCommand,
  createScheduleUpdateCommand,
} from "../src/domain/scheduling/tasks/commands.js";
import {
  createSessionPromptReadCommand,
  createSessionPromptSetCommand,
  createSessionPromptTransformCommand,
} from "../src/domain/sessions/prompt-commands.js";
import {
  createTodoAddCommand,
  createTodoBlockCommand,
  createTodoClearCommand,
  createTodoDoneCommand,
  createTodoListCommand,
  createTodoShowCommand,
} from "../src/domain/sessions/todo-commands.js";
import {
  createSubagentProfileDisableCommand,
  createSubagentProfileEnableCommand,
  createSubagentProfileListCommand,
  createSubagentProfileShowCommand,
  createSubagentProfileUpsertCommand,
  createSubagentSpawnCommand,
} from "../src/domain/subagents/commands.js";
import {
  createSubagentListCommand,
  createSubagentShowCommand,
} from "../src/domain/subagents/inventory-commands.js";
import {buildSubagentSessionMetadata} from "../src/domain/subagents/session-metadata.js";
import {createTimeNowCommand} from "../src/domain/time/commands.js";
import {
  createWatchCreateCommand,
  createWatchDisableCommand,
  createWatchListCommand,
  createWatchRunsCommand,
  createWatchShowCommand,
  createWatchUpdateCommand,
} from "../src/domain/watches/commands.js";
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
} from "../src/domain/wiki/commands.js";
import {
  createTelegramChatListCommand,
  createTelegramChatInfoCommand,
  createTelegramDeleteCommand,
  createTelegramEditCommand,
  createTelegramHistoryCommand,
  createTelegramMediaFetchCommand,
  createTelegramPinCommand,
  createTelegramReactCommand,
  createTelegramSendCommand,
  createTelegramStickerSendCommand,
  createTelegramUnpinCommand,
} from "../src/integrations/channels/telegram/commands.js";
import {createDiscordChannelListCommand, createDiscordHistoryCommand, createDiscordSendCommand} from "../src/integrations/channels/discord/commands.js";
import {createWhatsAppChatListCommand, createWhatsAppHistoryCommand, createWhatsAppSendCommand} from "../src/integrations/channels/whatsapp/commands.js";
import {createVentSendCommand} from "../src/integrations/panda-trace/vent-commands.js";
import {
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
} from "../src/integrations/web/commands.js";
import {createPostgresReadonlyQueryCommand} from "../src/integrations/postgres/readonly-query-command.js";
import {createImageGenerateCommand} from "../src/panda/commands/image-generate-command.js";
import {
  commandDescriptorsFromModules,
  commandRoutesFromModules,
} from "../src/domain/commands/modules.js";
import {buildCommandRouteTree} from "../src/domain/commands/route-tree.js";
import type {CommandDescriptor, RegisteredCommand} from "../src/domain/commands/types.js";
import {
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
} from "../src/domain/mcp/management-commands.js";
import {DEFAULT_AGENT_COMMAND_MODULES} from "../src/panda/commands/agent-command-modules.js";
import {DEFAULT_AGENT_COMMAND_DESCRIPTORS} from "../src/panda/commands/agent-command-descriptors.js";
import {DEFAULT_AGENT_COMMAND_SHIM_ROUTES} from "../src/panda/commands/agent-command-shim-routes.js";
import {createWhisperTranscribeCommand, createWhisperTranslateCommand} from "../src/integrations/audio/commands.js";
import {
  startCommandHttpServer,
  type CommandHttpServer,
} from "../src/integrations/commands/http-server.js";
import {createTestCommandLeaseVerifier} from "./helpers/command-lease-verifier.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

const execFileAsync = promisify(execFile);
const shimPath = path.resolve("scripts/agent-command-shim/panda");
const defaultTestCommandScopeAllowedCommands = DEFAULT_AGENT_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name);
const mcpManagementDescriptors = [
  mcpServerListCommandDescriptor,
  mcpServerShowCommandDescriptor,
  mcpServerAddCommandDescriptor,
  mcpServerUpdateCommandDescriptor,
  mcpServerEnableCommandDescriptor,
  mcpServerDisableCommandDescriptor,
  mcpServerDeleteCommandDescriptor,
  mcpServerTestCommandDescriptor,
  mcpOauthDiscoverCommandDescriptor,
  mcpOauthStartCommandDescriptor,
  mcpOauthStatusCommandDescriptor,
  mcpOauthDisconnectCommandDescriptor,
];

function echoInputCommand(descriptor: CommandDescriptor): RegisteredCommand {
  return {
    descriptor,
    async execute(request) {
      return {ok: true, command: descriptor.name, output: request.input};
    },
  };
}

const COMMAND_TRANSPORT_ENV_KEYS = [
  "PANDA_COMMAND_ACCESS_FILE",
  "PANDA_COMMAND_SOCKET",
  "PANDA_COMMAND_TOKEN",
  "PANDA_COMMAND_URL",
] as const;

const originalCommandTransportEnv = Object.fromEntries(
  COMMAND_TRANSPORT_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<typeof COMMAND_TRANSPORT_ENV_KEYS[number], string | undefined>;

function clearCommandTransportEnv(): void {
  for (const key of COMMAND_TRANSPORT_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreCommandTransportEnv(): void {
  for (const key of COMMAND_TRANSPORT_ENV_KEYS) {
    const value = originalCommandTransportEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

class FakeReadonlyClient {
  readonly queries: Array<{text: string; values?: readonly unknown[]}> = [];

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({text, values});
    if (text.startsWith("SELECT set_config(")) {
      return {rows: [{set_config: values?.[0] ?? null}]};
    }
    if (/^(BEGIN READ ONLY|SET LOCAL|COMMIT|ROLLBACK)$/m.test(text) || text.startsWith("SET LOCAL")) {
      return {rows: []};
    }
    if (text.includes("FROM information_schema.columns")) {
      return {
        rows: READONLY_SESSION_VIEW_BASENAMES.map((tableName, index) => ({
          table_name: tableName,
          column_name: tableName === "messages" ? "text" : "id",
          data_type: "text",
          ordinal_position: index + 1,
        })),
      };
    }

    return {
      rows: [{
        answer: 42,
      }],
    };
  }

  release(): void {}
}

class FakeReadonlyPool {
  readonly client = new FakeReadonlyClient();

  async connect(): Promise<FakeReadonlyClient> {
    return this.client;
  }
}

describe("agent command shim", () => {
  const servers: CommandHttpServer[] = [];
  const directories: string[] = [];

  beforeEach(() => {
    clearCommandTransportEnv();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
    while (directories.length > 0) {
      await rm(directories.pop()!, {recursive: true, force: true});
    }
    restoreCommandTransportEnv();
  });

  async function startWatchServer(options: {
    onA2AQueueMessage?: (input: {
      senderAgentKey: string;
      senderSessionId: string;
      senderThreadId: string;
      senderRunId?: string;
      agentKey?: string;
      sessionId?: string;
      items: readonly unknown[];
    }) => void;
    braveWebFetchImpl?: typeof fetch;
    socketPath?: string;
  } = {}) {
    const mutations = {
      createWatch: vi.fn(async (input: {title: string; intervalMinutes: number}, scope: {sessionId: string}) => ({
        id: "watch-1",
        sessionId: scope.sessionId,
        title: input.title,
        intervalMinutes: input.intervalMinutes,
        source: {
          kind: "http_json" as const,
          url: "https://example.com",
          result: {
            observation: "scalar" as const,
            valuePath: "price",
          },
        },
        detector: {
          kind: "percent_change" as const,
          percent: 10,
        },
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      })),
      updateWatch: vi.fn(async (input: {watchId: string; title?: string}, scope: {sessionId: string}) => ({
        id: input.watchId,
        sessionId: scope.sessionId,
        title: input.title ?? "watch",
        intervalMinutes: 5,
        source: {
          kind: "http_json" as const,
          url: "https://example.com",
          result: {
            observation: "scalar" as const,
            valuePath: "price",
          },
        },
        detector: {
          kind: "percent_change" as const,
          percent: 10,
        },
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      })),
    };
    const emailAttachmentDir = await mkdtemp(path.join(os.tmpdir(), "panda-email-attachment-shim-"));
    directories.push(emailAttachmentDir);
    const commandUploadDataDir = await mkdtemp(path.join(os.tmpdir(), "panda-command-upload-shim-"));
    directories.push(commandUploadDataDir);
    const commandUploads = new FileSystemCommandUploadStore({
      env: {...process.env, DATA_DIR: commandUploadDataDir},
    });
    const webResources = new FileSystemWebResourceStore({
      env: {...process.env, DATA_DIR: commandUploadDataDir},
    });
    const emailAttachmentSource = path.join(emailAttachmentDir, "invoice-source.pdf");
    await writeFile(emailAttachmentSource, "invoice-pdf", "utf8");
    const telegramMediaDir = await mkdtemp(path.join(os.tmpdir(), "panda-telegram-media-shim-"));
    directories.push(telegramMediaDir);
    const telegramMediaSource = path.join(telegramMediaDir, "chart-source.png");
    await writeFile(telegramMediaSource, "telegram-image", "utf8");
    const store = {
      listWatches: vi.fn(async (input: {sessionId: string; status?: "enabled" | "disabled" | "all"}) => [
        {
          id: "watch-1",
          sessionId: input.sessionId,
          title: "BTC",
          intervalMinutes: 5,
          source: {
            kind: "http_json" as const,
            url: "https://example.com",
            result: {
              observation: "scalar" as const,
              valuePath: "price",
            },
          },
          detector: {
            kind: "percent_change" as const,
            percent: 10,
          },
          enabled: input.status !== "disabled",
          ...(input.status === "disabled" ? {disabledAt: 3, lastError: "operator pause"} : {}),
          nextPollAt: 1_800_000_000_000,
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
      getWatch: vi.fn(async (watchId: string) => ({
        id: watchId,
        sessionId: "session-main",
        title: "BTC",
        intervalMinutes: 5,
        source: {
          kind: "http_json" as const,
          url: "https://example.com",
          result: {
            observation: "scalar" as const,
            valuePath: "price",
          },
        },
        detector: {
          kind: "percent_change" as const,
          percent: 10,
        },
        enabled: true,
        nextPollAt: 1_800_000_000_000,
        createdAt: 1,
        updatedAt: 2,
      })),
      listWatchRuns: vi.fn(async (input: {watchId: string; sessionId: string}) => [
        {
          id: "run-1",
          watchId: input.watchId,
          sessionId: input.sessionId,
          scheduledFor: 1_800_000_000_000,
          status: "changed" as const,
          resolvedThreadId: "thread-1",
          emittedEventId: "event-1",
          createdAt: 1_799_999_999_000,
          startedAt: 1_800_000_000_001,
          finishedAt: 1_800_000_000_500,
          event: {
            id: "event-1",
            eventKind: "percent_change" as const,
            summary: "BTC moved by 12%.",
            dedupeKey: "btc-12",
            createdAt: 1_800_000_000_400,
          },
        },
      ]),
      disableWatch: vi.fn(async (input: {watchId: string; sessionId: string}) => ({
        id: input.watchId,
        sessionId: input.sessionId,
        title: "watch",
        intervalMinutes: 5,
        source: {
          kind: "http_json" as const,
          url: "https://example.com",
          result: {
            observation: "scalar" as const,
            valuePath: "price",
          },
        },
        detector: {
          kind: "percent_change" as const,
          percent: 10,
        },
        enabled: false,
        createdAt: 1,
        updatedAt: 1,
      })),
      listTasks: vi.fn(async (input: {sessionId: string; status?: "active" | "disabled" | "completed" | "cancelled" | "all"}) => [
        {
          id: "task-1",
          sessionId: input.sessionId,
          title: "check CI",
          instruction: "Check CI status",
          schedule: {
            kind: "once" as const,
            runAt: "2026-05-25T07:00:00.000Z",
          },
          enabled: input.status !== "disabled",
          nextFireAt: Date.parse("2026-05-25T07:00:00.000Z"),
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
      getTask: vi.fn(async (taskId: string) => ({
        id: taskId,
        sessionId: "session-main",
        title: "check CI",
        instruction: "Check CI status",
        schedule: {
          kind: "once" as const,
          runAt: "2026-05-25T07:00:00.000Z",
        },
        enabled: true,
        nextFireAt: Date.parse("2026-05-25T07:00:00.000Z"),
        createdAt: 1,
        updatedAt: 2,
      })),
      listTaskRuns: vi.fn(async (input: {taskId: string; sessionId: string}) => [
        {
          id: "task-run-1",
          taskId: input.taskId,
          sessionId: input.sessionId,
          resolvedThreadId: "thread-1",
          scheduledFor: Date.parse("2026-05-25T07:00:00.000Z"),
          status: "succeeded" as const,
          threadRunId: "thread-run-1",
          createdAt: 1_799_999_999_000,
          startedAt: 1_800_000_000_001,
          finishedAt: 1_800_000_000_500,
        },
      ]),
      createTask: vi.fn(async (input: {title: string; instruction: string; sessionId: string}) => ({
        id: "task-1",
        sessionId: input.sessionId,
        title: input.title,
        instruction: input.instruction,
        schedule: {
          kind: "once" as const,
          runAt: "2026-05-25T07:00:00.000Z",
        },
        enabled: true,
        nextFireAt: Date.parse("2026-05-25T07:00:00.000Z"),
        createdAt: 1,
        updatedAt: 1,
      })),
      updateTask: vi.fn(async (input: {taskId: string; sessionId: string; enabled?: boolean}) => ({
        id: input.taskId,
        sessionId: input.sessionId,
        title: "task",
        instruction: "instruction",
        schedule: {
          kind: "once" as const,
          runAt: "2026-05-25T07:00:00.000Z",
        },
        enabled: input.enabled ?? true,
        nextFireAt: Date.parse("2026-05-25T07:00:00.000Z"),
        createdAt: 1,
        updatedAt: 1,
      })),
      cancelTask: vi.fn(async (input: {taskId: string; sessionId: string}) => ({
        id: input.taskId,
        sessionId: input.sessionId,
        title: "task",
        instruction: "instruction",
        schedule: {
          kind: "once" as const,
          runAt: "2026-05-25T07:00:00.000Z",
        },
        enabled: true,
        cancelledAt: 1,
        createdAt: 1,
        updatedAt: 1,
      })),
      createStandaloneDisposableEnvironment: vi.fn(async (input: {
        agentKey: string;
        createdBySessionId: string;
        ttlMs?: number;
        metadata?: Record<string, unknown>;
        setupScript?: {requestedPath: string; resolvedPath: string};
      }) => ({
        id: "environment:session-main:shim",
        agentKey: input.agentKey,
        kind: "disposable_container" as const,
        state: "ready" as const,
        runnerUrl: "http://environment:8080",
        runnerCwd: "/workspace",
        rootPath: "/workspace",
        createdBySessionId: input.createdBySessionId,
        expiresAt: input.ttlMs,
        metadata: {
          ...input.metadata,
          ...(input.setupScript ? {
            setup: {
              status: "succeeded",
              requestedPath: input.setupScript.requestedPath,
            },
          } : {}),
        },
        createdAt: 1,
        updatedAt: 1,
      })),
      getEnvironment: vi.fn(async (environmentId: string) => ({
        id: environmentId,
        agentKey: "panda",
        kind: "disposable_container" as const,
        state: "ready" as const,
        runnerUrl: "http://environment:8080",
        runnerCwd: "/workspace",
        rootPath: "/workspace",
        createdBySessionId: "session-main",
        createdAt: 1,
        updatedAt: 1,
      })),
      listDisposableEnvironmentsByOwner: vi.fn(async (input: {agentKey: string; createdBySessionId: string}) => [
        {
          id: "environment:session-main:shim",
          agentKey: input.agentKey,
          kind: "disposable_container" as const,
          state: "ready" as const,
          runnerUrl: "http://environment:8080",
          runnerCwd: "/workspace",
          rootPath: "/workspace",
          createdBySessionId: input.createdBySessionId,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "environment:session-main:old",
          agentKey: input.agentKey,
          kind: "disposable_container" as const,
          state: "stopped" as const,
          runnerUrl: "http://old-environment:8080",
          runnerCwd: "/workspace-old",
          rootPath: "/workspace-old",
          createdBySessionId: input.createdBySessionId,
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
      stopEnvironment: vi.fn(async (environmentId: string) => ({
        id: environmentId,
        agentKey: "panda",
        kind: "disposable_container" as const,
        state: "stopped" as const,
        runnerUrl: "http://environment:8080",
        runnerCwd: "/workspace",
        rootPath: "/workspace",
        createdBySessionId: "session-main",
        createdAt: 1,
        updatedAt: 2,
      })),
      readEnvironmentLogs: vi.fn(async () => ({
        entries: [
          {
            role: "workspace" as const,
            stdout: "workspace ready\n",
            stderr: "",
          },
        ],
      })),
      checkApps: vi.fn(async () => [{
        appSlug: "food-tracker",
        appDir: "/apps/food-tracker",
        ok: true,
        errors: [],
        warnings: [],
      }]),
      createBlankApp: vi.fn(async (agentKey: string, input: {
        slug: string;
        name: string;
        description?: string;
        identityScoped?: boolean;
        schemaSql?: string;
      }) => ({
        actionPath: `/apps/${input.slug}/actions.json`,
        app: {
          agentKey,
          slug: input.slug,
          name: input.name,
          ...(input.description ? {description: input.description} : {}),
          identityScoped: input.identityScoped === true,
          appDir: `/apps/${input.slug}`,
          manifestPath: `/apps/${input.slug}/manifest.json`,
          viewsPath: `/apps/${input.slug}/views.json`,
          actionsPath: `/apps/${input.slug}/actions.json`,
          publicDir: `/apps/${input.slug}/public`,
          entryHtmlPath: `/apps/${input.slug}/public/index.html`,
          hasUi: true,
          dbPath: `/apps/${input.slug}/data/app.sqlite`,
          views: {},
          actions: {},
        },
        manifestPath: `/apps/${input.slug}/manifest.json`,
        readmePath: `/apps/${input.slug}/README.md`,
        schemaApplied: Boolean(input.schemaSql),
        schemaPath: `/apps/${input.slug}/schema.sql`,
        viewPath: `/apps/${input.slug}/views.json`,
      })),
      inspectApps: vi.fn(async () => ({
        apps: [{
          agentKey: "panda",
          slug: "food-tracker",
          name: "Food Tracker",
          identityScoped: false,
          appDir: "/apps/food-tracker",
          manifestPath: "/apps/food-tracker/manifest.json",
          viewsPath: "/apps/food-tracker/views.json",
          actionsPath: "/apps/food-tracker/actions.json",
          publicDir: "/apps/food-tracker/public",
          entryHtmlPath: "/apps/food-tracker/public/index.html",
          hasUi: false,
          dbPath: "/apps/food-tracker/data/app.sqlite",
          views: {
            today_summary: {
              sql: "select 1",
            },
          },
          actions: {},
        }],
        brokenApps: [],
      })),
      getApp: vi.fn(async (agentKey: string, appSlug: string) => ({
        agentKey,
        slug: appSlug,
        name: "Food Tracker",
        identityScoped: false,
        appDir: `/apps/${appSlug}`,
        manifestPath: `/apps/${appSlug}/manifest.json`,
        viewsPath: `/apps/${appSlug}/views.json`,
        actionsPath: `/apps/${appSlug}/actions.json`,
        publicDir: `/apps/${appSlug}/public`,
        entryHtmlPath: `/apps/${appSlug}/public/index.html`,
        hasUi: true,
        dbPath: `/apps/${appSlug}/data/app.sqlite`,
        views: {},
        actions: {},
      })),
      executeView: vi.fn(async (agentKey: string, appSlug: string, viewName: string, options?: {
        params?: Record<string, unknown>;
        pageSize?: number;
        offset?: number;
      }) => ({
        items: [{
          agentKey,
          appSlug,
          viewName,
          ...(options?.params ? {params: options.params} : {}),
          ...(options?.pageSize ? {pageSize: options.pageSize} : {}),
          ...(options?.offset !== undefined ? {offset: options.offset} : {}),
          value: 1,
        }],
      })),
      executeAction: vi.fn(async (_agentKey: string, _appSlug: string, _actionName: string, options?: {
        input?: Record<string, unknown>;
      }) => ({
        mode: "native" as const,
        changes: 1,
        ...(options?.input ? {input: options.input} : {}),
        wakeRequested: false,
      })),
      overviewPages: vi.fn(async (_agentKey: string, input: {locale?: string}) => ({
        operation: "overview",
        namespacePath: "agents/panda",
        locale: input.locale ?? "en",
        recentlyEdited: [{
          title: "Profile",
          path: "agents/panda/profile",
          updatedAt: "2026-06-24T12:00:00.000Z",
        }],
        mostLinked: [{
          title: "Profile",
          path: "agents/panda/profile",
          inboundLinks: 3,
        }],
      })),
      readPage: vi.fn(async (_agentKey: string, input: {path: string; locale?: string}) => ({
        operation: "read",
        found: true,
        id: 1,
        path: input.path,
        locale: input.locale ?? "en",
        title: "Profile",
        description: "",
        content: "# Profile",
        tags: [],
        updatedAt: "2026-06-24T12:00:00.000Z",
      })),
      searchPages: vi.fn(async (_agentKey: string, input: {query: string; path?: string; locale?: string; limit?: number}) => {
        const allResults = [{
          id: "1",
          path: "agents/panda/profile",
          locale: "en",
          title: "Profile",
          description: "",
        }];
        const results = input.limit === undefined ? allResults : allResults.slice(0, input.limit);
        return {
          operation: "search",
          query: input.query,
          path: input.path ?? "agents/panda",
          locale: input.locale ?? "en",
          totalHits: allResults.length,
          count: results.length,
          truncated: results.length < allResults.length,
          suggestions: [],
          results,
        };
      }),
      listPages: vi.fn(async (_agentKey: string, input: {path?: string; locale?: string; limit?: number; includeArchived?: boolean}) => ({
        operation: "list",
        path: input.path ?? "agents/panda",
        locale: input.locale ?? "en",
        count: 1,
        totalPages: 1,
        limit: input.limit ?? null,
        truncated: input.limit === undefined ? false : input.limit < 1,
        scanLimitHit: false,
        includeArchived: input.includeArchived ?? false,
        pages: [{
          id: 1,
          path: "agents/panda/profile",
          locale: "en",
          title: "Profile",
          updatedAt: "2026-06-24T12:00:00.000Z",
        }],
      })),
      diffPages: vi.fn(async (_agentKey: string, input: {leftPath: string; rightPath: string; locale?: string; contextLines?: number}) => ({
        operation: "diff",
        locale: input.locale ?? "en",
        left: {
          id: 1,
          path: input.leftPath,
          locale: input.locale ?? "en",
          title: "Left",
          updatedAt: "2026-06-24T12:00:00.000Z",
          contentLines: 2,
        },
        right: {
          id: 2,
          path: input.rightPath,
          locale: input.locale ?? "en",
          title: "Right",
          updatedAt: "2026-06-24T12:05:00.000Z",
          contentLines: 2,
        },
        equal: false,
        stats: {
          addedLines: 1,
          removedLines: 1,
          unchangedLines: 1,
          leftLines: 2,
          rightLines: 2,
        },
        hunks: [{
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [
            {type: "context", oldLine: 1, newLine: 1, text: "# Profile"},
            {type: "remove", oldLine: 2, text: "old"},
            {type: "add", newLine: 2, text: "new"},
          ],
        }],
        truncated: false,
        contextLines: input.contextLines ?? 3,
      })),
      writePage: vi.fn(async (_agentKey: string, input: {path: string; locale?: string; title?: string}) => ({
        operation: "write",
        action: "updated",
        page: {
          id: 1,
          path: input.path,
          locale: input.locale ?? "en",
          title: input.title ?? "Profile",
          updatedAt: "2026-06-24T12:01:00.000Z",
        },
      })),
      writeSection: vi.fn(async (_agentKey: string, input: {path: string; section: string; locale?: string; title?: string}) => ({
        operation: "write_section",
        action: "updated",
        section: {
          title: input.section,
          action: "replaced",
        },
        page: {
          id: 1,
          path: input.path,
          locale: input.locale ?? "en",
          title: input.title ?? "Profile",
          updatedAt: "2026-06-24T12:01:00.000Z",
        },
      })),
      movePage: vi.fn(async (_agentKey: string, input: {path: string; destinationPath: string; locale?: string; rewriteLinks?: boolean}) => ({
        operation: "move",
        movedFrom: input.path,
        movedTo: input.destinationPath,
        rewriteLinks: input.rewriteLinks ?? false,
        linkRewrite: {
          rewrittenLinks: 0,
          updatedPages: [],
          failedPages: [],
        },
        page: {
          id: 1,
          path: input.destinationPath,
          locale: input.locale ?? "en",
          title: "Profile",
          updatedAt: "2026-06-24T12:01:00.000Z",
        },
      })),
      archivePage: vi.fn(async (_agentKey: string, input: {path: string; locale?: string}) => ({
        operation: "archive",
        archivedFrom: input.path,
        archivedTo: "agents/panda/_archive/2026/06/profile",
        page: {
          id: 1,
          path: "agents/panda/_archive/2026/06/profile",
          locale: input.locale ?? "en",
          title: "Profile",
          updatedAt: "2026-06-24T12:01:00.000Z",
        },
      })),
      restorePage: vi.fn(async (_agentKey: string, input: {path: string; destinationPath: string; locale?: string}) => ({
        operation: "restore",
        restoredFrom: input.path,
        restoredTo: input.destinationPath,
        page: {
          id: 1,
          path: input.destinationPath,
          locale: input.locale ?? "en",
          title: "Profile",
          updatedAt: "2026-06-24T12:01:00.000Z",
        },
      })),
      attachImage: vi.fn(async (_agentKey: string, input: {path: string; slot: string}) => ({
        operation: "attach_image",
        action: "updated",
        upload: "uploaded",
        assetPath: "agents/panda/_assets/profile/profile-photo.png",
        slot: input.slot,
        section: {
          title: "Facts",
          action: "replaced",
        },
        block: {
          slot: input.slot,
          action: "replaced",
        },
        page: {
          id: 1,
          path: input.path,
          locale: "en",
          title: "Profile",
          updatedAt: "2026-06-24T12:01:00.000Z",
        },
      })),
      fetchAsset: vi.fn(async (_agentKey: string, input: {assetPath: string}) => ({
        output: {
          operation: "fetch_asset",
          assetPath: input.assetPath,
          localPath: "/tmp/panda/wiki/profile-photo.png",
          mimeType: "image/png",
          sizeBytes: 3,
        },
        artifact: {
          kind: "image" as const,
          source: "view_media" as const,
          path: "/tmp/panda/wiki/profile-photo.png",
          mimeType: "image/png",
          bytes: 3,
          originalPath: input.assetPath,
        },
      })),
      deleteAsset: vi.fn(async (_agentKey: string, input: {assetPath: string}) => ({
        operation: "delete_asset",
        assetPath: input.assetPath,
        assetId: 44,
        filename: "profile-photo.png",
        deleted: true,
      })),
      readSessionPrompt: vi.fn(async (sessionId: string, slug: "brief" | "memory" | "heartbeat" = "brief") => ({
        sessionId,
        slug,
        content: `${slug} content`,
        createdAt: 1,
        updatedAt: 2,
      })),
      setSessionPrompt: vi.fn(async (input: {sessionId: string; slug?: "brief" | "memory" | "heartbeat"; content: string}) => ({
        sessionId: input.sessionId,
        slug: input.slug ?? "brief",
        content: input.content,
        createdAt: 1,
        updatedAt: 2,
      })),
      transformSessionPrompt: vi.fn(async (input: {
        sessionId: string;
        slug?: "brief" | "memory" | "heartbeat";
      } & (
        | {operation: "append" | "prepend"; text: string}
        | {operation: "replace"; pattern: string; replacement: string}
        | {operation: "expression"; expression: string}
      )) => ({
        record: {
          sessionId: input.sessionId,
          slug: input.slug ?? "brief",
          content: input.operation === "expression"
            ? `${input.expression} result`
            : input.operation === "replace"
              ? `${input.pattern}=>${input.replacement}`
              : input.text,
          createdAt: 1,
          updatedAt: 2,
        },
        operation: input.operation,
        changed: true,
        ...(input.operation === "replace" ? {matchCount: 1} : {}),
      })),
      listAgentSkills: vi.fn(async (agentKey: string) => [
        {
          agentKey,
          skillKey: "calendar",
          description: "Use this for calendar work.",
          content: "# Calendar",
          tags: ["calendar", "planning"],
          agentEditable: true,
          loadCount: 1,
          lastLoadedAt: 2,
          createdAt: 1,
          updatedAt: 2,
        },
        {
          agentKey,
          skillKey: "notes",
          description: "Use this for note work.",
          content: "# Notes",
          tags: ["notes", "reference"],
          agentEditable: true,
          loadCount: 0,
          createdAt: 1,
          updatedAt: 3,
        },
      ]),
      readAgentSkill: vi.fn(async (agentKey: string, skillKey: string) => ({
        agentKey,
        skillKey,
        description: "Use this for calendar work.",
        content: "# Calendar",
        tags: ["calendar"],
        agentEditable: true,
        loadCount: 1,
        lastLoadedAt: 2,
        createdAt: 1,
        updatedAt: 2,
      })),
      loadAgentSkill: vi.fn(async (agentKey: string, skillKey: string) => ({
        agentKey,
        skillKey,
        description: "Use this for calendar work.",
        content: "# Calendar",
        tags: ["calendar"],
        agentEditable: true,
        loadCount: 1,
        lastLoadedAt: 2,
        createdAt: 1,
        updatedAt: 2,
      })),
      setAgentSkillAsAgent: vi.fn(async (agentKey: string, skillKey: string, description: string, content: string, tags: readonly unknown[] = []) => ({
        agentKey,
        skillKey,
        description,
        content,
        tags: tags.map(String),
        agentEditable: true,
        loadCount: 0,
        createdAt: 1,
        updatedAt: 2,
      })),
      updateAgentSkillDescriptionAsAgent: vi.fn(async (agentKey: string, skillKey: string, description: string) => ({
        agentKey,
        skillKey,
        description,
        content: "# Calendar",
        tags: ["calendar"],
        agentEditable: true,
        loadCount: 0,
        createdAt: 1,
        updatedAt: 2,
      })),
      deleteAgentSkillAsAgent: vi.fn(async () => true),
      readSessionTodo: vi.fn(async (sessionId: string) => ({
        sessionId,
        items: [
          {status: "in_progress" as const, content: "Inspect code"},
          {status: "pending" as const, content: "Run tests"},
        ],
        itemsHash: "hash",
        createdAt: 1,
        updatedAt: 1,
      })),
      replaceSessionTodo: vi.fn(async (input: {sessionId: string; items: readonly {status: "pending" | "in_progress" | "blocked" | "done"; content: string}[]}) => ({
        sessionId: input.sessionId,
        items: input.items,
        itemsHash: "hash",
        createdAt: 1,
        updatedAt: 1,
      })),
      upsertProfile: vi.fn(async (input: {
        slug: string;
        agentKey?: string | null;
        description: string;
        prompt: string;
        toolGroups: readonly string[];
        model?: string | null;
        thinking?: "low" | "medium" | "high" | "xhigh" | null;
        enabled?: boolean;
        source: "custom" | "builtin";
        createdByAgentKey?: string | null;
        transcriptMode?: "none" | null;
      }) => ({
        slug: input.slug,
        agentKey: input.agentKey ?? undefined,
        description: input.description,
        prompt: input.prompt,
        toolGroups: input.toolGroups,
        model: input.model ?? undefined,
        thinking: input.thinking ?? undefined,
        transcriptMode: input.transcriptMode ?? "none",
        source: input.source,
        createdByAgentKey: input.createdByAgentKey ?? undefined,
        enabled: input.enabled ?? true,
        createdAt: 1,
        updatedAt: 1,
      })),
      listProfiles: vi.fn(async () => [
        {
          slug: "workspace",
          description: "Workspace helper.",
          prompt: "Help with workspace tasks.",
          toolGroups: ["core"] as const,
          transcriptMode: "none" as const,
          source: "builtin" as const,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          slug: "reviewer",
          agentKey: "panda",
          description: "Review code.",
          prompt: "Inspect changes and report risks.",
          toolGroups: ["core"] as const,
          transcriptMode: "none" as const,
          source: "custom" as const,
          createdByAgentKey: "panda",
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      getProfile: vi.fn(async (input: {slug: string}) => input.slug === "reviewer"
        ? {
          slug: "reviewer",
          agentKey: "panda",
          description: "Review code.",
          prompt: "Inspect changes and report risks.",
          toolGroups: ["core"] as const,
          transcriptMode: "none" as const,
          source: "custom" as const,
          createdByAgentKey: "panda",
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        }
        : null),
      setProfileEnabled: vi.fn(async (input: {slug: string; agentKey: string; enabled: boolean}) => ({
        slug: input.slug,
        agentKey: input.agentKey,
        description: "Review code.",
        prompt: "Inspect changes and report risks.",
        toolGroups: ["core"] as const,
        transcriptMode: "none" as const,
        source: "custom" as const,
        createdByAgentKey: input.agentKey,
        enabled: input.enabled,
        createdAt: 1,
        updatedAt: 2,
      })),
      createSubagentSession: vi.fn(async (input: {
        agentKey: string;
        parentSessionId: string;
        task: string;
        profile?: string;
        context?: string;
        execution?: "agent_workspace" | "isolated_environment";
        environmentId?: string;
        credentialAllowlist?: readonly string[];
        toolGroups?: readonly string[];
      }) => ({
        session: {
          id: "subagent-session",
          metadata: buildSubagentSessionMetadata({
            role: input.profile ?? "workspace",
            task: input.task,
            context: input.context,
            parentSessionId: input.parentSessionId,
            execution: input.execution ?? "agent_workspace",
            ...(input.environmentId ? {environmentId: input.environmentId} : {}),
            profile: {
              slug: input.profile ?? "workspace",
              source: "builtin",
              description: "Workspace helper.",
              prompt: "Help with workspace tasks.",
              toolGroups: input.toolGroups ?? ["core"],
              transcriptMode: "none",
            },
            resolved: {
              credentialPolicy: {
                mode: "allowlist",
                envKeys: input.credentialAllowlist ?? [],
              },
              skillPolicy: {mode: "all_agent"},
              toolPolicy: {allowedTools: ["message_agent"]},
            },
          }),
        },
        thread: {
          id: "subagent-thread",
        },
        ...(input.environmentId
          ? {
            environment: {
              id: input.environmentId,
            },
          }
          : {}),
      })),
      setCredential: vi.fn(async (input: {envKey: string; value: string; agentKey: string}) => ({
        id: "credential-1",
        agentKey: input.agentKey,
        envKey: input.envKey,
        value: input.value,
        keyVersion: 1,
        createdAt: 1,
        updatedAt: 1,
      })),
      clearCredential: vi.fn(async () => true),
      listCredentialMetadata: vi.fn(async () => [
        {
          id: "credential-1",
          agentKey: "panda",
          envKey: "GITHUB_TOKEN",
          keyVersion: 1,
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: "credential-2",
          agentKey: "panda",
          envKey: "OPENAI_API_KEY",
          keyVersion: 2,
          createdAt: 3,
          updatedAt: 4,
        },
      ]),
      getIdentityByHandle: vi.fn(async (handle: string) => ({
        id: "identity-current",
        handle,
      })),
      getLastRoute: vi.fn(async (input: {identityId?: string; channel?: string}) => input.identityId === "identity-current"
        ? {
          source: input.channel ?? "telegram",
          connectorKey: "telegram-main",
          externalConversationId: "chat-1",
          externalActorId: "actor-1",
          capturedAt: 1,
        }
        : null),
      saveLastRoute: vi.fn(async () => {}),
      enqueueDelivery: vi.fn(async (input: {channel: string}) => ({
        id: input.channel === "email" ? "delivery-email" : "delivery-outbound",
        channel: input.channel,
      })),
      listChannelMessages: vi.fn(async (filter: {
        sessionId: string;
        source: string;
        connectorKey: string;
        channelId: string;
        limit?: number;
      }) => {
        const messages = [
          {
            id: "thread-message-telegram-1",
            threadId: "thread-main",
            sequence: 1,
            origin: "input" as const,
            source: "telegram",
            channelId: "1615376408",
            externalMessageId: "555",
            actorId: "1615376408",
            identityId: "identity-current",
            message: {
              role: "user" as const,
              content: [{type: "text" as const, text: "Launch plan looks good."}],
            },
            metadata: {
              route: {
                source: "telegram",
                connectorKey: "telegram-main",
                externalConversationId: "1615376408",
                externalActorId: "1615376408",
                externalMessageId: "555",
              },
              telegram: {
                sentAt: "2026-06-25T10:00:00.000Z",
                chatId: "1615376408",
                chatType: "private",
                messageId: 555,
                username: "alice",
                firstName: "Alice",
                lastName: null,
                media: [
                  {
                    id: "media-1",
                    source: "telegram",
                    connectorKey: "telegram-main",
                    mimeType: "image/png",
                    sizeBytes: 14,
                    originalFilename: "chart.png",
                    localPath: telegramMediaSource,
                    createdAt: 1_766_659_200_000,
                  },
                ],
              },
            },
            createdAt: 10,
          },
          {
            id: "thread-message-discord-1",
            threadId: "thread-main",
            sequence: 2,
            origin: "input" as const,
            source: "discord",
            channelId: "123456789012345678",
            externalMessageId: "623456789012345678",
            actorId: "523456789012345678",
            identityId: "identity-current",
            message: {
              role: "user" as const,
              content: [{type: "text" as const, text: "Discord launch note."}],
            },
            metadata: {
              route: {
                source: "discord",
                connectorKey: "discord-main",
                externalConversationId: "123456789012345678",
                externalActorId: "523456789012345678",
                externalMessageId: "623456789012345678",
              },
              discord: {
                sentAt: "2026-06-25T11:00:00.000Z",
                guildId: "323456789012345678",
                parentChannelId: "123456789012345678",
                actualChannelId: "123456789012345678",
                threadId: null,
                replyToMessageId: null,
                author: {
                  id: "523456789012345678",
                  username: "alice",
                  globalName: "Alice",
                  displayName: "Alice",
                  isBot: false,
                },
                attachments: [
                  {
                    id: "att-1",
                    filename: "plan.pdf",
                    contentType: "application/pdf",
                    sizeBytes: 12,
                  },
                ],
                media: [],
              },
            },
            createdAt: 30,
          },
          {
            id: "thread-message-whatsapp-1",
            threadId: "thread-main",
            sequence: 3,
            origin: "input" as const,
            source: "whatsapp",
            channelId: "421900000000@s.whatsapp.net",
            externalMessageId: "wa-1",
            actorId: "421900000000@s.whatsapp.net",
            identityId: "identity-current",
            message: {
              role: "user" as const,
              content: [{type: "text" as const, text: "WhatsApp launch note."}],
            },
            metadata: {
              route: {
                source: "whatsapp",
                connectorKey: "main",
                externalConversationId: "421900000000@s.whatsapp.net",
                externalActorId: "421900000000@s.whatsapp.net",
                externalMessageId: "wa-1",
              },
              whatsapp: {
                sentAt: "2026-06-25T12:00:00.000Z",
                remoteJid: "421900000000@s.whatsapp.net",
                chatType: "individual",
                messageId: "wa-1",
                pushName: "Alice",
                quotedMessageId: null,
                media: [],
              },
            },
            createdAt: 40,
          },
        ];

        return messages.filter((message) => {
          const metadata = message.metadata as {route?: {connectorKey?: string}} | undefined;
          return filter.sessionId === "session-main"
            && message.source === filter.source
            && message.channelId === filter.channelId
            && metadata?.route?.connectorKey === filter.connectorKey;
        }).slice(0, filter.limit ?? messages.length);
      }),
      findChannelMedia: vi.fn(async (filter: {
        sessionId: string;
        source: string;
        connectorKey: string;
        channelId: string;
        mediaId: string;
      }) => {
        if (
          filter.sessionId !== "session-main"
          || filter.source !== "telegram"
          || filter.connectorKey !== "telegram-main"
          || filter.channelId !== "1615376408"
          || filter.mediaId !== "media-1"
        ) {
          return null;
        }

        return {
          message: {
            id: "thread-message-telegram-1",
            threadId: "thread-main",
            sequence: 1,
            origin: "input" as const,
            source: "telegram",
            channelId: "1615376408",
            externalMessageId: "555",
            actorId: "1615376408",
            identityId: "identity-current",
            message: {
              role: "user" as const,
              content: [{type: "text" as const, text: "Launch plan looks good."}],
            },
            metadata: undefined,
            createdAt: 10,
          },
          media: {
            id: "media-1",
            source: "telegram",
            connectorKey: "telegram-main",
            mimeType: "image/png",
            sizeBytes: 14,
            originalFilename: "chart.png",
            localPath: telegramMediaSource,
            createdAt: 1_766_659_200_000,
          },
        };
      }),
      listDeliveriesForTarget: vi.fn(async (filter: {
        sessionId: string;
        channel: string;
        connectorKey: string;
        externalConversationId: string;
        limit?: number;
      }) => {
        const deliveries = [
          {
            id: "delivery-telegram-1",
            threadId: "thread-main",
            channel: "telegram",
            target: {
              source: "telegram",
              connectorKey: "telegram-main",
              externalConversationId: "1615376408",
              replyToMessageId: "555",
            },
            items: [{type: "text" as const, text: "Thanks, shipping it."}],
            metadata: undefined,
            status: "sent" as const,
            attemptCount: 1,
            sent: [{type: "text" as const, externalMessageId: "556"}],
            completedAt: 21,
            createdAt: 20,
            updatedAt: 21,
          },
          {
            id: "delivery-discord-1",
            threadId: "thread-main",
            channel: "discord",
            target: {
              source: "discord",
              connectorKey: "discord-main",
              externalConversationId: "123456789012345678",
              replyToMessageId: "623456789012345678",
              deliveryContext: {
                discord: {
                  parentChannelId: "123456789012345678",
                  threadId: "223456789012345678",
                  guildId: "323456789012345678",
                },
              },
            },
            items: [{type: "text" as const, text: "Discord ack."}],
            metadata: undefined,
            status: "sent" as const,
            attemptCount: 1,
            sent: [{type: "text" as const, externalMessageId: "723456789012345678"}],
            completedAt: 51,
            createdAt: 50,
            updatedAt: 51,
          },
          {
            id: "delivery-whatsapp-1",
            threadId: "thread-main",
            channel: "whatsapp",
            target: {
              source: "whatsapp",
              connectorKey: "main",
              externalConversationId: "421900000000@s.whatsapp.net",
            },
            items: [{type: "text" as const, text: "WhatsApp ack."}],
            metadata: undefined,
            status: "sent" as const,
            attemptCount: 1,
            sent: [{type: "text" as const, externalMessageId: "wa-2"}],
            completedAt: 61,
            createdAt: 60,
            updatedAt: 61,
          },
        ];

        return deliveries.filter((delivery) => delivery.threadId === "thread-main"
          && filter.sessionId === "session-main"
          && delivery.channel === filter.channel
          && delivery.target.connectorKey === filter.connectorKey
          && delivery.target.externalConversationId === filter.externalConversationId)
          .slice(0, filter.limit ?? deliveries.length);
      }),
      listAccounts: vi.fn(async (filter?: {source?: string; status?: string}) => {
        if (filter?.source === "telegram" && filter.status === "enabled") {
          return [
            {
              id: "connector-account-telegram",
              ownerKind: "agent" as const,
              ownerIdentityId: null,
              ownerAgentKey: "panda",
              source: "telegram",
              accountKey: "main",
              connectorKey: "telegram-main",
              displayName: "Panda Telegram",
              externalAccountId: "bot-1",
              externalUsername: "panda_bot",
              status: "enabled" as const,
              config: {},
              createdAt: 1,
              updatedAt: 2,
            },
          ];
        }
        if (filter?.source === "discord" && filter.status === "enabled") {
          return [
            {
              id: "connector-account-discord",
              ownerKind: "agent" as const,
              ownerIdentityId: null,
              ownerAgentKey: "panda",
              source: "discord",
              accountKey: "main",
              connectorKey: "discord-main",
              displayName: "Panda Discord",
              externalAccountId: "bot-2",
              externalUsername: "panda-discord",
              status: "enabled" as const,
              config: {},
              createdAt: 3,
              updatedAt: 4,
            },
          ];
        }

        return [];
      }),
      listConversationBindings: vi.fn(async (filter: {source: string; connectorKey: string}) => {
        if (filter.source === "telegram" && filter.connectorKey === "telegram-main") {
          return [
            {
              source: "telegram",
              connectorKey: "telegram-main",
              externalConversationId: "1615376408",
              sessionId: "session-main",
              metadata: {
                title: "Launch chat",
              },
              createdAt: 1,
              updatedAt: 2,
            },
            {
              source: "telegram",
              connectorKey: "telegram-main",
              externalConversationId: "other-session-chat",
              sessionId: "session-other",
              createdAt: 1,
              updatedAt: 2,
            },
          ];
        }
        if (filter.source === "discord" && filter.connectorKey === "discord-main") {
          return [
            {
              source: "discord",
              connectorKey: "discord-main",
              externalConversationId: "123456789012345678",
              sessionId: "session-main",
              metadata: {
                name: "launch",
              },
              createdAt: 3,
              updatedAt: 4,
            },
            {
              source: "discord",
              connectorKey: "discord-main",
              externalConversationId: "223456789012345678",
              sessionId: "session-other",
              createdAt: 3,
              updatedAt: 4,
            },
          ];
        }
        if (filter.source === "whatsapp" && filter.connectorKey === "main") {
          return [
            {
              source: "whatsapp",
              connectorKey: "main",
              externalConversationId: "421900000000@s.whatsapp.net",
              sessionId: "session-main",
              metadata: {
                displayName: "Alice",
              },
              createdAt: 5,
              updatedAt: 6,
            },
            {
              source: "whatsapp",
              connectorKey: "main",
              externalConversationId: "421911111111@s.whatsapp.net",
              sessionId: "session-other",
              createdAt: 5,
              updatedAt: 6,
            },
          ];
        }

        return [];
      }),
      getAccount: vi.fn(async (agentKey: string, accountKey: string) => ({
        agentKey,
        accountKey,
        fromAddress: "panda@example.com",
        imap: {
          host: "imap.example.com",
          usernameCredentialEnvKey: "IMAP_USER",
          passwordCredentialEnvKey: "IMAP_PASS",
        },
        smtp: {
          host: "smtp.example.com",
          usernameCredentialEnvKey: "SMTP_USER",
          passwordCredentialEnvKey: "SMTP_PASS",
        },
        mailboxes: ["INBOX"],
        syncState: {},
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      })),
      listEnabledAccounts: vi.fn(async () => [
        {
          agentKey: "panda",
          accountKey: "work",
          fromAddress: "panda@example.com",
          imap: {
            host: "imap.example.com",
            usernameCredentialEnvKey: "IMAP_USER",
            passwordCredentialEnvKey: "IMAP_PASS",
          },
          smtp: {
            host: "smtp.example.com",
            usernameCredentialEnvKey: "SMTP_USER",
            passwordCredentialEnvKey: "SMTP_PASS",
          },
          mailboxes: ["INBOX"],
          syncState: {},
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      listRoutes: vi.fn(async () => [
        {
          id: "route-work",
          agentKey: "panda",
          accountKey: "work",
          sessionId: "session-main",
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      assertAccountSendableBySession: vi.fn(async () => {}),
      assertMessageOwnedBySession: vi.fn(async () => {}),
      getMessage: vi.fn(async (messageId: string) => ({
        id: messageId,
        agentKey: "panda",
        accountKey: "work",
        direction: "inbound" as const,
        sessionId: "session-main",
        mailbox: "INBOX",
        messageIdHeader: `<${messageId}@example.com>`,
        threadKey: `<${messageId}@example.com>`,
        subject: messageId === "message-2" ? "Invoice" : "Question",
        fromName: messageId === "message-2" ? "Billing" : "Alice",
        fromAddress: "alice@example.com",
        receivedAt: Date.parse("2026-06-24T12:00:00.000Z"),
        bodyText: messageId === "message-2" ? "Invoice attached." : "Can you review the launch plan?",
        bodyExcerpt: messageId === "message-2" ? "Invoice attached." : "Can you review the launch plan?",
        authSummary: "trusted" as const,
        hasAttachments: messageId === "message-2",
        createdAt: 1,
      })),
      listMessagesForSession: vi.fn(async () => [
        await store.getMessage("message-1"),
        await store.getMessage("message-2"),
      ]),
      searchMessagesForSession: vi.fn(async (input: {query: string}) => input.query.toLowerCase().includes("invoice")
        ? [await store.getMessage("message-2")]
        : [await store.getMessage("message-1")]),
      listMessageRecipients: vi.fn(async (messageId: string) => [
        {
          id: `recipient-${messageId}`,
          messageId,
          role: "from" as const,
          address: "alice@example.com",
          name: "Alice",
          createdAt: 1,
        },
      ]),
      listMessageAttachments: vi.fn(async (messageId: string) => messageId === "message-2"
        ? [{
          id: "attachment-1",
          messageId,
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          sizeBytes: 11,
          localPath: emailAttachmentSource,
          createdAt: 1,
        }]
        : []),
      getMessageAttachment: vi.fn(async (attachmentId: string) => ({
        id: attachmentId,
        messageId: "message-2",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 11,
        localPath: emailAttachmentSource,
        createdAt: 1,
      })),
      assertRecipientsAllowed: vi.fn(async () => {}),
      enqueueAction: vi.fn(async (input: unknown) => ({
        id: "action-1",
        channel: "telegram",
        connectorKey: "telegram-main",
        kind: (input as {kind?: string}).kind ?? "telegram_reaction",
        payload: input,
        status: "pending" as const,
        attemptCount: 0,
        createdAt: 1,
        updatedAt: 1,
      })),
      getA2ADelivery: vi.fn(async (input: {sessionId: string; deliveryId: string}) => input.deliveryId === "delivery-1"
        ? {
          deliveryId: input.deliveryId,
          messageId: "a2a:shim",
          fromAgentKey: "panda",
          fromSessionId: input.sessionId,
          fromThreadId: "thread-main",
          toAgentKey: "koala",
          toSessionId: "session-b",
          direction: "outbound" as const,
          status: "sent" as const,
          attemptCount: 1,
          itemCount: 1,
          items: [{type: "text" as const, textPreview: "hello"}],
          sentItems: [{type: "text" as const, externalMessageId: "a2a:shim"}],
          sentAt: Date.parse("2026-06-24T12:00:00.000Z"),
          completedAt: Date.parse("2026-06-24T12:00:01.000Z"),
          createdAt: Date.parse("2026-06-24T12:00:00.000Z"),
          updatedAt: Date.parse("2026-06-24T12:00:01.000Z"),
        }
        : null),
      listA2ADeliveries: vi.fn(async (input: {
        sessionId: string;
        peerSessionId?: string;
        direction?: "inbound" | "outbound" | "all";
        limit?: number;
      }) => [
        {
          deliveryId: "delivery-1",
          messageId: "a2a:shim",
          fromAgentKey: "panda",
          fromSessionId: input.sessionId,
          fromThreadId: "thread-main",
          toAgentKey: "koala",
          toSessionId: input.peerSessionId ?? "session-b",
          direction: input.direction === "inbound" ? "inbound" as const : "outbound" as const,
          status: "sent" as const,
          attemptCount: 1,
          itemCount: 1,
          items: [{type: "text" as const, textPreview: "hello"}],
          sentAt: Date.parse("2026-06-24T12:00:00.000Z"),
          completedAt: Date.parse("2026-06-24T12:00:01.000Z"),
          createdAt: Date.parse("2026-06-24T12:00:00.000Z"),
          updatedAt: Date.parse("2026-06-24T12:00:01.000Z"),
        },
      ].slice(0, input.limit ?? 10)),
      queueMessage: vi.fn(async (input: {
        senderAgentKey: string;
        senderSessionId: string;
        senderThreadId: string;
        senderRunId?: string;
        agentKey?: string;
        sessionId?: string;
        items: readonly unknown[];
      }) => {
        options.onA2AQueueMessage?.(input);
        return {
          delivery: {
            id: "delivery-1",
          },
          targetAgentKey: input.agentKey ?? "koala",
          targetSessionId: input.sessionId ?? "session-b",
          messageId: "a2a:shim",
        };
      }),
    };
    const appAuth = {
      createLaunchToken: vi.fn(async () => ({
        token: "pal_launch-token",
        expiresAt: Date.UTC(2026, 4, 13, 12, 0, 0),
      })),
    };
    const inventoryRecord = {
      sessionId: "subagent-session",
      currentThreadId: "subagent-thread",
      profile: "workspace",
      execution: "agent_workspace" as const,
      taskPreview: "Inspect the runtime wiring.",
      startedAt: "2026-07-19T10:00:00.000Z",
      messageCount: 2,
      pendingInputCount: 0,
      lastMessageAt: "2026-07-19T10:02:00.000Z",
      latestRun: {
        id: "subagent-run",
        status: "completed" as const,
        startedAt: "2026-07-19T10:00:01.000Z",
        finishedAt: "2026-07-19T10:01:00.000Z",
        errorSummary: null,
      },
      environment: null,
    };
    const subagentInventory = {
      list: vi.fn(async (input: {runStatus: string; limit: number}) => ({
        records: [{...inventoryRecord, profile: `${input.runStatus}:${input.limit}`}],
        hasMore: false,
      })),
      show: vi.fn(async (input: {sessionId: string}) => input.sessionId === inventoryRecord.sessionId
        ? inventoryRecord
        : null),
    };
    const readonlyPool = new FakeReadonlyPool();
    const backgroundStore = new TestThreadRuntimeStore();
    await backgroundStore.createThread({
      id: "thread-main",
      sessionId: "session-main",
    });
    const audioDir = await mkdtemp(path.join(os.tmpdir(), "panda-command-audio-"));
    directories.push(audioDir);
    await writeFile(path.join(audioDir, "voice.mp3"), Buffer.from("fake-audio-data"));
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({
        commands: [
          ...mcpManagementDescriptors.map(echoInputCommand),
          createTimeNowCommand({
            now: () => new Date("2026-06-24T12:34:56.000Z"),
          }),
          createVentSendCommand(),
          createWebFetchCommand({
            fetchImpl: async () => new Response(`
              <html>
                <head><title>Example Article</title></head>
                <body><main><p>Hello <a href="/docs">Docs</a>.</p></main></body>
              </html>
            `, {
              status: 200,
              headers: {"content-type": "text/html; charset=utf-8"},
            }),
            lookupHostname: async () => ["93.184.216.34"],
            resourceStore: webResources,
          }),
          createWebReadCommand({resourceStore: webResources}),
          createBraveWebSearchCommand({
            apiKey: "BSA-test-key",
            fetchImpl: options.braveWebFetchImpl ?? (async () => new Response(JSON.stringify({
              web: {
                results: [{
                  title: "Brave Web",
                  url: "https://example.com/brave-web",
                  description: "Web result.",
                }],
              },
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            })),
          }),
          createBraveNewsSearchCommand({
            apiKey: "BSA-test-key",
            fetchImpl: async () => new Response(JSON.stringify({
              results: [{
                title: "Brave News",
                url: "https://news.example.com/brave-news",
                description: "News result.",
              }],
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            }),
          }),
          createBraveVideoSearchCommand({
            apiKey: "BSA-test-key",
            fetchImpl: async () => new Response(JSON.stringify({
              results: [{
                title: "Brave Video",
                url: "https://video.example.com/brave-video",
                description: "Video result.",
              }],
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            }),
          }),
          createBraveImageSearchCommand({
            apiKey: "BSA-test-key",
            fetchImpl: async () => new Response(JSON.stringify({
              results: [{
                title: "Brave Image",
                url: "https://images.example.com/brave-image-page",
                description: "Image result.",
                properties: {
                  url: "https://images.example.com/brave-image.jpg",
                  width: 640,
                  height: 480,
                },
              }],
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            }),
          }),
          createBraveLlmContextCommand({
            apiKey: "BSA-test-key",
            fetchImpl: async () => new Response(JSON.stringify({
              grounding: {
                generic: [{
                  url: "https://example.com/context",
                  title: "Context",
                  snippets: ["Grounded context."],
                }],
              },
              sources: {
                "https://example.com/context": {
                  title: "Context",
                  hostname: "example.com",
                },
              },
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            }),
          }),
          createBravePlaceSearchCommand({
            apiKey: "BSA-test-key",
            fetchImpl: async () => new Response(JSON.stringify({
              results: [{
                id: "loc-shim",
                title: "Brave Place",
                description: "Place result.",
                coordinates: [48.1486, 17.1077],
              }],
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            }),
          }),
          createBravePlacePoiCommand({
            apiKey: "BSA-test-key",
            fetchImpl: async () => new Response(JSON.stringify({
              results: [{
                id: "loc-shim",
                profiles: [],
              }],
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            }),
          }),
          createBravePlaceDescriptionCommand({
            apiKey: "BSA-test-key",
            fetchImpl: async () => new Response(JSON.stringify({
              descriptions: [{
                id: "loc-shim",
                description: "Place description.",
              }],
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            }),
          }),
          createOpenAIWebResearchCommand({
            jobService: new BackgroundToolJobService({
              store: backgroundStore,
            }),
            apiKey: "openai-test-key",
            fetchImpl: async () => new Response(JSON.stringify({
              id: "resp_123",
              status: "completed",
              output_text: "TypeScript shipped a release.",
              output: [{
                type: "message",
                content: [{
                  type: "output_text",
                  text: "TypeScript shipped a release.",
                  annotations: [],
                }],
              }],
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            }),
          }),
          createImageGenerateCommand({
            jobService: new BackgroundToolJobService({
              store: backgroundStore,
            }),
            env: {
              ...process.env,
              OPENAI_OAUTH_TOKEN: "codex-token",
            },
            client: {
              generate: vi.fn(async (request) => ({
                provider: "openai" as const,
                authKind: "codex-oauth" as const,
                model: request.model,
                images: [{
                  buffer: Buffer.from("generated-image"),
                  mimeType: "image/png",
                  fileName: "image-1.png",
                }],
              })),
            },
          }),
          createWhisperTranscribeCommand({
            apiKey: "openai-test-key",
            fetchImpl: async () => new Response(JSON.stringify({
              text: "ahoj panda",
              language: "sk",
              duration: 1.5,
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            }),
          }, {
            async resolveReadablePath({file}) {
              return {
                displayPath: file.path,
                path: path.join(audioDir, file.path),
              };
            },
          }),
          createWhisperTranslateCommand({
            apiKey: "openai-test-key",
            fetchImpl: async () => new Response(JSON.stringify({
              text: "hello panda",
            }), {
              status: 200,
              headers: {"content-type": "application/json"},
            }),
          }, {
            async resolveReadablePath({file}) {
              return {
                displayPath: file.path,
                path: path.join(audioDir, file.path),
              };
            },
          }),
          createWatchListCommand(store),
          createWatchShowCommand(store),
          createWatchRunsCommand(store),
          createWatchCreateCommand(mutations),
          createWatchUpdateCommand(mutations),
          createWatchDisableCommand(store),
          createScheduleListCommand(store),
          createScheduleShowCommand(store),
          createScheduleRunsCommand(store),
          createScheduleCreateCommand(store),
          createScheduleUpdateCommand(store),
          createScheduleCancelCommand(store),
          createAppCheckCommand(store),
          createAppCreateCommand(store),
          createAppLinkCreateCommand(store, appAuth, {
            resolveLaunchUrls: ({agentKey, appSlug, token}) => ({
              appUrl: `http://localhost:3000/${agentKey}/apps/${appSlug}/`,
              localAppUrl: `http://127.0.0.1:3000/${agentKey}/apps/${appSlug}/`,
              openUrl: `http://localhost:3000/apps/open?token=${token}`,
            }),
          }),
          createAppListCommand(store),
          createAppViewCommand(store),
          createAppActionCommand(store),
          createEnvironmentCreateCommand({
            lifecycle: store,
          }, {
            async resolveReadablePath({file}) {
              return {
                path: file.path,
                displayPath: file.path,
              };
            },
          }),
          createEnvironmentListCommand({
            environments: store,
          }),
          createEnvironmentShowCommand({
            environments: store,
          }),
          createEnvironmentStopCommand({
            environments: store,
            lifecycle: store,
          }),
          createEnvironmentLogsCommand({
            environments: store,
            lifecycle: store,
          }),
          createWikiOverviewCommand(store),
          createWikiReadCommand(store),
          createWikiSearchCommand(store),
          createWikiListCommand(store),
          createWikiDiffCommand(store),
          createWikiWriteCommand(store),
          createWikiWriteSectionCommand(store),
          createWikiMoveCommand(store),
          createWikiArchiveCommand(store),
          createWikiRestoreCommand(store),
          createWikiAttachImageCommand(store, {
            async resolveReadablePath({file}) {
              return {
                path: file.path,
                displayPath: file.path,
              };
            },
          }),
          createWikiFetchAssetCommand(store),
          createWikiDeleteAssetCommand(store),
          createPostgresReadonlyQueryCommand({
            pool: readonlyPool,
          }),
          createSkillListCommand(store),
          createSkillShowCommand(store),
          createSkillLoadCommand(store),
          createSkillSetCommand(store),
          createSkillPatchCommand(store),
          createSkillDeleteCommand(store),
          createSessionPromptReadCommand(store),
          createSessionPromptSetCommand(store),
          createSessionPromptTransformCommand(store),
          createTodoAddCommand(store),
          createTodoListCommand(store),
          createTodoShowCommand(store),
          createTodoDoneCommand(store),
          createTodoBlockCommand(store),
          createTodoClearCommand(store),
          createSubagentProfileListCommand(store),
          createSubagentProfileShowCommand(store),
          createSubagentProfileUpsertCommand(store),
          createSubagentProfileEnableCommand(store),
          createSubagentProfileDisableCommand(store),
          createSubagentSpawnCommand(store),
          createSubagentListCommand(subagentInventory),
          createSubagentShowCommand(subagentInventory),
          createListEnvValuesCommand(store),
          createSetEnvValueCommand(store),
          createClearEnvValueCommand(store),
          createTelegramChatListCommand({
            connectorAccounts: store,
            conversations: store,
          }),
          createTelegramChatInfoCommand({
            connectorAccounts: store,
            conversations: store,
          }),
          createTelegramHistoryCommand({
            connectorAccounts: store,
            conversations: store,
            messages: store,
            deliveries: store,
          }),
          createTelegramMediaFetchCommand({
            connectorAccounts: store,
            conversations: store,
            messages: store,
          }, {
            async resolveWritablePath({file}) {
              return {
                path: file.path,
                displayPath: file.path,
              };
            },
          }),
          createTelegramSendCommand({
            enqueueDelivery: (input) => store.enqueueDelivery(input),
            listConversationBindings: (filter) => store.listConversationBindings(filter),
          }, {
            async resolveReadablePath({file}) {
              return {
                path: file.path,
                displayPath: file.path,
              };
            },
          }),
          createTelegramEditCommand(store),
          createTelegramDeleteCommand(store),
          createTelegramPinCommand(store),
          createTelegramUnpinCommand(store),
          createTelegramStickerSendCommand(store, {
            async resolveReadablePath({file}) {
              return {
                path: file.path,
                displayPath: file.path,
              };
            },
          }),
          createDiscordChannelListCommand({
            connectorAccounts: store,
            conversations: store,
          }),
          createDiscordHistoryCommand({
            connectorAccounts: store,
            conversations: store,
            messages: store,
            deliveries: store,
          }),
          createDiscordSendCommand({
            enqueueDelivery: (input) => store.enqueueDelivery(input),
            listConversationBindings: (filter) => store.listConversationBindings(filter),
          }, {
            async resolveReadablePath({file}) {
              return {
                path: file.path,
                displayPath: file.path,
              };
            },
          }),
          createWhatsAppChatListCommand({
            conversations: store,
          }),
          createWhatsAppHistoryCommand({
            conversations: store,
            messages: store,
            deliveries: store,
          }),
          createWhatsAppSendCommand({
            enqueueDelivery: (input) => store.enqueueDelivery(input),
            listConversationBindings: (filter) => store.listConversationBindings(filter),
          }, {
            async resolveReadablePath({file}) {
              return {
                path: file.path,
                displayPath: file.path,
              };
            },
          }),
          createTelegramReactCommand(store),
          createA2ASendCommand(store, commandUploads),
          createA2AInspectCommand(store),
          createA2AHistoryCommand(store),
          createEmailSendCommand({
            store,
            queue: {
              enqueueDelivery: (input) => store.enqueueDelivery(input),
            },
          }, {
            async resolveReadablePath({file}) {
              return {
                path: file.path,
                displayPath: file.path,
              };
            },
          }),
          createEmailAccountListCommand({
            store,
          }),
          createEmailListCommand({
            store,
          }),
          createEmailReadCommand({
            store,
          }),
          createEmailSearchCommand({
            store,
          }),
          createEmailAttachmentsFetchCommand({
            store,
          }, {
            async resolveWritablePath({file}) {
              return {
                path: path.join(emailAttachmentDir, file.path),
                displayPath: file.path,
              };
            },
          }),
        ],
      }),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-a", {
          agentKey: "panda",
          sessionId: "session-main",
          threadId: "thread-main",
          identityId: "identity-current",
          allowedCommands: defaultTestCommandScopeAllowedCommands,
          skillPolicy: {
            mode: "all_agent",
          },
          credentialMutationAllowed: true,
        }],
      ]),
      ...(options.socketPath ? {socketPath: options.socketPath} : {}),
      fileUploads: commandUploads,
    });
    servers.push(server);
    return server;
  }

  function shimEnv(server: CommandHttpServer) {
    return {
      ...process.env,
      ...(server.socketPath ? {PANDA_COMMAND_SOCKET: server.socketPath} : {PANDA_COMMAND_URL: server.url}),
      PANDA_COMMAND_TOKEN: "token-a",
    };
  }

  it("keeps shim routes aligned with the default command descriptor catalog", () => {
    expect(DEFAULT_AGENT_COMMAND_SHIM_ROUTES.map((route) => route.command)).toEqual(
      DEFAULT_AGENT_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name),
    );
  });

  it("derives descriptor, route, and default policy projections from command modules", () => {
    expect(DEFAULT_AGENT_COMMAND_DESCRIPTORS).toEqual(
      commandDescriptorsFromModules(DEFAULT_AGENT_COMMAND_MODULES),
    );
    expect(DEFAULT_AGENT_COMMAND_SHIM_ROUTES).toEqual(
      commandRoutesFromModules(DEFAULT_AGENT_COMMAND_MODULES),
    );
    expect(Object.fromEntries(
      DEFAULT_AGENT_COMMAND_MODULES
        .filter((module) => module.policy.capability !== module.descriptor.name)
        .map((module) => [module.descriptor.name, module.policy.capability]),
    )).toEqual({
      "mcp.tools": "mcp.*",
      "mcp.call": "mcp.*",
      "mcp.server.list": "mcp.manage.*",
      "mcp.server.show": "mcp.manage.*",
      "mcp.server.add": "mcp.manage.*",
      "mcp.server.update": "mcp.manage.*",
      "mcp.server.enable": "mcp.manage.*",
      "mcp.server.disable": "mcp.manage.*",
      "mcp.server.delete": "mcp.manage.*",
      "mcp.server.test": "mcp.manage.*",
      "mcp.oauth.discover": "mcp.manage.*",
      "mcp.oauth.start": "mcp.manage.*",
      "mcp.oauth.status": "mcp.manage.*",
      "mcp.oauth.disconnect": "mcp.manage.*",
      "subagent.list": "subagent.spawn",
      "subagent.show": "subagent.spawn",
    });
    expect(DEFAULT_AGENT_COMMAND_MODULES
      .filter((module) => module.policy.capability === module.descriptor.name)
      .map((module) => module.policy.capability)).toEqual(
        DEFAULT_AGENT_COMMAND_MODULES
          .filter((module) => module.policy.capability === module.descriptor.name)
          .map((module) => module.descriptor.name),
      );
  });

  it("executes agent MCP management flags through the public shim routes", async () => {
    const server = await startWatchServer();
    const env = shimEnv(server);
    const config = {
      transport: "stdio",
      enabled: false,
      command: "node",
      args: ["fixture.mjs"],
      env: {TOKEN: {credentialEnvKey: "TOKEN"}},
      timeoutMs: 30_000,
    };

    const added = await execFileAsync(shimPath, [
      "mcp", "server", "add", "fixture",
      "--config", JSON.stringify(config),
      "--expected-version", "0",
    ], {env});
    expect(JSON.parse(added.stdout)).toEqual({server: "fixture", config, expectedVersion: 0});

    const tested = await execFileAsync(shimPath, ["mcp", "server", "test", "fixture", "--timeout-ms", "5000"], {env});
    expect(JSON.parse(tested.stdout)).toEqual({server: "fixture", timeoutMs: 5_000});

    const started = await execFileAsync(shimPath, [
      "mcp", "oauth", "start", "fixture",
      "--manual-client", '{"clientId":"client-id","tokenEndpointAuthMethod":"none"}',
    ], {env});
    expect(JSON.parse(started.stdout)).toEqual({
      server: "fixture",
      manualClient: {clientId: "client-id", tokenEndpointAuthMethod: "none"},
    });

    const deleted = await execFileAsync(shimPath, ["mcp", "server", "delete", "fixture", "--expected-version", "4"], {env});
    expect(JSON.parse(deleted.stdout)).toEqual({server: "fixture", expectedVersion: 4});
  });

  it("uses canonical command names instead of removed namespace wildcards in test leases", () => {
    expect(defaultTestCommandScopeAllowedCommands).toEqual(
      DEFAULT_AGENT_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name),
    );
    for (const removedPattern of ["agent.*", "message.*", "outbound.*", "audio.*", "app.*"]) {
      expect(defaultTestCommandScopeAllowedCommands).not.toContain(removedPattern);
    }
  });

  it("prints only generic local JSON help for default shim routes without transport", async () => {
    for (const route of DEFAULT_AGENT_COMMAND_SHIM_ROUTES) {
      const {stdout} = await execFileAsync(shimPath, [
        ...route.helpArgv,
        "--help",
        "--json",
      ]);
      const payload = JSON.parse(stdout);
      expect(payload, route.command).toMatchObject({
        name: route.command,
        summary: "Detailed help requires current agent command access.",
      });
      expect(payload.arguments, route.command).toEqual([]);
      expect(payload.examples, route.command).toEqual([]);
      expect(payload.schemaCatalog, route.command).toBeUndefined();
    }
  });

  it("executes time.now through the native no-argument form", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "time",
      "now",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      isoTimestamp: "2026-06-24T12:34:56.000Z",
      timeZone: expect.any(String),
      weekday: expect.any(String),
      month: expect.any(String),
    });
  });

  it("executes time.now through native timezone and format flags", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "time",
      "now",
      "--timezone",
      "UTC",
      "--format",
      "iso",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      display: "2026-06-24T12:34:56.000Z",
      format: "iso",
      isoTimestamp: "2026-06-24T12:34:56.000Z",
      timeZone: "UTC",
    });
  });

  it("executes time.now JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "time",
      "now",
      "--json",
      "{}",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      isoTimestamp: "2026-06-24T12:34:56.000Z",
      timeZone: expect.any(String),
      weekday: expect.any(String),
      month: expect.any(String),
    });
  });

  it("keeps command output quiet when downstream pipes exit early", async () => {
    const server = await startWatchServer();
    const env = shimEnv(server);
    const pipelines = [
      "\"$1\" commands --output json | head -c 1 >/dev/null",
      "\"$1\" commands | head -n 1 >/dev/null",
      "\"$1\" time now --json '{}' | head -c 1 >/dev/null",
    ];

    for (const pipeline of pipelines) {
      const {stderr} = await execFileAsync("bash", [
        "-o",
        "pipefail",
        "-c",
        pipeline,
        "bash",
        shimPath,
      ], {env});
      expect(stderr).not.toContain("curl:");
    }
  });

  it("executes vent.send native payloads through the transport without echoing the message", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "vent",
      "--message",
      "private frustration",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      status: "dropped",
      reason: "trace_not_configured",
      traceConfigured: false,
      messageLength: "private frustration".length,
    });
    expect(stdout).not.toContain("private frustration");
  });

  it("rejects removed agent.vent compatibility command", async () => {
    await expect(execFileAsync(shimPath, [
      "agent",
      "vent",
      "--json",
      '{"message":"private frustration"}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda command"),
    });
  });

  it("executes web.fetch JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "web",
      "fetch",
      "--json",
      '{"url":"https://example.com/article"}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      url: "https://example.com/article",
      finalUrl: "https://example.com/article",
      status: 200,
      title: "Example Article",
      content: expect.stringContaining("Hello"),
      links: [{
        text: "Docs",
        url: "https://example.com/docs",
      }],
    });
  });

  it("executes web.fetch native flags through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "web",
      "fetch",
      "https://example.com/article",
      "--chunk-chars",
      "5",
      "--no-links",
    ], {
      env: shimEnv(server),
    });

    const output = JSON.parse(stdout);
    expect(output).toMatchObject({
      url: "https://example.com/article",
      finalUrl: "https://example.com/article",
      status: 200,
      title: "Example Article",
      truncated: true,
      contentFormat: "markdown",
    });
    expect(output).not.toHaveProperty("links");
    expect(output.content).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
    expect(output.content).toContain("Hello");

    const read = await execFileAsync(shimPath, [
      "web",
      "read",
      output.resourceRef,
      "--cursor",
      output.nextCursor,
      "--chunk-chars",
      "100",
    ], {env: shimEnv(server)});
    expect(JSON.parse(read.stdout)).toMatchObject({
      operation: "read",
      resourceRef: output.resourceRef,
      content: expect.any(String),
    });
  });

  it("rejects removed web.fetch limit flags before transport", async () => {
    await expect(execFileAsync(shimPath, [
      "web",
      "fetch",
      "https://example.com/article",
      "--max-chars",
      "5",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda web fetch --max-chars was removed; use --chunk-chars."),
    });
  });

  it("rejects removed web.fetch JSON limit fields before transport", async () => {
    await expect(execFileAsync(shimPath, [
      "web",
      "fetch",
      "--json",
      '{"url":"https://example.com/article","maxContentChars":5}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda web fetch maxContentChars was removed; use chunkChars."),
    });
  });

  it("rejects removed web.search compatibility command", async () => {
    await expect(execFileAsync(shimPath, [
      "web",
      "search",
      "--json",
      '{"query":"latest TypeScript release"}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda web command"),
    });
  });

  it("executes brave vertical commands through native args", async () => {
    const server = await startWatchServer();

    const web = await execFileAsync(shimPath, [
      "brave",
      "web",
      "search",
      "durable CLI design",
      "-n",
      "3",
      "--freshness",
      "pw",
      "--extra-snippets",
    ], {
      env: shimEnv(server),
    });
    expect(JSON.parse(web.stdout)).toMatchObject({
      provider: "brave",
      vertical: "web",
      query: "durable CLI design",
      resultCount: 1,
      results: [{
        title: "Brave Web",
      }],
    });

    const news = await execFileAsync(shimPath, [
      "brave",
      "news",
      "search",
      "AI regulation",
      "--freshness",
      "pd",
    ], {
      env: shimEnv(server),
    });
    expect(JSON.parse(news.stdout)).toMatchObject({
      provider: "brave",
      vertical: "news",
      query: "AI regulation",
      resultCount: 1,
      results: [{
        title: "Brave News",
      }],
    });

    const video = await execFileAsync(shimPath, [
      "brave",
      "video",
      "search",
      "machine learning tutorial",
      "-n",
      "10",
      "--freshness",
      "pw",
      "--no-spellcheck",
    ], {
      env: shimEnv(server),
    });
    expect(JSON.parse(video.stdout)).toMatchObject({
      provider: "brave",
      vertical: "video",
      query: "machine learning tutorial",
      resultCount: 1,
      results: [{
        title: "Brave Video",
      }],
    });

    const image = await execFileAsync(shimPath, [
      "brave",
      "image",
      "search",
      "modern architecture",
      "-n",
      "20",
      "--safe",
      "strict",
    ], {
      env: shimEnv(server),
    });
    expect(JSON.parse(image.stdout)).toMatchObject({
      provider: "brave",
      vertical: "image",
      query: "modern architecture",
      resultCount: 1,
      results: [{
        title: "Brave Image",
        originalImageUrl: "https://images.example.com/brave-image.jpg",
      }],
    });

    const context = await execFileAsync(shimPath, [
      "brave",
      "llm",
      "context",
      "agent command architecture",
      "--max-tokens",
      "8192",
      "--max-urls",
      "5",
      "--threshold",
      "strict",
    ], {
      env: shimEnv(server),
    });
    expect(JSON.parse(context.stdout)).toMatchObject({
      provider: "brave",
      vertical: "llm_context",
      query: "agent command architecture",
      resultCount: 1,
      grounding: {
        generic: [{
          title: "Context",
        }],
      },
    });

    const place = await execFileAsync(shimPath, [
      "brave",
      "place",
      "search",
      "cafes",
      "--location",
      "bratislava slovakia",
      "-n",
      "5",
    ], {
      env: shimEnv(server),
    });
    expect(JSON.parse(place.stdout)).toMatchObject({
      provider: "brave",
      vertical: "place",
      query: "cafes",
      resultCount: 1,
      places: [{
        id: "loc-shim",
        title: "Brave Place",
      }],
    });

    const poi = await execFileAsync(shimPath, [
      "brave",
      "place",
      "poi",
      "loc-shim",
    ], {
      env: shimEnv(server),
    });
    expect(JSON.parse(poi.stdout)).toMatchObject({
      provider: "brave",
      vertical: "place_poi",
      ids: ["loc-shim"],
      payload: {
        results: [{
          id: "loc-shim",
        }],
      },
    });

    const description = await execFileAsync(shimPath, [
      "brave",
      "place",
      "description",
      "--id",
      "loc-shim",
    ], {
      env: shimEnv(server),
    });
    expect(JSON.parse(description.stdout)).toMatchObject({
      provider: "brave",
      vertical: "place_description",
      ids: ["loc-shim"],
      payload: {
        descriptions: [{
          description: "Place description.",
        }],
      },
    });
  });

  it("prints structured safe Brave throttle errors", async () => {
    const server = await startWatchServer({
      braveWebFetchImpl: async () => new Response("provider-secret-body", {
        status: 429,
        headers: {
          "retry-after": "60",
          "x-provider-secret": "do-not-return",
        },
      }),
    });

    const error = await execFileAsync(shimPath, [
      "brave",
      "web",
      "search",
      "private query",
    ], {
      env: shimEnv(server),
    }).then(() => null, (reason: unknown) => reason as {stderr: string});

    expect(error).not.toBeNull();
    const payload = JSON.parse(error?.stderr.trim() ?? "{}");
    expect(payload).toMatchObject({
      ok: false,
      command: "brave.web.search",
      error: {
        code: "rate_limited",
        message: "Brave Search remained rate limited after bounded retries.",
        details: {
          provider: "brave",
          status: 429,
          retryable: true,
          retryAfterMs: expect.any(Number),
          attemptCount: 1,
          autoRetryExhausted: true,
        },
      },
    });
    expect(payload.error.details.retryAfterMs).toBeGreaterThanOrEqual(59_000);
    expect(payload.error.details.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(error?.stderr).not.toContain("private query");
    expect(error?.stderr).not.toContain("provider-secret-body");
    expect(error?.stderr).not.toContain("x-provider-secret");
  });

  it("prints terminal permission denials as compact JSON and exits 3 without retrying", async () => {
    const execute = vi.fn(createTimeNowCommand().execute);
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({
        commands: [{...createTimeNowCommand(), execute}],
      }),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-limited", {
          agentKey: "panda",
          sessionId: "session-main",
          allowedCommands: ["watch.create"],
        }],
      ]),
    });
    servers.push(server);

    const error = await execFileAsync(shimPath, ["time", "now"], {
      env: {...shimEnv(server), PANDA_COMMAND_TOKEN: "token-limited"},
    }).then(() => null, (reason: unknown) => reason as {code: number; stderr: string});

    expect(error?.code).toBe(3);
    expect(error?.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(error?.stderr.trim() ?? "{}")).toMatchObject({
      ok: false,
      command: "time.now",
      error: {
        code: "forbidden",
        details: {
          failureCode: "capability_missing",
          retryable: false,
          requiredCapability: "time.now",
          nextAction: {kind: "discover_capabilities", command: "panda commands --output json"},
          exitCode: 3,
        },
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves stale conflict JSON and exits 4 without repeating the write", async () => {
    const execute = vi.fn(async () => {
      throw commandStaleVersionConflict({
        message: "The Wiki page changed after the supplied baseUpdatedAt.",
        resource: {
          kind: "wiki_page",
          path: "agents/panda/profile",
          locale: "en",
          latestUpdatedAt: "2026-07-18T20:00:00.000Z",
        },
        nextAction: {
          kind: "refresh_merge_write",
          command: "panda wiki read agents/panda/profile",
        },
      });
    });
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({
        commands: [{...createTimeNowCommand(), execute}],
      }),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-a", {
          agentKey: "panda",
          sessionId: "session-main",
          allowedCommands: ["time.now"],
        }],
      ]),
    });
    servers.push(server);

    const error = await execFileAsync(shimPath, ["time", "now"], {
      env: {...shimEnv(server), PANDA_COMMAND_TOKEN: "token-a"},
    }).then(() => null, (reason: unknown) => reason as {code: number; stderr: string});

    expect(error?.code).toBe(4);
    expect(error?.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(error?.stderr.trim() ?? "{}")).toMatchObject({
      ok: false,
      command: "time.now",
      error: {
        code: "conflict",
        details: {
          failureCode: "stale_version",
          retryable: false,
          requiresRefresh: true,
          resource: {
            kind: "wiki_page",
            path: "agents/panda/profile",
            locale: "en",
            latestUpdatedAt: "2026-07-18T20:00:00.000Z",
          },
          nextAction: {
            kind: "refresh_merge_write",
            command: "panda wiki read agents/panda/profile",
          },
          exitCode: 4,
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(error?.stderr).not.toContain("content");
  });

  it("preserves structured auth denials without exposing the bearer token", async () => {
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({commands: [createTimeNowCommand()]}),
      leaseVerifier: createTestCommandLeaseVerifier(),
    });
    servers.push(server);

    const error = await execFileAsync(shimPath, ["time", "now"], {
      env: {...shimEnv(server), PANDA_COMMAND_TOKEN: "private-invalid-token"},
    }).then(() => null, (reason: unknown) => reason as {code: number; stderr: string});

    expect(error?.code).toBe(3);
    const payload = JSON.parse(error?.stderr.trim() ?? "{}");
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "unauthorized",
        details: {failureCode: "bearer_invalid", retryable: false, exitCode: 3},
      },
    });
    expect(payload).not.toHaveProperty("command");
    expect(error?.stderr).not.toContain("private-invalid-token");
    expect(error?.stderr).not.toContain("requiredCapability");
  });

  it("rejects removed web.research compatibility command", async () => {
    await expect(execFileAsync(shimPath, [
      "web",
      "research",
      "--json",
      '{"query":"latest TypeScript release"}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda web command"),
    });
  });

  it("rejects removed openai web_research compatibility command", async () => {
    await expect(execFileAsync(shimPath, [
      "openai",
      "web_research",
      "--json",
      '{"query":"latest TypeScript release"}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda openai command"),
    });
  });

  it("executes openai.web_research through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "openai",
      "web-research",
      "latest TypeScript release",
      "--effort",
      "medium",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      kind: "web_research",
      status: "running",
      summary: "latest TypeScript release",
      progress: {
        status: "researching",
        query: "latest TypeScript release",
      },
    });
  });

  it("executes image.generate JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "image",
      "generate",
      "--json",
      '{"prompt":"Generate a square sticker."}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      kind: "image_generate",
      status: "running",
      summary: "Generate a square sticker.",
      progress: {
        status: "generating_image",
      },
    });
  });

  it("executes image.generate through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-image-shim-"));
    directories.push(directory);
    const promptPath = path.join(directory, "prompt.txt");
    await writeFile(promptPath, "Generate a square sticker.", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "image",
      "generate",
      "--prompt",
      `@${promptPath}`,
      "--size",
      "1024x1024",
      "--quality",
      "high",
      "--format",
      "webp",
      "--compression",
      "80",
      "--background",
      "opaque",
      "--moderation",
      "low",
      "--count",
      "2",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      kind: "image_generate",
      status: "running",
      summary: "Generate a square sticker.",
      progress: {
        status: "generating_image",
        size: "1024x1024",
        quality: "high",
        outputFormat: "webp",
        count: 2,
      },
    });
  });

  it("executes whisper.translate JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "whisper",
      "translate",
      "--json",
      '{"path":"voice.mp3","prompt":"Panda vocabulary"}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      text: "hello panda",
      provider: "openai",
      model: "whisper-1",
      originalPath: "voice.mp3",
      targetLanguage: "en",
      translationChars: 11,
    });
  });

  it("executes whisper.translate through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "whisper",
      "translate",
      "voice.mp3",
      "--prompt",
      "Panda vocabulary",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      text: "hello panda",
      provider: "openai",
      model: "whisper-1",
      originalPath: "voice.mp3",
      targetLanguage: "en",
      translationChars: 11,
    });
  });

  it("rejects removed audio.transcribe compatibility command", async () => {
    await expect(execFileAsync(shimPath, [
      "audio",
      "transcribe",
      "voice.mp3",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda command"),
    });
  });

  it("executes whisper.transcribe through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "whisper",
      "transcribe",
      "voice.mp3",
      "--language",
      "sk",
      "--prompt",
      "Panda vocabulary",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      text: "ahoj panda",
      provider: "openai",
      model: "whisper-1",
      originalPath: "voice.mp3",
      language: "sk",
      durationSeconds: 1.5,
    });
  });

  it("discovers schema catalog through daemon-backed descriptor JSON help", async () => {
    const server = await startWatchServer();
    const {stdout} = await execFileAsync(shimPath, ["watch", "create", "--help", "--json"], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      name: "watch.create",
      resultShape: {
        watchId: "string",
      },
      schemaCatalog: {
        sources: {
          http_json: {
            example: expect.objectContaining({
              kind: "http_json",
            }),
          },
        },
        detectors: {
          percent_change: {
            example: expect.objectContaining({
              kind: "percent_change",
            }),
          },
        },
      },
    });
  });

  it("executes commands through a Unix socket transport", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-command-socket-"));
    directories.push(directory);
    const queuedMessages: unknown[] = [];
    const server = await startWatchServer({
      socketPath: path.join(directory, "command.sock"),
      onA2AQueueMessage: (input) => queuedMessages.push(input),
    });

    const {stdout} = await execFileAsync(shimPath, ["time", "now", "--json", "{}"], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      isoTimestamp: "2026-06-24T12:34:56.000Z",
    });

    const attachmentPath = path.join(directory, "socket-attachment.txt");
    await writeFile(attachmentPath, "socket attachment", "utf8");
    await execFileAsync(shimPath, [
      "a2a",
      "send",
      "--to-session",
      "session-b",
      "--file",
      attachmentPath,
    ], {env: shimEnv(server)});
    expect(queuedMessages).toEqual([
      expect.objectContaining({
        items: [expect.objectContaining({
          type: "file",
          uploadRef: expect.stringMatching(/^upl_[a-f0-9]{32}$/),
          filename: "socket-attachment.txt",
          sizeBytes: 17,
        })],
      }),
    ]);
  });

  it("prefers command access file credentials over stale static environment credentials", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-command-shim-"));
    directories.push(directory);
    const accessFile = path.join(directory, "command-access.env");
    await writeFile(accessFile, [
      `PANDA_COMMAND_URL=${server.url}`,
      "PANDA_COMMAND_TOKEN=token-a",
      "",
    ].join("\n"));

    const {stdout} = await execFileAsync(shimPath, ["time", "now", "--json", "{}"], {
      env: {
        ...process.env,
        PANDA_COMMAND_ACCESS_FILE: accessFile,
        PANDA_COMMAND_URL: "http://127.0.0.1:1",
        PANDA_COMMAND_SOCKET: path.join(directory, "stale.sock"),
        PANDA_COMMAND_TOKEN: "stale-token",
      },
    });

    expect(JSON.parse(stdout)).toMatchObject({
      isoTimestamp: "2026-06-24T12:34:56.000Z",
    });
  });

  it("explains missing command transport for direct runner shells", async () => {
    await expect(execFileAsync(shimPath, ["time", "now"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Panda command execution needs agent command access."),
    });
  });

  it("sends the current working directory with command execution requests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-command-shim-"));
    directories.push(directory);
    const binDir = path.join(directory, "bin");
    const cwd = path.join(directory, "workspace", "nested");
    await mkdir(binDir, {recursive: true});
    await mkdir(cwd, {recursive: true});
    const curlPath = path.join(binDir, "curl");
    await writeFile(curlPath, `#!/usr/bin/env bash
set -euo pipefail
body=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --data)
      shift
      body="$1"
      ;;
  esac
  shift || true
done
printf '{"ok":true,"output":%s}\\n' "$body"
`);
    await chmod(curlPath, 0o755);

    await expect(execFileAsync(shimPath, [
      "watch",
      "schema",
      "--json",
      '{"sourceKind":"http_json","detectorKind":"json_pointer"}',
    ], {
      cwd,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PANDA_COMMAND_URL: "http://panda-core:8096",
        PANDA_COMMAND_TOKEN: "token-a",
      },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda watch command"),
    });
  });

  it("prints top-level command usage from the descriptor catalog without transport calls", async () => {
    const {stdout} = await execFileAsync(shimPath, ["--help"]);
    const descriptorExample = (commandName: string, exampleIndex = 0) => {
      const descriptor = DEFAULT_AGENT_COMMAND_DESCRIPTORS.find((candidate) => candidate.name === commandName);
      expect(descriptor, commandName).toBeDefined();
      const example = descriptor?.examples?.[exampleIndex]?.command;
      expect(example, `${commandName} example ${exampleIndex}`).toBeDefined();
      return example;
    };

    expect(stdout).toContain("panda <command> --help [--json]");
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("Examples:");
    for (const descriptor of DEFAULT_AGENT_COMMAND_DESCRIPTORS) {
      expect(stdout, descriptor.name).toContain(`  ${descriptor.usage}`);
    }
    for (const example of [
      descriptorExample("watch.create"),
      descriptorExample("skill.set", 1),
      descriptorExample("wiki.write.section"),
      descriptorExample("telegram.send", 1),
      descriptorExample("whisper.transcribe", 1),
    ]) {
      expect(stdout).toContain(`  ${example}`);
    }
    expect(stdout).not.toContain("panda watch disable --json @payload.json");
  });

  it("keeps top-level group help aligned with descriptor usage strings", async () => {
    const routeTree = buildCommandRouteTree({
      routes: DEFAULT_AGENT_COMMAND_SHIM_ROUTES,
      descriptors: DEFAULT_AGENT_COMMAND_DESCRIPTORS,
    });
    const usagesByGroup = new Map<string, string[]>();
    const directGeneratedGroups = new Set<string>();
    for (const route of routeTree.commands) {
      const group = route.argv[0];
      if (!group) {
        continue;
      }
      if (route.argv.length === 1) {
        directGeneratedGroups.add(group);
      }
      usagesByGroup.set(group, [...(usagesByGroup.get(group) ?? []), route.descriptor.usage]);
    }

    for (const [group, usages] of usagesByGroup) {
      if (usages.length === 1 && directGeneratedGroups.has(group)) {
        continue;
      }
      const {stdout} = await execFileAsync(shimPath, [group, "--help"]);
      for (const usage of usages) {
        expect(stdout, `${group}: ${usage}`).toContain(usage);
      }
    }
  });

  it("prints group help without transport calls", async () => {
    const watch = await execFileAsync(shimPath, ["watch", "--help"]);
    const schedule = await execFileAsync(shimPath, ["schedule", "--help"]);

    expect(watch.stdout).toContain("panda watch list [--status enabled|disabled|all]");
    expect(watch.stdout).toContain("panda watch show <watch-id>");
    expect(watch.stdout).toContain("panda watch runs <watch-id>");
    expect(watch.stdout).toContain("panda watch create --title <text|@file|@->");
    expect(watch.stdout).toContain("panda watch update <watch-id>");
    expect(watch.stdout).toContain("panda watch create --help");
    expect(watch.stdout).not.toContain("panda watch schema");
    expect(schedule.stdout).toContain("panda schedule list [--status active|disabled|completed|cancelled|all]");
    expect(schedule.stdout).toContain("panda schedule show <task-id>");
    expect(schedule.stdout).toContain("panda schedule runs <task-id>");
    expect(schedule.stdout).toContain("panda schedule create <title> (--at <iso>|--cron <expr> --timezone <tz>)");
    expect(schedule.stdout).toContain("panda schedule update <task-id>");
    expect(schedule.stdout).toContain("panda schedule create --help");
    const microApp = await execFileAsync(shimPath, ["micro-app", "--help"]);
    expect(microApp.stdout).toContain("panda micro-app view --help");
    expect(microApp.stdout).toContain("panda micro-app create --help");
    expect(microApp.stdout).toContain("panda micro-app link create --help");
    expect(microApp.stdout).toContain("panda micro-app list --help");
    const environment = await execFileAsync(shimPath, ["environment", "--help"]);
    expect(environment.stdout).toContain("panda environment create --help");
    expect(environment.stdout).toContain("panda environment list [--state <state>]");
    expect(environment.stdout).toContain("panda environment show <environment-id>");
    expect(environment.stdout).toContain("panda environment stop --help");
    expect(environment.stdout).toContain("panda environment stop <environment-id>");
    expect(environment.stdout).toContain("panda environment logs --help");
    expect(environment.stdout).toContain("panda environment logs <environment-id>");
    const skill = await execFileAsync(shimPath, ["skill", "--help"]);
    expect(skill.stdout).toContain("panda skill list --help");
    expect(skill.stdout).toContain("panda skill show <skill-key>");
    expect(skill.stdout).toContain("panda skill load --help");
    expect(skill.stdout).toContain("panda skill set <skill-key> --description");
    expect(skill.stdout).toContain("panda skill patch <skill-key> --description");
    expect(skill.stdout).toContain("panda skill delete <skill-key> --yes");
    await expect(execFileAsync(shimPath, ["agent", "--help"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda command"),
    });
    const image = await execFileAsync(shimPath, ["image", "--help"]);
    expect(image.stdout).toContain("panda image generate --help");
    expect(image.stdout).toContain("panda image generate --prompt <text|@file|@-> [--image <path>...] [--model <model>]");
    const whisper = await execFileAsync(shimPath, ["whisper", "--help"]);
    expect(whisper.stdout).toContain("panda whisper transcribe --help");
    expect(whisper.stdout).toContain("panda whisper transcribe <path>");
    expect(whisper.stdout).toContain("panda whisper translate --help");
    expect(whisper.stdout).toContain("panda whisper translate <path>");
    const postgres = await execFileAsync(shimPath, ["postgres", "--help"]);
    expect(postgres.stdout).toContain("panda postgres readonly query --help");
    expect(postgres.stdout).toContain("panda postgres readonly query (--sql <text|@file|@-> [--max-rows <n>]|--schema-help)");
    const brave = await execFileAsync(shimPath, ["brave", "--help"]);
    expect(brave.stdout).toContain("panda brave web search --help");
    expect(brave.stdout).toContain("panda brave news search --help");
    expect(brave.stdout).toContain("panda brave video search --help");
    expect(brave.stdout).toContain("panda brave image search --help");
    expect(brave.stdout).toContain("panda brave llm context --help");
    expect(brave.stdout).toContain("panda brave place search --help");
    expect(brave.stdout).toContain("panda brave web search <query> [-n|--count <n>] [--offset <n>]");
    expect(brave.stdout).toContain("[--extra-snippets] [--goggles <url-or-inline>]");
    expect(brave.stdout).toContain("panda brave llm context <query> [-n|--count <n>] [--max-tokens <n>] [--max-urls <n>]");
    expect(brave.stdout).toContain("panda brave place search [query] [--location <location>|--lat <number> --lon <number>] [-n|--count <n>] [--radius <meters>]");
    expect(brave.stdout).toContain("panda brave place poi --help");
    expect(brave.stdout).toContain("panda brave place description --help");
    const env = await execFileAsync(shimPath, ["env", "--help"]);
    expect(env.stdout).toContain("panda env list [--prefix <prefix>]");
    expect(env.stdout).toContain("panda env set <key> (--stdin|--from-file <path>)");
    const wiki = await execFileAsync(shimPath, ["wiki", "--help"]);
    expect(wiki.stdout).toContain("panda wiki overview --help");
    expect(wiki.stdout).toContain("panda wiki search --help");
    expect(wiki.stdout).toContain("panda wiki diff --help");
    expect(wiki.stdout).toContain("panda wiki write section --help");
    expect(wiki.stdout).toContain("panda wiki archive --help");
    expect(wiki.stdout).toContain("panda wiki restore --help");
    expect(wiki.stdout).toContain("panda wiki attach image --help");
    expect(wiki.stdout).toContain("panda wiki delete asset --help");
    const session = await execFileAsync(shimPath, ["session", "--help"]);
    expect(session.stdout).toContain("panda session prompt current read --help");
    const todo = await execFileAsync(shimPath, ["todo", "--help"]);
    expect(todo.stdout).not.toContain("panda todo update");
    expect(todo.stdout).toContain("panda todo add <text|@file|@->");
    expect(todo.stdout).toContain("panda todo list [--status all|open|pending|in_progress|blocked|done]");
    expect(todo.stdout).toContain("panda todo show <index>");
    expect(todo.stdout).toContain("panda todo done <index>");
    expect(todo.stdout).toContain("panda todo block <index>");
    expect(todo.stdout).toContain("panda todo clear --help");
    const vent = await execFileAsync(shimPath, ["vent", "--help"]);
    expect(vent.stdout).toContain("Detailed help is available only through the current agent command lease.");
    const subagent = await execFileAsync(shimPath, ["subagent", "--help"]);
    expect(subagent.stdout).toContain("panda subagent list --help");
    expect(subagent.stdout).toContain("panda subagent show <session-id>");
    expect(subagent.stdout).toContain("panda subagent spawn --help");
    expect(subagent.stdout).toContain("panda subagent spawn (<task|@file|@->|--prompt <text|@file|@->)");
    expect(subagent.stdout).toContain("panda subagent profile upsert --help");
    expect(subagent.stdout).toContain("panda subagent profile upsert <slug>");
    const telegram = await execFileAsync(shimPath, ["telegram", "--help"]);
    expect(telegram.stdout).toContain("panda telegram chat list --help");
    expect(telegram.stdout).toContain("panda telegram chat info --help");
    expect(telegram.stdout).toContain("panda telegram media fetch --help");
    expect(telegram.stdout).toContain("panda telegram send --help");
    expect(telegram.stdout).toContain("panda telegram sticker send --help");
    expect(telegram.stdout).toContain("panda telegram react --help");
    expect(telegram.stdout).toContain("panda telegram edit --help");
    expect(telegram.stdout).toContain("panda telegram delete --help");
    expect(telegram.stdout).toContain("panda telegram pin --help");
    expect(telegram.stdout).toContain("panda telegram unpin --help");
    const discord = await execFileAsync(shimPath, ["discord", "--help"]);
    expect(discord.stdout).toContain("panda discord channel list --help");
    expect(discord.stdout).toContain("panda discord history --help");
    expect(discord.stdout).toContain("panda discord send --help");
    const whatsapp = await execFileAsync(shimPath, ["whatsapp", "--help"]);
    expect(whatsapp.stdout).toContain("panda whatsapp chat list --help");
    expect(whatsapp.stdout).toContain("panda whatsapp history --help");
    expect(whatsapp.stdout).toContain("panda whatsapp send --help");
    const email = await execFileAsync(shimPath, ["email", "--help"]);
    expect(email.stdout).toContain("panda email account list --help");
    expect(email.stdout).toContain("panda email send --help");
    expect(email.stdout).toContain("panda email send --account <key>");
  });

  it("prints descriptor-backed command help with command access", async () => {
    const server = await startWatchServer();
    const execHelp = (argv: readonly string[]) => execFileAsync(shimPath, [...argv], {
      env: shimEnv(server),
    });
    const a2a = await execHelp(["a2a", "--help"]);
    const a2aSend = await execHelp(["a2a", "send", "--help"]);
    const a2aInspect = await execHelp(["a2a", "inspect", "--help"]);
    const a2aHistory = await execHelp(["a2a", "history", "--help"]);
    const webFetch = await execHelp(["web", "fetch", "--help"]);
    const watchList = await execHelp(["watch", "list", "--help"]);
    const watchShow = await execHelp(["watch", "show", "--help"]);
    const watchRuns = await execHelp(["watch", "runs", "--help"]);
    const watchDisable = await execHelp(["watch", "disable", "--help"]);
    const scheduleList = await execHelp(["schedule", "list", "--help"]);
    const scheduleShow = await execHelp(["schedule", "show", "--help"]);
    const scheduleRuns = await execHelp(["schedule", "runs", "--help"]);
    const scheduleCancel = await execHelp(["schedule", "cancel", "--help"]);
    const environmentCreate = await execHelp(["environment", "create", "--help"]);
    const environmentList = await execHelp(["environment", "list", "--help"]);
    const environmentShow = await execHelp(["environment", "show", "--help"]);
    const environmentStop = await execHelp(["environment", "stop", "--help"]);
    const environmentLogs = await execHelp(["environment", "logs", "--help"]);
    const imageGenerate = await execHelp(["image", "generate", "--help"]);
    const skillList = await execHelp(["skill", "list", "--help"]);
    const skillShow = await execHelp(["skill", "show", "--help"]);
    const skillLoad = await execHelp(["skill", "load", "--help"]);
    const skillSet = await execHelp(["skill", "set", "--help"]);
    const skillPatch = await execHelp(["skill", "patch", "--help"]);
    const skillDelete = await execHelp(["skill", "delete", "--help"]);
    const sessionPromptRead = await execHelp(["session", "prompt", "current", "read", "--help"]);
    const sessionPromptReadTrailingHelp = await execHelp(["session", "prompt", "current", "read", "brief", "--help"]);
    const sessionPromptSet = await execHelp(["session", "prompt", "current", "set", "--help"]);
    const sessionPromptTransform = await execHelp(["session", "prompt", "current", "transform", "--help"]);
    const todoClear = await execHelp(["todo", "clear", "--help"]);
    const vent = await execHelp(["vent", "--help"]);
    const telegramChatList = await execHelp(["telegram", "chat", "list", "--help"]);
    const telegramChatInfo = await execHelp(["telegram", "chat", "info", "--help"]);
    const telegramHistory = await execHelp(["telegram", "history", "--help"]);
    const telegramMediaFetch = await execHelp(["telegram", "media", "fetch", "--help"]);
    const telegramSend = await execHelp(["telegram", "send", "--help"]);
    const telegramStickerSend = await execHelp(["telegram", "sticker", "send", "--help"]);
    const telegramReact = await execHelp(["telegram", "react", "--help"]);
    const telegramEdit = await execHelp(["telegram", "edit", "--help"]);
    const telegramDelete = await execHelp(["telegram", "delete", "--help"]);
    const telegramPin = await execHelp(["telegram", "pin", "--help"]);
    const telegramUnpin = await execHelp(["telegram", "unpin", "--help"]);
    const discordChannelList = await execHelp(["discord", "channel", "list", "--help"]);
    const discordHistory = await execHelp(["discord", "history", "--help"]);
    const discordSend = await execHelp(["discord", "send", "--help"]);
    const whatsappChatList = await execHelp(["whatsapp", "chat", "list", "--help"]);
    const whatsappHistory = await execHelp(["whatsapp", "history", "--help"]);
    const whatsappSend = await execHelp(["whatsapp", "send", "--help"]);
    const envList = await execHelp(["env", "list", "--help"]);
    const envSet = await execHelp(["env", "set", "--help"]);
    const postgresReadonlyQuery = await execHelp(["postgres", "readonly", "query", "--help"]);
    const whisperTranslate = await execHelp(["whisper", "translate", "--help"]);
    const emailAccountList = await execHelp(["email", "account", "list", "--help"]);
    const emailSend = await execHelp(["email", "send", "--help"]);
    const wikiOverview = await execHelp(["wiki", "overview", "--help"]);
    const wikiRead = await execHelp(["wiki", "read", "--help"]);
    const wikiSearch = await execHelp(["wiki", "search", "--help"]);
    const wikiList = await execHelp(["wiki", "list", "--help"]);
    const wikiWritePage = await execHelp(["wiki", "write", "page", "--help"]);
    const wikiWriteSection = await execHelp(["wiki", "write", "section", "--help"]);
    const wikiMove = await execHelp(["wiki", "move", "--help"]);
    const wikiArchive = await execHelp(["wiki", "archive", "--help"]);
    const wikiRestore = await execHelp(["wiki", "restore", "--help"]);
    const wikiAttachImage = await execHelp(["wiki", "attach", "image", "--help"]);
    const wikiFetchAsset = await execHelp(["wiki", "fetch", "asset", "--help"]);
    const wikiDeleteAsset = await execHelp(["wiki", "delete", "asset", "--help"]);

    expect(a2a.stdout).toContain("panda a2a send --help");
    expect(a2a.stdout).toContain("panda a2a inspect <delivery-id>");
    expect(a2a.stdout).toContain("panda a2a send (--to-session <session-id>|--to-agent <agent-key>) (--text <text|@file|@->|--stdin|--file <path>)...");
    expect(a2a.stdout).toContain("panda a2a history [--peer-session <session-id>] [--direction inbound|outbound|all] [--limit <n>]");
    expect(a2aSend.stdout).toContain("Send an A2A message to another Panda session.");
    expect(a2aSend.stdout).toContain("panda a2a send (--to-session <session-id>|--to-agent <agent-key>) (--text <text|@file|@->|--stdin|--file <path>)...");
    expect(a2aSend.stdout).toContain("--stdin");
    expect(a2aSend.stdout).toContain("--file <path>");
    expect(a2aSend.stdout).not.toContain("--image");
    expect(a2aInspect.stdout).toContain("panda a2a inspect <delivery-id>");
    expect(a2aInspect.stdout).toContain("delivery-id");
    expect(a2aHistory.stdout).toContain("panda a2a history [--peer-session <session-id>] [--direction inbound|outbound|all] [--limit <n>]");
    expect(a2aHistory.stdout).toContain("--direction <inbound|outbound|all>");
    expect(webFetch.stdout).toContain("Fetch a bounded public resource into model-ready content or an artifact.");
    expect(webFetch.stdout).toContain("panda web fetch <url> [--chunk-chars <n>] [--format markdown|text] [--save <path>] [--include-links|--no-links]");
    expect(webFetch.stdout).toContain("--save <path>");
    expect(watchList.stdout).toContain("panda watch list [--status enabled|disabled|all] [--limit <n>]");
    expect(watchList.stdout).toContain("--status <enabled|disabled|all>");
    expect(watchShow.stdout).toContain("panda watch show <watch-id>");
    expect(watchRuns.stdout).toContain("panda watch runs <watch-id> [--limit <n>]");
    expect(watchRuns.stdout).toContain("--limit <n>");
    const watchCreate = await execHelp(["watch", "create", "--help"]);
    const watchUpdate = await execHelp(["watch", "update", "--help"]);
    expect(watchCreate.stdout).toContain("panda watch create --title <text|@file|@-> --every <minutes> (--url <url> --value-path <path> --percent-change <n> [--label <text|@file|@->]|--source-json <json|@file|@-> --detector-json <json|@file|@-> [--source-kind <kind>] [--detector-kind <kind>]) [--disabled]");
    expect(watchCreate.stdout).toContain("--url <url>");
    expect(watchCreate.stdout).toContain("--value-path <path>");
    expect(watchCreate.stdout).toContain("--percent-change <n>");
    expect(watchCreate.stdout).toContain("--source-json <json|@file|@->");
    expect(watchCreate.stdout).toContain("--detector-json <json|@file|@->");
    expect(watchCreate.stdout).toContain("--source-kind <kind>");
    expect(watchCreate.stdout).toContain("--detector-kind <kind>");
    expect(watchUpdate.stdout).toContain("panda watch update <watch-id>");
    expect(watchUpdate.stdout).toContain("--url <url>");
    expect(watchUpdate.stdout).toContain("--value-path <path>");
    expect(watchUpdate.stdout).toContain("--percent-change <n>");
    expect(watchUpdate.stdout).toContain("--source-kind <kind>");
    expect(watchUpdate.stdout).toContain("--detector-kind <kind>");
    expect(watchUpdate.stdout).toContain("--enable");
    expect(watchUpdate.stdout).toContain("--disable");
    expect(watchDisable.stdout).toContain("panda watch disable <watch-id>");
    expect(watchDisable.stdout).toContain("Arguments:");
    expect(scheduleList.stdout).toContain("panda schedule list [--status active|disabled|completed|cancelled|all] [--limit <n>]");
    expect(scheduleList.stdout).toContain("--status <active|disabled|completed|cancelled|all>");
    expect(scheduleShow.stdout).toContain("panda schedule show <task-id>");
    expect(scheduleRuns.stdout).toContain("panda schedule runs <task-id> [--limit <n>]");
    expect(scheduleRuns.stdout).toContain("--limit <n>");
    const scheduleCreate = await execHelp(["schedule", "create", "--help"]);
    const scheduleUpdate = await execHelp(["schedule", "update", "--help"]);
    expect(scheduleCreate.stdout).toContain("panda schedule create <title> (--at <iso>|--cron <expr> --timezone <tz>) --instruction <text|@file|@-> [--disabled]");
    expect(scheduleCreate.stdout).toContain("--cron <expr>");
    expect(scheduleCreate.stdout).toContain("--disabled");
    expect(scheduleUpdate.stdout).toContain("panda schedule update <task-id>");
    expect(scheduleUpdate.stdout).toContain("--enable");
    expect(scheduleUpdate.stdout).toContain("--disable");
    expect(scheduleCancel.stdout).toContain("panda schedule cancel <task-id>");
    expect(scheduleCancel.stdout).toContain("--reason <text|@file|@->");
    expect(environmentCreate.stdout).toContain("panda environment create [--label <text|@file|@->] [--ttl <hours|Nh>] [--setup-script <path>]");
    expect(environmentCreate.stdout).toContain("--setup-script <path>");
    expect(environmentList.stdout).toContain("panda environment list [--state <state>]");
    expect(environmentList.stdout).toContain("--state <state>");
    expect(environmentShow.stdout).toContain("panda environment show <environment-id>");
    expect(environmentStop.stdout).toContain("panda environment stop <environment-id>");
    expect(environmentStop.stdout).toContain("Arguments:");
    expect(environmentLogs.stdout).toContain("panda environment logs <environment-id>");
    expect(environmentLogs.stdout).toContain("--role <control|workspace|all>");
    expect(environmentLogs.stdout).toContain("--tail <n>");
    expect(imageGenerate.stdout).toContain("panda image generate --prompt <text|@file|@-> [--image <path>...] [--model <model>]");
    expect(imageGenerate.stdout).toContain("--format <png|jpeg|webp>");
    expect(imageGenerate.stdout).toContain("--count <n>");
    expect(skillList.stdout).toContain("panda skill list [--tag <tag>...] [--output keys|json|table]");
    expect(skillList.stdout).toContain("--tag <tag>");
    expect(skillShow.stdout).toContain("panda skill show <skill-key>");
    expect(skillLoad.stdout).toContain("panda skill load <skill-key>");
    expect(skillLoad.stdout).toContain("Arguments:");
    expect(skillSet.stdout).toContain("panda skill set <skill-key> --description <text|@file|@-> --content <text|@file|@->");
    expect(skillSet.stdout).toContain("--tag <tag>");
    expect(skillPatch.stdout).toContain("panda skill patch <skill-key> --description <text|@file|@->");
    expect(skillDelete.stdout).toContain("panda skill delete <skill-key> --yes");
    expect(skillDelete.stdout).toContain("--yes");
    expect(sessionPromptRead.stdout).toContain("panda session prompt current read <brief|memory|heartbeat> [--raw]");
    expect(sessionPromptRead.stdout).toContain("Arguments:");
    expect(sessionPromptReadTrailingHelp.stdout).toContain("panda session prompt current read <brief|memory|heartbeat> [--raw]");
    expect(sessionPromptSet.stdout).toContain("panda session prompt current set <brief|memory|heartbeat> --content <text|@file|@->");
    expect(sessionPromptSet.stdout).toContain("--content <text|@file|@->");
    expect(sessionPromptTransform.stdout).toContain("panda session prompt current transform <brief|memory|heartbeat> (--append <text|@file|@->|--prepend <text|@file|@->|--replace <pattern> --with <text|@file|@->|--expression <expr|@file|@->)");
    expect(sessionPromptTransform.stdout).toContain("--prepend <text|@file|@->");
    expect(sessionPromptTransform.stdout).toContain("--expression <expr|@file|@->");
    const todoAdd = await execHelp(["todo", "add", "--help"]);
    const todoList = await execHelp(["todo", "list", "--help"]);
    const todoShow = await execHelp(["todo", "show", "--help"]);
    const todoDone = await execHelp(["todo", "done", "--help"]);
    const todoBlock = await execHelp(["todo", "block", "--help"]);
    const subagentList = await execHelp(["subagent", "list", "--help"]);
    const subagentShow = await execHelp(["subagent", "show", "--help"]);
    const subagentSpawn = await execHelp(["subagent", "spawn", "--help"]);
    const subagentProfileUpsert = await execHelp(["subagent", "profile", "upsert", "--help"]);
    expect(todoAdd.stdout).toContain("panda todo add <text|@file|@-> [--status pending|in_progress|blocked]");
    expect(todoList.stdout).toContain("panda todo list [--status all|open|pending|in_progress|blocked|done]");
    expect(todoShow.stdout).toContain("panda todo show <index>");
    expect(todoDone.stdout).toContain("panda todo done <index>");
    expect(todoBlock.stdout).toContain("panda todo block <index>");
    expect(todoClear.stdout).toContain("Clear the current session todo list.");
    expect(todoClear.stdout).toContain("panda todo clear");
    expect(subagentList.stdout).toContain("panda subagent list [--run-status running|completed|failed|all] [--limit <n>]");
    expect(subagentShow.stdout).toContain("panda subagent show <session-id>");
    expect(vent.stdout).toContain("Send a short private vent note to Panda Trace.");
    expect(vent.stdout).toContain("panda vent (--message <text|@file|@->|--stdin)");
    expect(vent.stdout).toContain("--stdin");
    expect(telegramChatList.stdout).toContain("panda telegram chat list [--connector <key>]");
    expect(telegramChatList.stdout).toContain("List Telegram chats bound to the current session.");
    expect(telegramChatInfo.stdout).toContain("panda telegram chat info <conversation-id> [--connector <key>]");
    expect(telegramChatInfo.stdout).toContain("Show one Telegram chat binding");
    expect(telegramHistory.stdout).toContain("panda telegram history --chat <conversation-id>");
    expect(telegramHistory.stdout).toContain("--direction <inbound|outbound|all>");
    expect(telegramMediaFetch.stdout).toContain("panda telegram media fetch <media-id> --chat <conversation-id>");
    expect(telegramMediaFetch.stdout).toContain("--save <path>");
    expect(telegramMediaFetch.stdout).toContain("--overwrite");
    expect(telegramSend.stdout).toContain("panda telegram send --chat <conversation-id> --connector <key> (--text <text|@file|@->|--stdin|--image <path>|--file <path>)...");
    expect(telegramSend.stdout).toContain("--stdin");
    expect(telegramSend.stdout).toContain("--image <path>");
    expect(telegramSend.stdout).toContain("--reply-to-message-id <message-id>");
    expect(telegramStickerSend.stdout).toContain("panda telegram sticker send --chat <conversation-id> --connector <key> (--file <path>|--file-id <id>)");
    expect(telegramStickerSend.stdout).toContain("--file-id <id>");
    expect(telegramReact.stdout).toContain("panda telegram react <message-id> (--emoji <emoji>|--remove)");
    expect(telegramReact.stdout).toContain("--remove");
    expect(telegramEdit.stdout).toContain("panda telegram edit <message-id> (--text <text|@file|@->|--stdin)");
    expect(telegramEdit.stdout).toContain("--connector <key>");
    expect(telegramDelete.stdout).toContain("panda telegram delete <message-id> --chat <conversation-id> --connector <key>");
    expect(telegramPin.stdout).toContain("panda telegram pin <message-id> --chat <conversation-id> --connector <key> [--silent]");
    expect(telegramPin.stdout).toContain("--silent");
    expect(telegramUnpin.stdout).toContain("panda telegram unpin <message-id> --chat <conversation-id> --connector <key>");
    expect(discordChannelList.stdout).toContain("panda discord channel list [--connector <key>]");
    expect(discordChannelList.stdout).toContain("List Discord channels bound to the current session.");
    expect(discordHistory.stdout).toContain("panda discord history --channel <channel-id>");
    expect(discordHistory.stdout).toContain("--direction <inbound|outbound|all>");
    expect(discordSend.stdout).toContain("panda discord send --channel <channel-id> --connector <key> [--thread <thread-id>] [--guild <guild-id>] (--text <text|@file|@->|--stdin|--image <path>|--file <path>)...");
    expect(discordSend.stdout).toContain("--stdin");
    expect(discordSend.stdout).toContain("--thread <thread-id>");
    expect(discordSend.stdout).toContain("--reply-to-message-id <message-id>");
    expect(whatsappChatList.stdout).toContain("panda whatsapp chat list [--connector <key>]");
    expect(whatsappChatList.stdout).toContain("List WhatsApp chats bound to the current session.");
    expect(whatsappHistory.stdout).toContain("panda whatsapp history --chat <jid-or-phone>");
    expect(whatsappHistory.stdout).toContain("--direction <inbound|outbound|all>");
    expect(whatsappSend.stdout).toContain("panda whatsapp send --chat <jid-or-phone> --connector <key> (--text <text|@file|@->|--stdin|--image <path>|--file <path>)...");
    expect(whatsappSend.stdout).toContain("--stdin");
    expect(whatsappSend.stdout).toContain("--image <path>");
    expect(envList.stdout).toContain("panda env list [--prefix <prefix>]");
    expect(envList.stdout).toContain("--prefix <prefix>");
    expect(envList.stdout).not.toContain("--from-file");
    expect(envSet.stdout).toContain("panda env set <key> (--stdin|--from-file <path>)");
    expect(envSet.stdout).toContain("--from-file <path>");
    expect(postgresReadonlyQuery.stdout).toContain("panda postgres readonly query (--sql <text|@file|@-> [--max-rows <n>]|--schema-help)");
    expect(postgresReadonlyQuery.stdout).toContain("--sql <text|@file|@->");
    expect(postgresReadonlyQuery.stdout).toContain("--max-rows <n>");
    expect(postgresReadonlyQuery.stdout).toContain("--schema-help");
    const whisperTranscribe = await execHelp(["whisper", "transcribe", "--help"]);
    expect(whisperTranscribe.stdout).toContain("panda whisper transcribe <path> [--language <code>] [--prompt <text|@file|@->]");
    expect(whisperTranscribe.stdout).toContain("--prompt <text|@file|@->");
    expect(whisperTranslate.stdout).toContain("panda whisper translate <path> [--prompt <text|@file|@->]");
    expect(whisperTranslate.stdout).toContain("--prompt <text|@file|@->");
    expect(whisperTranslate.stdout).not.toContain("--language");
    expect(emailAccountList.stdout).toContain("panda email account list [--sendable-only]");
    expect(emailAccountList.stdout).toContain("--sendable-only");
    expect(emailSend.stdout).toContain("panda email send --account <key> (--to <address>... --subject <text|@file|@->|--reply-to-email-id <email-id> [--reply-mode sender|all]) --text <text|@file|@->");
    expect(emailSend.stdout).toContain("--reply-to-email-id <email-id>");
    expect(emailSend.stdout).toContain("--html <text|@file|@->");
    expect(emailSend.stdout).toContain("--file <path>");
    expect(wikiOverview.stdout).toContain("panda wiki overview [--locale <locale>]");
    expect(wikiRead.stdout).toContain("panda wiki read <path> [--locale <locale>] [--format json|markdown]");
    expect(wikiRead.stdout).toContain("relative to the current agent namespace");
    expect(wikiRead.stdout).toContain("panda wiki read profile");
    expect(wikiRead.stdout).not.toContain("panda wiki read agents/panda/profile");
    expect(wikiSearch.stdout).toContain("panda wiki search <query>");
    expect(wikiList.stdout).toContain("panda wiki list [path]");
    expect(wikiList.stdout).toContain("--include-archived");
    expect(wikiWritePage.stdout).toContain("panda wiki write page <path> --content <text|@file|@-> [--title <text|@file|@->] [--description <text|@file|@->] [--tag <tag>...]");
    expect(wikiWritePage.stdout).toContain("--content <text|@file|@->");
    expect(wikiWritePage.stdout).toContain("--title <text|@file|@->");
    expect(wikiWriteSection.stdout).toContain("panda wiki write section <path> <section> --content <text|@file|@-> [--title <text|@file|@->] [--create|--no-create]");
    expect(wikiWriteSection.stdout).toContain("--content <text|@file|@->");
    expect(wikiWriteSection.stdout).toContain("--title <text|@file|@->");
    expect(wikiMove.stdout).toContain("panda wiki move <path> <destination-path>");
    expect(wikiMove.stdout).toContain("--rewrite-links");
    expect(wikiMove.stdout).toContain("--locale <locale>");
    expect(wikiArchive.stdout).toContain("panda wiki archive <path>");
    expect(wikiArchive.stdout).toContain("--locale <locale>");
    expect(wikiArchive.stdout).toContain("--base-updated-at <timestamp>");
    expect(wikiRestore.stdout).toContain("panda wiki restore <archived-path> <destination-path>");
    expect(wikiRestore.stdout).toContain("--locale <locale>");
    expect(wikiRestore.stdout).toContain("--base-updated-at <timestamp>");
    expect(wikiFetchAsset.stdout).toContain("panda wiki fetch asset <asset-path>");
    expect(wikiAttachImage.stdout).toContain("panda wiki attach image <path> <section> --slot <slot> --source <image-path> --alt <text|@file|@-> [--caption <text|@file|@->]");
    expect(wikiAttachImage.stdout).toContain("--source <image-path>");
    expect(wikiAttachImage.stdout).toContain("--alt <text|@file|@->");
    expect(wikiDeleteAsset.stdout).toContain("panda wiki delete asset <asset-path> --yes");
    expect(wikiDeleteAsset.stdout).toContain("--yes");
    expect(subagentSpawn.stdout).toContain("panda subagent spawn (<task|@file|@->|--prompt <text|@file|@->) [--profile <slug>|--tool-group <group>...]");
    expect(subagentSpawn.stdout).toContain("--prompt <text|@file|@->");
    expect(subagentSpawn.stdout).toContain("--environment <environment-id>");
    expect(subagentSpawn.stdout).toContain("--isolated");
    expect(subagentSpawn.stdout).toContain("--agent-workspace");
    expect(subagentSpawn.stdout).toContain("--tool-group <group>");
    expect(subagentSpawn.stdout).toContain("--credential <env-key>");
    expect(subagentProfileUpsert.stdout).toContain("panda subagent profile upsert <slug> --description <text|@file|@-> --prompt <text|@file|@-> --tool-group <group>...");
    expect(subagentProfileUpsert.stdout).toContain("--tool-group <group>");
    expect(subagentProfileUpsert.stdout).toContain("--thinking <low|medium|high|xhigh>");
    expect(subagentProfileUpsert.stdout).toContain("--enabled");
    expect(subagentProfileUpsert.stdout).toContain("--disabled");
  });

  it("rejects removed watch.schema compatibility command", async () => {
    await expect(execFileAsync(shimPath, [
      "watch",
      "schema",
      "--json",
      '{"sourceKind":"http_json","detectorKind":"percent_change"}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda watch command"),
    });
  });

  it("executes watch.create JSON payloads through the transport", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-command-shim-"));
    directories.push(directory);
    const payloadPath = path.join(directory, "watch.json");
    await writeFile(payloadPath, JSON.stringify({
      title: "BTC",
      intervalMinutes: 5,
      source: {
        kind: "http_json",
        url: "https://example.com",
        result: {
          observation: "scalar",
          valuePath: "price",
        },
      },
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    }), "utf8");

    const {stdout} = await execFileAsync(shimPath, ["watch", "create", "--json", `@${payloadPath}`], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      watchId: "watch-1",
    });
  });

  it("executes watch.create through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-watch-shim-"));
    directories.push(directory);
    const titlePath = path.join(directory, "title.txt");
    const sourcePath = path.join(directory, "source.json");
    await writeFile(titlePath, "BTC", "utf8");
    await writeFile(sourcePath, JSON.stringify({
      kind: "http_json",
      url: "https://example.com",
      result: {
        observation: "scalar",
        valuePath: "price",
      },
    }), "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "watch",
      "create",
      "--title",
      `@${titlePath}`,
      "--every",
      "5",
      "--source-kind",
      "http_json",
      "--source-json",
      `@${sourcePath}`,
      "--detector-kind",
      "percent_change",
      "--detector-json",
      '{"kind":"percent_change","percent":10}',
      "--disabled",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      watchId: "watch-1",
    });
  });

  it("executes watch.create through native HTTP JSON scalar shortcut args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "watch",
      "create",
      "--title",
      "BTC",
      "--every",
      "5",
      "--url",
      "https://api.example.com/btc-price",
      "--value-path",
      "price_usd",
      "--label",
      "BTC/USD",
      "--percent-change",
      "10",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      watchId: "watch-1",
    });
  });

  it("rejects incomplete watch.create shortcut args before transport", async () => {
    await expect(execFileAsync(shimPath, [
      "watch",
      "create",
      "--title",
      "BTC",
      "--every",
      "5",
      "--url",
      "https://api.example.com/btc-price",
      "--percent-change",
      "10",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda watch create shortcut requires --value-path <path>."),
    });
  });

  it("executes watch.update and watch.disable JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const update = await execFileAsync(shimPath, [
      "watch",
      "update",
      "--json",
      '{"watchId":"watch-1","title":"Updated"}',
    ], {
      env: shimEnv(server),
    });
    const disable = await execFileAsync(shimPath, [
      "watch",
      "disable",
      "--json",
      '{"watchId":"watch-1","reason":"done"}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(update.stdout)).toEqual({
      watchId: "watch-1",
      updated: true,
    });
    expect(JSON.parse(disable.stdout)).toEqual({
      watchId: "watch-1",
      disabled: true,
    });
  });

  it("executes watch.update through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "watch",
      "update",
      "watch-1",
      "--title",
      "Updated BTC",
      "--every",
      "10",
      "--source-kind",
      "http_json",
      "--source-json",
      '{"kind":"http_json","url":"https://example.com","result":{"observation":"scalar","valuePath":"price"}}',
      "--detector-kind",
      "percent_change",
      "--detector-json",
      '{"kind":"percent_change","percent":15}',
      "--disable",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      watchId: "watch-1",
      updated: true,
    });
  });

  it("executes watch.update through native HTTP JSON scalar shortcut args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "watch",
      "update",
      "watch-1",
      "--url",
      "https://api.example.com/btc-price",
      "--value-path",
      "price_usd",
      "--label",
      "BTC/USD",
      "--percent-change",
      "15",
      "--enable",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      watchId: "watch-1",
      updated: true,
    });
  });

  it("executes watch.update through native percent-change shortcut args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "watch",
      "update",
      "watch-1",
      "--percent-change",
      "15",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      watchId: "watch-1",
      updated: true,
    });
  });

  it("rejects incomplete watch.update shortcut args before transport", async () => {
    await expect(execFileAsync(shimPath, [
      "watch",
      "update",
      "watch-1",
      "--url",
      "https://api.example.com/btc-price",
      "--percent-change",
      "15",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda watch update shortcut source requires --value-path <path>."),
    });
  });

  it("rejects mismatched watch native kind assertions before transport", async () => {
    await expect(execFileAsync(shimPath, [
      "watch",
      "create",
      "--title",
      "BTC",
      "--every",
      "5",
      "--source-kind",
      "rss_feed",
      "--source-json",
      '{"kind":"http_json","url":"https://example.com","result":{"observation":"scalar","valuePath":"price"}}',
      "--detector-json",
      '{"kind":"percent_change","percent":10}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("source JSON kind 'http_json' does not match --source-kind 'rss_feed'."),
    });
  });

  it("executes watch.list, watch.show, and watch.runs through native args", async () => {
    const server = await startWatchServer();

    const list = await execFileAsync(shimPath, [
      "watch",
      "list",
      "--status",
      "all",
      "--limit",
      "10",
    ], {
      env: shimEnv(server),
    });
    const disabledList = await execFileAsync(shimPath, [
      "watch",
      "list",
      "--status",
      "disabled",
    ], {
      env: shimEnv(server),
    });
    const show = await execFileAsync(shimPath, [
      "watch",
      "show",
      "watch-1",
    ], {
      env: shimEnv(server),
    });
    const runs = await execFileAsync(shimPath, [
      "watch",
      "runs",
      "watch-1",
      "--limit",
      "5",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(list.stdout)).toMatchObject({
      operation: "list",
      count: 1,
      watches: [{
        watchId: "watch-1",
        title: "BTC",
        enabled: true,
        sourceKind: "http_json",
        detectorKind: "percent_change",
      }],
    });
    expect(JSON.parse(disabledList.stdout)).toMatchObject({
      operation: "list",
      watches: [{
        watchId: "watch-1",
        enabled: false,
        disabledReason: "operator pause",
      }],
    });
    expect(JSON.stringify(JSON.parse(disabledList.stdout))).not.toContain("lastError");
    expect(JSON.parse(show.stdout)).toMatchObject({
      operation: "show",
      watchId: "watch-1",
      title: "BTC",
      source: {
        kind: "http_json",
        url: "https://example.com",
      },
      detector: {
        kind: "percent_change",
      },
    });
    expect(JSON.parse(runs.stdout)).toMatchObject({
      operation: "runs",
      watchId: "watch-1",
      count: 1,
      runs: [{
        runId: "run-1",
        status: "changed",
        event: {
          eventId: "event-1",
          summary: "BTC moved by 12%.",
        },
      }],
    });
  });

  it("executes watch.disable through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "watch",
      "disable",
      "watch-1",
      "--reason",
      "done",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      watchId: "watch-1",
      disabled: true,
    });
  });

  it("executes schedule.create JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "schedule",
      "create",
      "--json",
      '{"title":"check CI","instruction":"Check CI status","schedule":{"kind":"once","runAt":"2026-05-25T09:00:00+02:00"}}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      taskId: "task-1",
    });
  });

  it("executes schedule.create through native once and recurring args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-schedule-shim-"));
    directories.push(directory);
    const instructionPath = path.join(directory, "instruction.md");
    await writeFile(instructionPath, "Check CI status", "utf8");

    const once = await execFileAsync(shimPath, [
      "schedule",
      "create",
      "check CI",
      "--at",
      "2026-05-25T09:00:00+02:00",
      "--instruction",
      `@${instructionPath}`,
      "--disabled",
    ], {
      env: shimEnv(server),
    });
    const recurring = await execFileAsync(shimPath, [
      "schedule",
      "create",
      "daily report",
      "--cron",
      "0 9 * * *",
      "--timezone",
      "Europe/Bratislava",
      "--instruction",
      "Send the report.",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(once.stdout)).toEqual({
      taskId: "task-1",
    });
    expect(JSON.parse(recurring.stdout)).toEqual({
      taskId: "task-1",
    });
  });

  it("executes schedule.update through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "schedule",
      "update",
      "task-1",
      "--title",
      "review CI",
      "--cron",
      "*/30 * * * *",
      "--timezone",
      "Europe/Bratislava",
      "--instruction",
      "Review the latest CI state.",
      "--disable",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      taskId: "task-1",
      updated: true,
    });
  });

  it("rejects invalid schedule native flag combinations before transport", async () => {
    await expect(execFileAsync(shimPath, [
      "schedule",
      "create",
      "bad schedule",
      "--at",
      "2026-05-25T09:00:00+02:00",
      "--cron",
      "0 9 * * *",
      "--timezone",
      "Europe/Bratislava",
      "--instruction",
      "do it",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda schedule create accepts either --at or --cron, not both."),
    });
  });

  it("executes schedule.cancel through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "schedule",
      "cancel",
      "task-1",
      "--reason",
      "obsolete",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      taskId: "task-1",
      cancelled: true,
    });
  });

  it("executes schedule.list, schedule.show, and schedule.runs through native args", async () => {
    const server = await startWatchServer();

    const list = await execFileAsync(shimPath, [
      "schedule",
      "list",
      "--status",
      "all",
      "--limit",
      "10",
    ], {
      env: shimEnv(server),
    });
    const show = await execFileAsync(shimPath, [
      "schedule",
      "show",
      "task-1",
    ], {
      env: shimEnv(server),
    });
    const runs = await execFileAsync(shimPath, [
      "schedule",
      "runs",
      "task-1",
      "--limit",
      "5",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(list.stdout)).toMatchObject({
      operation: "list",
      count: 1,
      tasks: [{
        taskId: "task-1",
        title: "check CI",
        enabled: true,
        schedule: {
          kind: "once",
        },
      }],
    });
    expect(JSON.parse(show.stdout)).toMatchObject({
      operation: "show",
      taskId: "task-1",
      title: "check CI",
      instruction: "Check CI status",
      schedule: {
        kind: "once",
      },
    });
    expect(JSON.parse(runs.stdout)).toMatchObject({
      operation: "runs",
      taskId: "task-1",
      count: 1,
      runs: [{
        runId: "task-run-1",
        status: "succeeded",
        threadRunId: "thread-run-1",
      }],
    });
  });

  it("executes micro-app.view JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "micro-app",
      "view",
      "--json",
      '{"appSlug":"food-tracker","viewName":"today_summary"}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      appSlug: "food-tracker",
      viewName: "today_summary",
      items: [{
        agentKey: "panda",
        appSlug: "food-tracker",
        viewName: "today_summary",
        value: 1,
      }],
    });
  });

  it("executes micro-app view through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-command-app-view-"));
    directories.push(directory);
    const paramsPath = path.join(directory, "params.json");
    await writeFile(paramsPath, JSON.stringify({
      meal: "lunch",
      count: 2,
    }));

    const {stdout} = await execFileAsync(shimPath, [
      "micro-app",
      "view",
      "food-tracker",
      "today_summary",
      "--params",
      `@${paramsPath}`,
      "--param",
      "day=2026-06-25",
      "--page-size",
      "20",
      "--offset",
      "5",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      appSlug: "food-tracker",
      viewName: "today_summary",
      items: [{
        agentKey: "panda",
        appSlug: "food-tracker",
        viewName: "today_summary",
        params: {
          meal: "lunch",
          count: 2,
          day: "2026-06-25",
        },
        pageSize: 20,
        offset: 5,
        value: 1,
      }],
    });
  });

  it("executes micro-app action through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "micro-app",
      "action",
      "food-tracker",
      "delete_entry",
      "--input",
      '{"id":1,"reason":"duplicate"}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      appSlug: "food-tracker",
      actionName: "delete_entry",
      mode: "native",
      changes: 1,
      input: {
        id: 1,
        reason: "duplicate",
      },
      wakeRequested: false,
    });
  });

  it("executes micro-app check and list through native args", async () => {
    const server = await startWatchServer();

    const check = await execFileAsync(shimPath, [
      "micro-app",
      "check",
      "food-tracker",
    ], {
      env: shimEnv(server),
    });
    const list = await execFileAsync(shimPath, [
      "micro-app",
      "list",
      "food-tracker",
      "--full",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(check.stdout)).toMatchObject({
      ok: true,
      apps: [{
        appSlug: "food-tracker",
        ok: true,
      }],
    });
    expect(JSON.parse(list.stdout)).toMatchObject({
      detail: "full",
      apps: [{
        slug: "food-tracker",
        views: [{
          name: "today_summary",
        }],
      }],
      brokenApps: [],
    });
  });

  it("executes micro-app create through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-command-app-"));
    directories.push(directory);
    const namePath = path.join(directory, "name.txt");
    const schemaPath = path.join(directory, "schema.sql");
    await writeFile(namePath, "Food Tracker");
    await writeFile(schemaPath, "CREATE TABLE entries (id INTEGER PRIMARY KEY);");

    const {stdout} = await execFileAsync(shimPath, [
      "micro-app",
      "create",
      "food-tracker",
      "--name",
      `@${namePath}`,
      "--description",
      "Track meals.",
      "--identity-scoped",
      "--schema",
      `@${schemaPath}`,
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      agentKey: "panda",
      slug: "food-tracker",
      name: "Food Tracker",
      description: "Track meals.",
      identityScoped: true,
      schemaApplied: true,
    });
  });

  it("executes micro-app link create through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "micro-app",
      "link",
      "create",
      "food-tracker",
      "--expires",
      "10m",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      agentKey: "panda",
      appSlug: "food-tracker",
      openUrl: "http://localhost:3000/apps/open?token=pal_launch-token",
      expiresAt: "2026-05-13T12:00:00.000Z",
    });
  });

  it("rejects removed app compatibility alias", async () => {
    await expect(execFileAsync(shimPath, [
      "app",
      "check",
      "food-tracker",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda command"),
    });
  });

  it("executes environment.create JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "environment",
      "create",
      "--json",
      '{"label":"review"}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      status: "created",
      environmentId: "environment:session-main:shim",
      environmentState: "ready",
      runnerCwd: "/workspace",
    });
  });

  it("executes environment.create through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-environment-shim-"));
    directories.push(directory);
    const labelPath = path.join(directory, "label.txt");
    const setupPath = path.join(directory, "setup.sh");
    await writeFile(labelPath, "review env", "utf8");
    await writeFile(setupPath, "#!/usr/bin/env bash\necho ready\n", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "environment",
      "create",
      "--label",
      `@${labelPath}`,
      "--ttl",
      "2h",
      "--setup-script",
      setupPath,
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      status: "created",
      environmentId: "environment:session-main:shim",
      environmentState: "ready",
      runnerCwd: "/workspace",
      expiresAt: 7_200_000,
      setup: {
        status: "succeeded",
        requestedPath: setupPath,
      },
    });
  });

  it("executes environment.list and environment.show through native args", async () => {
    const server = await startWatchServer();

    const list = await execFileAsync(shimPath, [
      "environment",
      "list",
      "--state",
      "ready",
    ], {
      env: shimEnv(server),
    });
    const show = await execFileAsync(shimPath, [
      "environment",
      "show",
      "environment:session-main:shim",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(list.stdout)).toMatchObject({
      operation: "list",
      count: 1,
      environments: [{
        environmentId: "environment:session-main:shim",
        environmentState: "ready",
        runnerCwd: "/workspace",
      }],
    });
    expect(JSON.parse(show.stdout)).toMatchObject({
      operation: "show",
      environmentId: "environment:session-main:shim",
      environmentState: "ready",
      runnerCwd: "/workspace",
    });
  });

  it("executes environment.stop through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "environment",
      "stop",
      "environment:session-main:shim",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      status: "stopped",
      environmentId: "environment:session-main:shim",
      environmentState: "stopped",
      runnerCwd: "/workspace",
    });
  });

  it("executes environment.logs through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "environment",
      "logs",
      "environment:session-main:shim",
      "--role",
      "workspace",
      "--tail",
      "25",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "logs",
      environmentId: "environment:session-main:shim",
      environmentState: "ready",
      role: "workspace",
      tail: 25,
      entries: [
        {
          role: "workspace",
          stdout: "workspace ready\n",
          stderr: "",
        },
      ],
    });
  });

  it("rejects removed agent.skill compatibility commands", async () => {
    await expect(execFileAsync(shimPath, [
      "agent",
      "skill",
      "set",
      "--json",
      '{"skillKey":"calendar","description":"Use this for calendar work.","content":"# Calendar","tags":["calendar"]}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda command"),
    });
  });

  it("executes skill native payloads through the transport", async () => {
    const server = await startWatchServer();

    const list = await execFileAsync(shimPath, [
      "skill",
      "list",
      "--tag",
      "calendar",
    ], {
      env: shimEnv(server),
    });
    const listJson = await execFileAsync(shimPath, [
      "skill",
      "list",
      "--tag",
      "calendar",
      "--output",
      "json",
    ], {env: shimEnv(server)});
    const listTable = await execFileAsync(shimPath, [
      "skill",
      "list",
      "--output",
      "table",
      "--tag",
      "calendar",
    ], {env: shimEnv(server)});
    const listFromJsonInput = await execFileAsync(shimPath, [
      "skill",
      "list",
      "--json",
      '{"tags":["calendar"]}',
    ], {env: shimEnv(server)});
    const emptyList = await execFileAsync(shimPath, [
      "skill",
      "list",
      "--tag",
      "missing",
    ], {env: shimEnv(server)});
    const show = await execFileAsync(shimPath, [
      "skill",
      "show",
      "calendar",
    ], {
      env: shimEnv(server),
    });
    const set = await execFileAsync(shimPath, [
      "skill",
      "set",
      "notes",
      "--description",
      "Use this for note work.",
      "--content",
      "# Notes",
      "--tag",
      "notes",
      "--tag",
      "reference",
    ], {
      env: shimEnv(server),
    });
    const patch = await execFileAsync(shimPath, [
      "skill",
      "patch",
      "notes",
      "--description",
      "Use this for updated note work.",
    ], {
      env: shimEnv(server),
    });
    const load = await execFileAsync(shimPath, [
      "skill",
      "load",
      "calendar",
    ], {
      env: shimEnv(server),
    });
    const deleted = await execFileAsync(shimPath, [
      "skill",
      "delete",
      "calendar",
      "--yes",
    ], {
      env: shimEnv(server),
    });
    expect(list.stdout).toBe("calendar\n");
    expect(listFromJsonInput.stdout).toBe("calendar\n");
    expect(emptyList.stdout).toBe("");
    expect(JSON.parse(listJson.stdout)).toMatchObject({
      operation: "list",
      agentKey: "panda",
      count: 1,
      skills: [{
        skillKey: "calendar",
        description: "Use this for calendar work.",
        contentBytes: Buffer.byteLength("# Calendar", "utf8"),
        tags: ["calendar", "planning"],
      }],
    });
    expect(listTable.stdout).toBe([
      "SKILL KEY\tDESCRIPTION\tTAGS\tCONTENT BYTES",
      `calendar\tUse this for calendar work.\tcalendar,planning\t${Buffer.byteLength("# Calendar", "utf8")}`,
      "",
    ].join("\n"));
    expect(JSON.parse(show.stdout)).toMatchObject({
      operation: "show",
      agentKey: "panda",
      skillKey: "calendar",
      found: true,
      content: "# Calendar",
    });
    expect(JSON.parse(set.stdout)).toMatchObject({
      operation: "set",
      agentKey: "panda",
      skillKey: "notes",
      description: "Use this for note work.",
      contentBytes: Buffer.byteLength("# Notes", "utf8"),
      tags: ["notes", "reference"],
    });
    expect(JSON.parse(patch.stdout)).toMatchObject({
      operation: "patch",
      agentKey: "panda",
      skillKey: "notes",
      description: "Use this for updated note work.",
    });
    expect(JSON.parse(load.stdout)).toMatchObject({
      operation: "load",
      agentKey: "panda",
      skillKey: "calendar",
      found: true,
      content: "# Calendar",
    });
    expect(JSON.parse(deleted.stdout)).toEqual({
      operation: "delete",
      agentKey: "panda",
      skillKey: "calendar",
      deleted: true,
    });
  });

  it("rejects skill delete without confirmation", async () => {
    await expect(execFileAsync(shimPath, [
      "skill",
      "delete",
      "calendar",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda skill delete requires --yes or --json @payload.json."),
    });
  });

  it("uses explicit output modes for command discovery and rejects old output aliases", async () => {
    const server = await startWatchServer();
    const keys = await execFileAsync(shimPath, ["commands"], {env: shimEnv(server)});
    const json = await execFileAsync(shimPath, ["commands", "--output", "json"], {env: shimEnv(server)});
    const table = await execFileAsync(shimPath, ["commands", "--output", "table"], {env: shimEnv(server)});

    expect(keys.stdout.split("\n")).toContain("skill.list");
    expect(JSON.parse(json.stdout)).toMatchObject({
      commands: expect.arrayContaining([expect.objectContaining({name: "skill.list"})]),
    });
    expect(table.stdout).toMatch(/^COMMAND\tSUMMARY\tINPUT MODES\tOUTPUT MODES\n/);
    await expect(execFileAsync("bash", [
      "-c",
      'while IFS= read -r skill; do "$1" skill load "$skill" >/dev/null; done < <("$1" skill list)',
      "bash",
      shimPath,
    ], {env: shimEnv(server)})).resolves.toMatchObject({stderr: ""});
    await expect(execFileAsync(shimPath, ["commands", "--json"]))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("panda commands --json was removed; use panda commands --output json."),
      });
    await expect(execFileAsync(shimPath, ["skill", "list", "--output", "yaml"]))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("panda skill list --output must be keys, json, or table."),
      });
  });

  it("executes readonly postgres JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "postgres",
      "readonly",
      "query",
      "--json",
      '{"sql":"select answer from session.messages limit 1"}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      rowCount: 1,
      truncated: false,
      rows: [{
        answer: 42,
      }],
    });
  });

  it("executes readonly postgres query through native sql file args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-postgres-shim-"));
    directories.push(directory);
    const sqlPath = path.join(directory, "query.sql");
    await writeFile(sqlPath, "select answer from session.messages limit 1", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "postgres",
      "readonly",
      "query",
      "--sql",
      `@${sqlPath}`,
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      rowCount: 1,
      truncated: false,
      rows: [{
        answer: 42,
      }],
    });
  });

  it("executes wiki.search JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "search",
      "--json",
      '{"query":"profile"}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "search",
      query: "profile",
      totalHits: 1,
      results: [
        expect.objectContaining({path: "agents/panda/profile"}),
      ],
    });
  });

  it("executes wiki.overview through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "overview",
      "--locale",
      "sk",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "overview",
      namespacePath: "agents/panda",
      locale: "sk",
      recentlyEdited: [expect.objectContaining({path: "agents/panda/profile"})],
      mostLinked: [expect.objectContaining({inboundLinks: 3})],
    });
  });

  it("executes wiki.read through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "read",
      "agents/panda/profile",
      "--locale",
      "sk",
      "--format",
      "markdown",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "read",
      format: "markdown",
      found: true,
      path: "agents/panda/profile",
      locale: "sk",
      title: "Profile",
      content: "# Profile",
    });
  });

  it("executes postgres.readonly.query native max rows and schema help", async () => {
    const server = await startWatchServer();

    const query = await execFileAsync(shimPath, [
      "postgres",
      "readonly",
      "query",
      "--sql",
      "select 42 as answer",
      "--max-rows",
      "100",
    ], {
      env: shimEnv(server),
    });
    const schemaHelp = await execFileAsync(shimPath, [
      "postgres",
      "readonly",
      "query",
      "--schema-help",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(query.stdout)).toMatchObject({
      operation: "query",
      requestedMaxRows: 100,
      maxRows: 50,
      maxRowsCapped: true,
      rowCount: 1,
      rows: [{answer: 42}],
    });
    expect(JSON.parse(schemaHelp.stdout)).toMatchObject({
      operation: "schema_help",
      views: expect.arrayContaining([
        expect.objectContaining({name: "session.messages"}),
      ]),
    });
  });

  it("executes wiki.search through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "search",
      "profile",
      "--path",
      "agents/panda/notes",
      "--locale",
      "sk",
      "--limit",
      "1",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "search",
      query: "profile",
      path: "agents/panda/notes",
      locale: "sk",
      totalHits: 1,
      count: 1,
      truncated: false,
    });
  });

  it("executes wiki.list through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "list",
      "agents/panda/notes",
      "--limit",
      "20",
      "--include-archived",
      "--locale",
      "sk",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "list",
      path: "agents/panda/notes",
      locale: "sk",
      limit: 20,
      includeArchived: true,
    });
  });

  it("executes wiki.diff through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "diff",
      "agents/panda/_archive/profile-old",
      "agents/panda/profile",
      "--locale",
      "sk",
      "--context",
      "1",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "diff",
      locale: "sk",
      left: {
        path: "agents/panda/_archive/profile-old",
      },
      right: {
        path: "agents/panda/profile",
      },
      equal: false,
      contextLines: 1,
      stats: {
        addedLines: 1,
        removedLines: 1,
      },
      hunks: [
        expect.objectContaining({
          lines: expect.arrayContaining([
            expect.objectContaining({type: "remove", text: "old"}),
            expect.objectContaining({type: "add", text: "new"}),
          ]),
        }),
      ],
    });
  });

  it("executes wiki.write page through native args and file content", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-wiki-shim-"));
    directories.push(directory);
    const pagePath = path.join(directory, "profile.md");
    await writeFile(pagePath, "# Profile\nNative page.", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "write",
      "page",
      "agents/panda/profile",
      "--title",
      "Profile",
      "--content",
      `@${pagePath}`,
      "--tag",
      "profile",
      "--tag",
      "facts",
      "--published",
      "--private",
      "--create",
      "--base-updated-at",
      "2026-06-24T12:00:00.000Z",
      "--locale",
      "sk",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "write",
      action: "updated",
      page: {
        path: "agents/panda/profile",
        locale: "sk",
        title: "Profile",
      },
    });
  });

  it("executes wiki.write.section through native args and file content", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-wiki-shim-"));
    directories.push(directory);
    const sectionPath = path.join(directory, "facts.md");
    await writeFile(sectionPath, "- useful", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "write",
      "section",
      "agents/panda/profile",
      "Facts",
      "--content",
      `@${sectionPath}`,
      "--title",
      "Profile",
      "--no-create",
      "--base-updated-at",
      "2026-06-24T12:00:00.000Z",
      "--locale",
      "sk",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "write_section",
      action: "updated",
      section: {
        title: "Facts",
        action: "replaced",
      },
      page: {
        path: "agents/panda/profile",
        locale: "sk",
        title: "Profile",
      },
    });
  });

  it("executes wiki.move and wiki.archive through native args", async () => {
    const server = await startWatchServer();

    const move = await execFileAsync(shimPath, [
      "wiki",
      "move",
      "agents/panda/old",
      "agents/panda/new",
      "--rewrite-links",
      "--base-updated-at",
      "2026-06-24T12:00:00.000Z",
      "--locale",
      "sk",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(move.stdout)).toMatchObject({
      operation: "move",
      movedFrom: "agents/panda/old",
      movedTo: "agents/panda/new",
      rewriteLinks: true,
      page: {
        path: "agents/panda/new",
        locale: "sk",
      },
    });

    const archive = await execFileAsync(shimPath, [
      "wiki",
      "archive",
      "agents/panda/old-note",
      "--base-updated-at",
      "2026-06-24T12:00:00.000Z",
      "--locale",
      "sk",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(archive.stdout)).toMatchObject({
      operation: "archive",
      archivedFrom: "agents/panda/old-note",
      archivedTo: "agents/panda/_archive/2026/06/profile",
      page: {
        locale: "sk",
      },
    });

    const restore = await execFileAsync(shimPath, [
      "wiki",
      "restore",
      "agents/panda/_archive/2026/06/profile",
      "agents/panda/profile",
      "--base-updated-at",
      "2026-06-24T12:00:00.000Z",
      "--locale",
      "sk",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(restore.stdout)).toMatchObject({
      operation: "restore",
      restoredFrom: "agents/panda/_archive/2026/06/profile",
      restoredTo: "agents/panda/profile",
      page: {
        path: "agents/panda/profile",
        locale: "sk",
      },
    });
  });

  it("executes wiki.fetch.asset through native args with artifact output", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "fetch",
      "asset",
      "agents/panda/_assets/profile/profile-photo.png",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "fetch_asset",
      assetPath: "agents/panda/_assets/profile/profile-photo.png",
      localPath: "/tmp/panda/wiki/profile-photo.png",
      artifact: {
        kind: "image",
        source: "view_media",
        path: "/tmp/panda/wiki/profile-photo.png",
      },
    });
  });

  it("executes wiki.delete.asset through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "delete",
      "asset",
      "agents/panda/_assets/profile/profile-photo.png",
      "--yes",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "delete_asset",
      assetPath: "agents/panda/_assets/profile/profile-photo.png",
      assetId: 44,
      filename: "profile-photo.png",
      deleted: true,
    });
  });

  it("rejects wiki.delete.asset without confirmation", async () => {
    await expect(execFileAsync(shimPath, [
      "wiki",
      "delete",
      "asset",
      "agents/panda/_assets/profile/profile-photo.png",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda wiki delete asset requires --yes or --json @payload.json."),
    });
  });

  it("executes wiki.write.section JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "write",
      "section",
      "--json",
      '{"path":"agents/panda/profile","section":"Facts","content":"Updated facts."}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "write_section",
      action: "updated",
      section: {
        title: "Facts",
        action: "replaced",
      },
      page: {
        path: "agents/panda/profile",
      },
    });
  });

  it("executes wiki.attach.image JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "attach",
      "image",
      "--json",
      '{"path":"agents/panda/profile","section":"Facts","slot":"profile-photo","sourcePath":"profile.png","alt":"Profile photo"}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "attach_image",
      action: "updated",
      assetPath: "agents/panda/_assets/profile/profile-photo.png",
      slot: "profile-photo",
      page: {
        path: "agents/panda/profile",
      },
    });
  });

  it("executes wiki.attach.image through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "attach",
      "image",
      "agents/panda/profile",
      "Facts",
      "--slot",
      "profile-photo",
      "--source",
      "./profile.png",
      "--alt",
      "Profile photo",
      "--caption",
      "Official profile photo",
      "--base-updated-at",
      "2026-06-24T12:01:00.000Z",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "attach_image",
      action: "updated",
      assetPath: "agents/panda/_assets/profile/profile-photo.png",
      slot: "profile-photo",
      page: {
        path: "agents/panda/profile",
      },
    });
  });

  it("executes wiki.fetch.asset JSON payloads through the transport with artifact output", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "wiki",
      "fetch",
      "asset",
      "--json",
      '{"assetPath":"agents/panda/_assets/profile/profile-photo.png"}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      operation: "fetch_asset",
      assetPath: "agents/panda/_assets/profile/profile-photo.png",
      localPath: "/tmp/panda/wiki/profile-photo.png",
      artifact: {
        kind: "image",
        source: "view_media",
        path: "/tmp/panda/wiki/profile-photo.png",
      },
    });
  });

  it("rejects removed todo.update compatibility command", async () => {
    await expect(execFileAsync(shimPath, [
      "todo",
      "update",
      "--json",
      '{"items":[{"status":"in_progress","content":"Inspect code"}]}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda todo command"),
    });
  });

  it("executes todo.add through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-todo-shim-"));
    directories.push(directory);
    const itemPath = path.join(directory, "todo.txt");
    await writeFile(itemPath, "Write docs", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "todo",
      "add",
      `@${itemPath}`,
      "--status",
      "in_progress",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      updated: true,
      itemCount: 3,
      openItemCount: 3,
      doneItemCount: 0,
      itemIndex: 3,
      item: {
        status: "in_progress",
        content: "Write docs",
      },
    });
  });

  it("executes todo.list and todo.show through native args", async () => {
    const server = await startWatchServer();

    const list = await execFileAsync(shimPath, [
      "todo",
      "list",
      "--status",
      "all",
    ], {
      env: shimEnv(server),
    });
    const show = await execFileAsync(shimPath, [
      "todo",
      "show",
      "2",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(list.stdout)).toMatchObject({
      operation: "list",
      status: "all",
      count: 2,
      items: [
        {
          index: 1,
          status: "in_progress",
          content: "Inspect code",
        },
        {
          index: 2,
          status: "pending",
          content: "Run tests",
        },
      ],
    });
    expect(JSON.parse(show.stdout)).toMatchObject({
      operation: "show",
      itemIndex: 2,
      item: {
        index: 2,
        status: "pending",
        content: "Run tests",
      },
    });
  });

  it("prints structured command errors instead of bare curl failures", async () => {
    const server = await startWatchServer();

    await expect(execFileAsync(shimPath, [
      "todo",
      "show",
      "99",
    ], {
      env: shimEnv(server),
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("Todo item 99 does not exist."),
    });
  });

  it("preserves remote command failure status in shell chains", async () => {
    const server = await startWatchServer();

    await expect(execFileAsync("/bin/zsh", [
      "-c",
      `"${shimPath}" todo show --json '{"index":0}' && printf 'continued\\n'`,
    ], {
      env: shimEnv(server),
    })).rejects.toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("todo.show index must be a positive integer."),
    });
  });

  it("executes todo.done and todo.block through native indexes", async () => {
    const server = await startWatchServer();

    const done = await execFileAsync(shimPath, [
      "todo",
      "done",
      "1",
    ], {
      env: shimEnv(server),
    });
    const blocked = await execFileAsync(shimPath, [
      "todo",
      "block",
      "2",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(done.stdout)).toMatchObject({
      updated: true,
      itemCount: 2,
      openItemCount: 1,
      doneItemCount: 1,
      itemIndex: 1,
      item: {
        status: "done",
        content: "Inspect code",
      },
    });
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      updated: true,
      itemCount: 2,
      openItemCount: 2,
      doneItemCount: 0,
      itemIndex: 2,
      item: {
        status: "blocked",
        content: "Run tests",
      },
    });
  });

  it("rejects invalid todo native indexes before transport", async () => {
    await expect(execFileAsync(shimPath, [
      "todo",
      "done",
      "zero",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda todo done <index> requires a positive integer."),
    });
  });

  it("executes todo.clear through the transport without a JSON payload", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "todo",
      "clear",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      updated: true,
      cleared: true,
      itemCount: 0,
      openItemCount: 0,
      doneItemCount: 0,
    });
  });

  it("executes session prompt JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const read = await execFileAsync(shimPath, [
      "session",
      "prompt",
      "current",
      "read",
      "--json",
      '{"slug":"brief"}',
    ], {
      env: shimEnv(server),
    });
    const set = await execFileAsync(shimPath, [
      "session",
      "prompt",
      "current",
      "set",
      "--json",
      '{"slug":"memory","content":"Remember CLI contracts."}',
    ], {
      env: shimEnv(server),
    });
    const transform = await execFileAsync(shimPath, [
      "session",
      "prompt",
      "current",
      "transform",
      "--json",
      "{\"slug\":\"heartbeat\",\"operation\":\"expression\",\"expression\":\"concat(content, '\\nPing.')\"}",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(read.stdout)).toMatchObject({
      sessionId: "session-main",
      slug: "brief",
      operation: "read",
      exists: true,
      content: "brief content",
    });
    expect(JSON.parse(set.stdout)).toMatchObject({
      sessionId: "session-main",
      slug: "memory",
      operation: "set",
      content: "Remember CLI contracts.",
    });
    expect(JSON.parse(transform.stdout)).toMatchObject({
      sessionId: "session-main",
      slug: "heartbeat",
      operation: "transform",
      transformOperation: "expression",
      changed: true,
      content: "concat(content, '\nPing.') result",
    });
  });

  it("rejects the removed session prompt expression JSON shape", async () => {
    const server = await startWatchServer();

    const error = await execFileAsync(shimPath, [
      "session",
      "prompt",
      "current",
      "transform",
      "--json",
      '{"slug":"memory","expression":"upper(content)"}',
    ], {
      env: shimEnv(server),
    }).then(() => null, (reason: unknown) => reason as {stdout: string; stderr: string});

    expect(error?.stdout).toBe("");
    expect(JSON.parse(error?.stderr.trim() ?? "{}")).toMatchObject({
      ok: false,
      command: "session.prompt.transform",
      error: {
        code: "command_failed",
        message: 'session.prompt.transform no longer accepts {slug, expression}. Use {"slug":"memory","operation":"expression","expression":"upper(content)"}.',
      },
    });
  });

  it("executes session prompt read through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "session",
      "prompt",
      "current",
      "read",
      "memory",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      sessionId: "session-main",
      slug: "memory",
      operation: "read",
      exists: true,
      content: "memory content",
    });
  });

  it("executes session prompt read raw mode for safe round trips", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "session",
      "prompt",
      "current",
      "read",
      "brief",
      "--raw",
    ], {
      env: shimEnv(server),
    });

    expect(stdout).toBe("brief content\n");
  });

  it("executes session prompt set through native content args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-session-prompt-shim-"));
    directories.push(directory);
    const promptPath = path.join(directory, "memory.md");
    await writeFile(promptPath, "Remember native prompt files.", "utf8");

    const file = await execFileAsync(shimPath, [
      "session",
      "prompt",
      "current",
      "set",
      "memory",
      "--content",
      `@${promptPath}`,
    ], {
      env: shimEnv(server),
    });
    const stdin = await execFileAsync("bash", [
      "-c",
      "printf '%s' 'Brief from stdin.' | \"$1\" session prompt current set brief --content @-",
      "bash",
      shimPath,
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(file.stdout)).toMatchObject({
      sessionId: "session-main",
      slug: "memory",
      operation: "set",
      content: "Remember native prompt files.",
    });
    expect(JSON.parse(stdin.stdout)).toMatchObject({
      sessionId: "session-main",
      slug: "brief",
      operation: "set",
      content: "Brief from stdin.",
    });
  });

  it("unwraps accidental session prompt read envelopes when setting content", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-session-prompt-envelope-"));
    directories.push(directory);
    const promptPath = path.join(directory, "brief-envelope.json");
    await writeFile(promptPath, JSON.stringify({
      sessionId: "session-main",
      slug: "brief",
      operation: "read",
      exists: true,
      content: "# Raw Brief\n\nOnly this should remain.",
      updatedAt: 2,
    }), "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "session",
      "prompt",
      "current",
      "set",
      "brief",
      "--content",
      `@${promptPath}`,
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      sessionId: "session-main",
      slug: "brief",
      operation: "set",
      content: "# Raw Brief\n\nOnly this should remain.",
    });
  });

  it("executes session prompt transform through native shorthands", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-session-prompt-transform-shim-"));
    directories.push(directory);
    const notePath = path.join(directory, "heartbeat-note.md");
    await writeFile(notePath, " --json; \"quoted\" O'Reilly -- note `code` $(shell) 😀\n\n", "utf8");

    const append = await execFileAsync(shimPath, [
      "session",
      "prompt",
      "current",
      "transform",
      "heartbeat",
      "--append",
      `@${notePath}`,
    ], {
      env: shimEnv(server),
    });
    const replace = await execFileAsync("bash", [
      "-c",
      "printf '%s' 'new value' | \"$1\" session prompt current transform memory --replace old --with @-",
      "bash",
      shimPath,
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(append.stdout)).toMatchObject({
      sessionId: "session-main",
      slug: "heartbeat",
      operation: "transform",
      transformOperation: "append",
      content: " --json; \"quoted\" O'Reilly -- note `code` $(shell) 😀\n\n",
    });
    expect(JSON.parse(replace.stdout)).toMatchObject({
      sessionId: "session-main",
      slug: "memory",
      operation: "transform",
      transformOperation: "replace",
      matchCount: 1,
      content: "old=>new value",
    });
  });

  it("rejects conflicting session prompt transform modes", async () => {
    await expect(execFileAsync(shimPath, [
      "session",
      "prompt",
      "current",
      "transform",
      "memory",
      "--append",
      "one",
      "--prepend",
      "two",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda session prompt current transform accepts only one transform mode."),
    });
  });

  it("executes subagent inventory list/show through native args", async () => {
    const server = await startWatchServer();

    const list = await execFileAsync(shimPath, [
      "subagent",
      "list",
      "--run-status",
      "failed",
      "--limit",
      "7",
    ], {
      env: shimEnv(server),
    });
    const show = await execFileAsync(shimPath, [
      "subagent",
      "show",
      "subagent-session",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(list.stdout)).toMatchObject({
      operation: "list",
      count: 1,
      hasMore: false,
      subagents: [expect.objectContaining({profile: "failed:7"})],
    });
    expect(JSON.parse(show.stdout)).toMatchObject({
      operation: "show",
      sessionId: "subagent-session",
      currentThreadId: "subagent-thread",
    });
  });

  it("executes subagent.profile.upsert JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "subagent",
      "profile",
      "upsert",
      "--json",
      '{"slug":"reviewer","description":"Review code.","prompt":"Inspect changes.","toolGroups":["core"]}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      slug: "reviewer",
      source: "custom",
      agentKey: "panda",
      description: "Review code.",
      toolGroups: ["core"],
      enabled: true,
    });
  });

  it("executes subagent.profile list/show/enable/disable through native args", async () => {
    const server = await startWatchServer();

    const list = await execFileAsync(shimPath, [
      "subagent",
      "profile",
      "list",
      "--include-disabled",
    ], {
      env: shimEnv(server),
    });
    const show = await execFileAsync(shimPath, [
      "subagent",
      "profile",
      "show",
      "reviewer",
      "--include-disabled",
    ], {
      env: shimEnv(server),
    });
    const disable = await execFileAsync(shimPath, [
      "subagent",
      "profile",
      "disable",
      "reviewer",
    ], {
      env: shimEnv(server),
    });
    const enable = await execFileAsync(shimPath, [
      "subagent",
      "profile",
      "enable",
      "reviewer",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(list.stdout)).toMatchObject({
      count: 2,
      profiles: [
        expect.objectContaining({slug: "workspace", source: "builtin"}),
        expect.objectContaining({slug: "reviewer", source: "custom"}),
      ],
    });
    expect(JSON.parse(show.stdout)).toMatchObject({
      slug: "reviewer",
      prompt: "Inspect changes and report risks.",
      toolGroups: ["core"],
    });
    expect(JSON.parse(disable.stdout)).toMatchObject({
      slug: "reviewer",
      enabled: false,
    });
    expect(JSON.parse(enable.stdout)).toMatchObject({
      slug: "reviewer",
      enabled: true,
    });
  });

  it("executes subagent.profile.upsert through native args and file prompt", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-subagent-profile-shim-"));
    directories.push(directory);
    const promptPath = path.join(directory, "reviewer.md");
    await writeFile(promptPath, "Inspect changes and report risks.", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "subagent",
      "profile",
      "upsert",
      "reviewer",
      "--description",
      "Review code.",
      "--prompt",
      `@${promptPath}`,
      "--tool-group",
      "core",
      "--model",
      "openai-codex/gpt-5.5",
      "--thinking",
      "high",
      "--disabled",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      slug: "reviewer",
      source: "custom",
      agentKey: "panda",
      description: "Review code.",
      toolGroups: ["core"],
      model: "openai-codex/gpt-5.5",
      thinking: "high",
      enabled: false,
    });
  });

  it("rejects subagent.profile.upsert without tool groups before transport", async () => {
    await expect(execFileAsync(shimPath, [
      "subagent",
      "profile",
      "upsert",
      "reviewer",
      "--description",
      "Review code.",
      "--prompt",
      "Inspect changes.",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda subagent profile upsert requires at least one --tool-group <group>."),
    });
  });

  it("executes subagent.spawn JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "subagent",
      "spawn",
      "--json",
      '{"profile":"workspace","prompt":"Inspect the runtime wiring."}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      status: "spawned",
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      profile: "workspace",
      profileSource: "builtin",
      execution: "agent_workspace",
    });
  });

  it("executes subagent.spawn through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-subagent-shim-"));
    directories.push(directory);
    const contextPath = path.join(directory, "context.md");
    await writeFile(contextPath, "Focus issue #94 and command UX.", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "subagent",
      "spawn",
      "Inspect the runtime wiring.",
      "--context",
      `@${contextPath}`,
      "--environment",
      "env-child",
      "--tool-group",
      "core",
      "--tool-group",
      "internet",
      "--credential",
      "BRAVE_API_KEY",
      "--credential-ref",
      "mcp-oauth:reports",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      status: "spawned",
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      execution: "isolated_environment",
      environmentId: "env-child",
    });
  });

  it("rejects isolated subagent.spawn without an environment before transport", async () => {
    await expect(execFileAsync(shimPath, [
      "subagent",
      "spawn",
      "Inspect the runtime wiring.",
      "--isolated",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda subagent spawn --isolated requires --environment <environment-id>."),
    });
  });

  it("rejects the removed message.agent.send compatibility path", async () => {
    await expect(execFileAsync(shimPath, [
      "message",
      "agent",
      "send",
      "--json",
      '{"sessionId":"session-b","items":[{"type":"text","text":"hello"}]}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda command"),
    });
  });

  it("executes a2a.send flag payloads with generic file attachments", async () => {
    const queuedMessages: Array<{items?: readonly Record<string, unknown>[]}> = [];
    const server = await startWatchServer({
      onA2AQueueMessage: (input) => queuedMessages.push(input as {items?: readonly Record<string, unknown>[]}),
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-a2a-shim-"));
    directories.push(directory);
    const reportPath = path.join(directory, "report.md");
    await writeFile(reportPath, "hello", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "a2a",
      "send",
      "--to-session",
      "session-b",
      "--text",
      "see attached",
      "--file",
      reportPath,
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-1",
      targetAgentKey: "koala",
      targetSessionId: "session-b",
      messageId: "a2a:shim",
    });
    expect(queuedMessages[0]?.items?.[1]).toMatchObject({
      type: "file",
      uploadRef: expect.stringMatching(/^upl_[a-f0-9]{32}$/),
      filename: "report.md",
      mimeType: "application/octet-stream",
      sizeBytes: 5,
    });
    expect(queuedMessages[0]?.items?.[1]).not.toHaveProperty("path");
  });

  it("executes a2a.send text bodies from literal values and @file", async () => {
    const queuedMessages: unknown[] = [];
    const server = await startWatchServer({
      onA2AQueueMessage: (input) => {
        queuedMessages.push(input);
      },
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-a2a-text-shim-"));
    directories.push(directory);
    const messagePath = path.join(directory, "message.md");
    await writeFile(messagePath, "from file\nsecond line", "utf8");

    await execFileAsync(shimPath, [
      "a2a",
      "send",
      "--to-session",
      "session-b",
      "--text",
      "literal body",
      "--text",
      `@${messagePath}`,
    ], {
      env: shimEnv(server),
    });

    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toMatchObject({
      sessionId: "session-b",
      items: [
        {type: "text", text: "literal body"},
        {type: "text", text: "from file\nsecond line"},
      ],
    });
  });

  it("executes a2a.send text bodies from --text @-", async () => {
    const queuedMessages: unknown[] = [];
    const server = await startWatchServer({
      onA2AQueueMessage: (input) => {
        queuedMessages.push(input);
      },
    });

    await execFileAsync("bash", [
      "-c",
      "printf '%s' 'from stdin body' | \"$1\" a2a send --to-session session-b --text @-",
      "bash",
      shimPath,
    ], {
      env: shimEnv(server),
    });

    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toMatchObject({
      sessionId: "session-b",
      items: [
        {type: "text", text: "from stdin body"},
      ],
    });
  });

  it("executes a2a.inspect for delivery receipts", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "a2a",
      "inspect",
      "delivery-1",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      deliveryId: "delivery-1",
      messageId: "a2a:shim",
      direction: "outbound",
      status: "sent",
      fromSessionId: "session-main",
      toSessionId: "session-b",
      itemCount: 1,
    });
  });

  it("executes a2a.history with native filters", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "a2a",
      "history",
      "--peer-session",
      "session-b",
      "--direction",
      "outbound",
      "--limit",
      "20",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      count: 1,
      deliveries: [
        {
          deliveryId: "delivery-1",
          messageId: "a2a:shim",
          direction: "outbound",
          status: "sent",
          toSessionId: "session-b",
        },
      ],
    });
  });

  it("rejects a2a.send --image because attachments use --file", async () => {
    await expect(execFileAsync(shimPath, [
      "a2a",
      "send",
      "--to-session",
      "session-b",
      "--image",
      "shot.png",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("panda a2a send uses --file for all attachments, including images."),
    });
  });

  it("rejects removed outbound.send compatibility command", async () => {
    await expect(execFileAsync(shimPath, [
      "outbound",
      "send",
      "--json",
      '{"items":[{"type":"text","text":"hello"}]}',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda command"),
    });
  });

  it("rejects removed current-route reply command", async () => {
    await expect(execFileAsync(shimPath, [
      "reply",
      "send",
      "--text",
      "hello",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown panda command"),
    });
  });

  it("executes email.send JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "email",
      "send",
      "--json",
      '{"accountKey":"work","to":[{"address":"alice@example.com"}],"subject":"Report","text":"Attached."}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-email",
      channel: "email",
      accountKey: "work",
      from: "panda@example.com",
    });
  });

  it("executes email.send fresh messages through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-email-shim-"));
    directories.push(directory);
    const bodyPath = path.join(directory, "body.txt");
    const attachmentPath = path.join(directory, "report.txt");
    await writeFile(bodyPath, "Attached.", "utf8");
    await writeFile(attachmentPath, "report", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "email",
      "send",
      "--account",
      "work",
      "--to",
      "Alice <alice@example.com>",
      "--cc",
      "ops@example.com",
      "--subject",
      "Report",
      "--text",
      `@${bodyPath}`,
      "--file",
      attachmentPath,
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-email",
      channel: "email",
      accountKey: "work",
      from: "panda@example.com",
    });
  });

  it("executes email.send replies through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "email",
      "send",
      "--account",
      "work",
      "--reply-to-email-id",
      "message-1",
      "--reply-mode",
      "all",
      "--text",
      "Thanks.",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-email",
      channel: "email",
      accountKey: "work",
      from: "panda@example.com",
    });
  });

  it("executes email.account.list through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "email",
      "account",
      "list",
      "--sendable-only",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      count: 1,
      accounts: [
        {
          accountKey: "work",
          fromAddress: "panda@example.com",
          sendable: true,
        },
      ],
    });
    expect(stdout).not.toContain("imap.example.com");
    expect(stdout).not.toContain("IMAP_PASS");
  });

  it("executes email.list through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "email",
      "list",
      "--account",
      "work",
      "--mailbox",
      "INBOX",
      "--direction",
      "inbound",
      "--limit",
      "2",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      count: 2,
      messages: [
        {
          id: "message-1",
          accountKey: "work",
          direction: "inbound",
          mailbox: "INBOX",
          subject: "Question",
          from: {
            address: "alice@example.com",
            name: "Alice",
          },
          receivedAt: "2026-06-24T12:00:00.000Z",
          bodyExcerpt: "Can you review the launch plan?",
          authSummary: "trusted",
          hasAttachments: false,
        },
        {
          id: "message-2",
          subject: "Invoice",
          hasAttachments: true,
        },
      ],
    });
  });

  it("executes email.search through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "email",
      "search",
      "invoice",
      "--account",
      "work",
      "--limit",
      "5",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      query: "invoice",
      count: 1,
      messages: [
        {
          id: "message-2",
          subject: "Invoice",
          bodyExcerpt: "Invoice attached.",
          hasAttachments: true,
        },
      ],
    });
  });

  it("executes email.read through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "email",
      "read",
      "message-2",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      message: {
        id: "message-2",
        subject: "Invoice",
        bodyText: "Invoice attached.",
        recipients: [
          {
            role: "from",
            address: "alice@example.com",
            name: "Alice",
          },
        ],
        attachments: [
          {
            id: "attachment-1",
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            sizeBytes: 11,
          },
        ],
      },
    });
  });

  it("executes email.attachments.fetch through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "email",
      "attachments",
      "fetch",
      "attachment-1",
      "--save",
      "fetched-invoice.pdf",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      attachment: {
        id: "attachment-1",
        messageId: "message-2",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
      },
      saved: {
        displayPath: "fetched-invoice.pdf",
        bytes: 11,
        mimeType: "application/pdf",
      },
      artifact: {
        kind: "pdf",
        source: "view_media",
        mimeType: "application/pdf",
        bytes: 11,
      },
    });
  });

  it("executes telegram.send JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "send",
      "--json",
      '{"connectorKey":"telegram-main","conversationId":"1615376408","items":[{"type":"text","text":"hello"}]}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-outbound",
      to: {
        channel: "telegram",
        connectorKey: "telegram-main",
        conversationId: "1615376408",
      },
    });
  });

  it("executes telegram.chat.list through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "chat",
      "list",
      "--connector",
      "telegram-main",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      count: 1,
      chats: [
        {
          accountKey: "main",
          connectorKey: "telegram-main",
          conversationId: "1615376408",
          sessionId: "session-main",
          metadata: {
            title: "Launch chat",
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
  });

  it("executes telegram.chat.info through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "chat",
      "info",
      "1615376408",
      "--connector",
      "telegram-main",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      chat: {
        accountKey: "main",
        connectorKey: "telegram-main",
        conversationId: "1615376408",
        sessionId: "session-main",
        metadata: {
          title: "Launch chat",
        },
        createdAt: 1,
        updatedAt: 2,
      },
    });
  });

  it("executes telegram.history through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "history",
      "--chat",
      "1615376408",
      "--connector",
      "telegram-main",
      "--direction",
      "all",
      "--limit",
      "10",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      source: "durable_panda_records",
      direction: "all",
      limit: 10,
      count: 2,
      chat: {
        connectorKey: "telegram-main",
        conversationId: "1615376408",
        sessionId: "session-main",
      },
      items: [
        {
          id: "thread-message-telegram-1",
          direction: "inbound",
          threadId: "thread-main",
          messageId: "555",
          actorId: "1615376408",
          username: "alice",
          firstName: "Alice",
          text: "Launch plan looks good.",
          media: [
            {
              id: "media-1",
              mimeType: "image/png",
              sizeBytes: 14,
              originalFilename: "chart.png",
            },
          ],
          sentAt: "2026-06-25T10:00:00.000Z",
          createdAt: 10,
        },
        {
          id: "delivery-telegram-1",
          deliveryId: "delivery-telegram-1",
          direction: "outbound",
          status: "sent",
          threadId: "thread-main",
          replyToMessageId: "555",
          items: [
            {
              type: "text",
              text: "Thanks, shipping it.",
            },
          ],
          sentItems: [
            {
              type: "text",
              externalMessageId: "556",
            },
          ],
          createdAt: 20,
          completedAt: 21,
        },
      ],
    });
  });

  it("executes telegram.media.fetch through native args with artifact output", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-telegram-media-fetch-"));
    directories.push(directory);
    const savePath = path.join(directory, "chart.png");

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "media",
      "fetch",
      "media-1",
      "--chat",
      "1615376408",
      "--connector",
      "telegram-main",
      "--save",
      savePath,
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      chat: {
        connectorKey: "telegram-main",
        conversationId: "1615376408",
        sessionId: "session-main",
      },
      media: {
        id: "media-1",
        mimeType: "image/png",
        sizeBytes: 14,
        originalFilename: "chart.png",
      },
      message: {
        id: "thread-message-telegram-1",
        threadId: "thread-main",
        messageId: "555",
      },
      saved: {
        path: savePath,
        displayPath: savePath,
        bytes: 14,
        mimeType: "image/png",
      },
      artifact: {
        kind: "image",
        source: "view_media",
        path: savePath,
        mimeType: "image/png",
        bytes: 14,
        originalPath: "chart.png",
      },
    });
    await expect(readFile(savePath, "utf8")).resolves.toBe("telegram-image");
  });

  it("executes telegram.send through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-telegram-shim-"));
    directories.push(directory);
    const messagePath = path.join(directory, "message.md");
    const reportPath = path.join(directory, "report.pdf");
    await writeFile(messagePath, "hello from file", "utf8");
    await writeFile(reportPath, "report", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "send",
      "--chat",
      "1615376408",
      "--connector",
      "telegram-main",
      "--text",
      `@${messagePath}`,
      "--file",
      reportPath,
      "--reply-to-message-id",
      "555",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-outbound",
      to: {
        channel: "telegram",
        connectorKey: "telegram-main",
        conversationId: "1615376408",
      },
    });
  });

  it("executes telegram.sticker.send through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "sticker",
      "send",
      "--chat",
      "1615376408",
      "--connector",
      "telegram-main",
      "--file-id",
      "CAACAgIAAxkBAAE",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      sticker: {
        type: "file_id",
      },
      queued: true,
    });
  });

  it("executes discord.send through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-discord-shim-"));
    directories.push(directory);
    const messagePath = path.join(directory, "message.md");
    const reportPath = path.join(directory, "report.pdf");
    await writeFile(messagePath, "hello discord", "utf8");
    await writeFile(reportPath, "report", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "discord",
      "send",
      "--channel",
      "123456789012345678",
      "--thread",
      "223456789012345678",
      "--guild",
      "323456789012345678",
      "--connector",
      "discord-main",
      "--text",
      `@${messagePath}`,
      "--file",
      reportPath,
      "--reply-to-message-id",
      "423456789012345678",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-outbound",
      to: {
        channel: "discord",
        connectorKey: "discord-main",
        conversationId: "123456789012345678",
      },
    });
  });

  it("executes discord.channel.list through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "discord",
      "channel",
      "list",
      "--connector",
      "discord-main",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      count: 1,
      channels: [
        {
          accountKey: "main",
          connectorKey: "discord-main",
          channelId: "123456789012345678",
          sessionId: "session-main",
          metadata: {
            name: "launch",
          },
          createdAt: 3,
          updatedAt: 4,
        },
      ],
    });
  });

  it("executes discord.history through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "discord",
      "history",
      "--channel",
      "123456789012345678",
      "--connector",
      "discord-main",
      "--direction",
      "all",
      "--limit",
      "10",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      source: "durable_panda_records",
      direction: "all",
      limit: 10,
      count: 2,
      channel: {
        connectorKey: "discord-main",
        channelId: "123456789012345678",
        sessionId: "session-main",
      },
      items: [
        {
          id: "thread-message-discord-1",
          direction: "inbound",
          threadId: "thread-main",
          messageId: "623456789012345678",
          actorId: "523456789012345678",
          author: {
            id: "523456789012345678",
            username: "alice",
            globalName: "Alice",
            displayName: "Alice",
            isBot: false,
          },
          parentChannelId: "123456789012345678",
          actualChannelId: "123456789012345678",
          guildId: "323456789012345678",
          text: "Discord launch note.",
          attachments: [
            {
              id: "att-1",
              filename: "plan.pdf",
              contentType: "application/pdf",
              sizeBytes: 12,
            },
          ],
          sentAt: "2026-06-25T11:00:00.000Z",
          createdAt: 30,
        },
        {
          id: "delivery-discord-1",
          deliveryId: "delivery-discord-1",
          direction: "outbound",
          status: "sent",
          threadId: "thread-main",
          replyToMessageId: "623456789012345678",
          discordThreadId: "223456789012345678",
          guildId: "323456789012345678",
          items: [
            {
              type: "text",
              text: "Discord ack.",
            },
          ],
          sentItems: [
            {
              type: "text",
              externalMessageId: "723456789012345678",
            },
          ],
          createdAt: 50,
          completedAt: 51,
        },
      ],
    });
  });

  it("executes whatsapp.send JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "whatsapp",
      "send",
      "--json",
      '{"connectorKey":"main","conversationId":"+421 900 000 000","items":[{"type":"text","text":"hello"}]}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-outbound",
      to: {
        channel: "whatsapp",
        connectorKey: "main",
        conversationId: "421900000000@s.whatsapp.net",
      },
    });
  });

  it("executes whatsapp.chat.list through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "whatsapp",
      "chat",
      "list",
      "--connector",
      "main",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      connectorKey: "main",
      count: 1,
      chats: [
        {
          connectorKey: "main",
          chatId: "421900000000@s.whatsapp.net",
          sessionId: "session-main",
          metadata: {
            displayName: "Alice",
          },
          createdAt: 5,
          updatedAt: 6,
        },
      ],
    });
  });

  it("executes whatsapp.history through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "whatsapp",
      "history",
      "--chat",
      "421900000000",
      "--connector",
      "main",
      "--direction",
      "all",
      "--limit",
      "10",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      source: "durable_panda_records",
      direction: "all",
      limit: 10,
      count: 2,
      chat: {
        connectorKey: "main",
        chatId: "421900000000@s.whatsapp.net",
        sessionId: "session-main",
      },
      items: [
        {
          id: "thread-message-whatsapp-1",
          direction: "inbound",
          threadId: "thread-main",
          messageId: "wa-1",
          actorId: "421900000000@s.whatsapp.net",
          remoteJid: "421900000000@s.whatsapp.net",
          chatType: "individual",
          pushName: "Alice",
          text: "WhatsApp launch note.",
          sentAt: "2026-06-25T12:00:00.000Z",
          createdAt: 40,
        },
        {
          id: "delivery-whatsapp-1",
          deliveryId: "delivery-whatsapp-1",
          direction: "outbound",
          status: "sent",
          threadId: "thread-main",
          items: [
            {
              type: "text",
              text: "WhatsApp ack.",
            },
          ],
          sentItems: [
            {
              type: "text",
              externalMessageId: "wa-2",
            },
          ],
          createdAt: 60,
          completedAt: 61,
        },
      ],
    });
  });

  it("executes whatsapp.send through native args", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-whatsapp-shim-"));
    directories.push(directory);
    const messagePath = path.join(directory, "message.md");
    const imagePath = path.join(directory, "image.png");
    await writeFile(messagePath, "hello whatsapp", "utf8");
    await writeFile(imagePath, "image", "utf8");

    const {stdout} = await execFileAsync(shimPath, [
      "whatsapp",
      "send",
      "--chat",
      "421900000000",
      "--connector",
      "main",
      "--text",
      `@${messagePath}`,
      "--image",
      imagePath,
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-outbound",
      to: {
        channel: "whatsapp",
        connectorKey: "main",
        conversationId: "421900000000@s.whatsapp.net",
      },
    });
  });

  it("executes telegram.react JSON payloads through the transport", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "react",
      "--json",
      '{"emoji":"🔥","messageId":"555","target":{"connectorKey":"telegram-main","conversationId":"1615376408"}}',
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      messageId: "555",
      added: "🔥",
      queued: true,
    });
  });

  it("executes telegram.react through native args", async () => {
    const server = await startWatchServer();

    const added = await execFileAsync(shimPath, [
      "telegram",
      "react",
      "555",
      "--emoji",
      "🔥",
      "--chat",
      "1615376408",
      "--connector",
      "telegram-main",
    ], {
      env: shimEnv(server),
    });
    const removed = await execFileAsync(shimPath, [
      "telegram",
      "react",
      "555",
      "--remove",
      "--chat",
      "1615376408",
      "--connector",
      "telegram-main",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(added.stdout)).toEqual({
      ok: true,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      messageId: "555",
      added: "🔥",
      queued: true,
    });
    expect(JSON.parse(removed.stdout)).toEqual({
      ok: true,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      messageId: "555",
      removed: true,
      queued: true,
    });
  });

  it("executes telegram.edit through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "edit",
      "555",
      "--text",
      "updated",
      "--chat",
      "1615376408",
      "--connector",
      "telegram-main",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      messageId: "555",
      edited: true,
      queued: true,
    });
  });

  it("executes telegram.delete through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "delete",
      "555",
      "--chat",
      "1615376408",
      "--connector",
      "telegram-main",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      messageId: "555",
      deleted: true,
      queued: true,
    });
  });

  it("executes telegram.pin through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "pin",
      "555",
      "--chat",
      "1615376408",
      "--connector",
      "telegram-main",
      "--silent",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      messageId: "555",
      pinned: true,
      queued: true,
    });
  });

  it("executes telegram.unpin through native args", async () => {
    const server = await startWatchServer();

    const {stdout} = await execFileAsync(shimPath, [
      "telegram",
      "unpin",
      "555",
      "--chat",
      "1615376408",
      "--connector",
      "telegram-main",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      messageId: "555",
      unpinned: true,
      queued: true,
    });
  });

  it("executes env commands through JSON, stdin, and file-shaped CLI forms", async () => {
    const server = await startWatchServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-env-shim-"));
    directories.push(directory);
    const secretPath = path.join(directory, "secret.txt");
    await writeFile(secretPath, "file-secret", "utf8");

    const list = await execFileAsync(shimPath, [
      "env",
      "list",
      "--prefix",
      "OPENAI_",
    ], {
      env: shimEnv(server),
    });
    const set = await execFileAsync("bash", [
      "-c",
      "printf '%s' secret-value | \"$1\" env set GITHUB_TOKEN --stdin",
      "bash",
      shimPath,
    ], {
      env: shimEnv(server),
    });
    const setFromFile = await execFileAsync(shimPath, [
      "env",
      "set",
      "OPENAI_API_KEY",
      "--from-file",
      secretPath,
    ], {
      env: shimEnv(server),
    });
    const clear = await execFileAsync(shimPath, [
      "env",
      "clear",
      "GITHUB_TOKEN",
    ], {
      env: shimEnv(server),
    });

    expect(JSON.parse(list.stdout)).toEqual({
      ok: true,
      count: 1,
      prefix: "OPENAI_",
      credentials: [{
        envKey: "OPENAI_API_KEY",
        keyVersion: 2,
        createdAt: 3,
        updatedAt: 4,
      }],
    });
    expect(JSON.parse(set.stdout)).toEqual({
      ok: true,
      envKey: "GITHUB_TOKEN",
      valueLength: 12,
    });
    expect(JSON.parse(setFromFile.stdout)).toEqual({
      ok: true,
      envKey: "OPENAI_API_KEY",
      valueLength: 11,
    });
    expect(JSON.parse(clear.stdout)).toEqual({
      ok: true,
      action: "clear",
      envKey: "GITHUB_TOKEN",
      agentKey: "panda",
      deleted: true,
    });
  });
});
