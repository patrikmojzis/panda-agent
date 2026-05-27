#!/usr/bin/env tsx
import {createHash} from "node:crypto";
import {readdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import type {Tool} from "../../src/kernel/agent/tool.js";
import {createDefaultAgentToolRegistry, buildDefaultAgentToolsetsFromRegistry} from "../../src/panda/definition.js";
import {
  DEFAULT_WORKER_ALLOWED_TOOL_NAMES,
  KNOWN_WORKER_TOOL_NAMES,
  POSTGRES_READONLY_TOOL_NAME,
  WORKER_CONTROL_TOOL_NAMES,
  buildDefaultWorkerAllowedTools,
} from "../../src/panda/worker-tool-policy.js";
import {AgentPromptTool} from "../../src/panda/tools/agent-prompt-tool.js";
import {AgentSkillTool} from "../../src/panda/tools/agent-skill-tool.js";
import {
  AppActionTool,
  AppCheckTool,
  AppCreateTool,
  AppLinkCreateTool,
  AppListTool,
  AppViewTool,
} from "../../src/panda/tools/app-tools.js";
import {ClearEnvValueTool, SetEnvValueTool} from "../../src/panda/tools/env-value-tools.js";
import {EmailSendTool} from "../../src/panda/tools/email-send-tool.js";
import {EnvironmentCreateTool, EnvironmentStopTool, WorkerSpawnTool} from "../../src/panda/tools/worker-tools.js";
import {MessageAgentTool} from "../../src/panda/tools/message-agent-tool.js";
import {OutboundTool} from "../../src/panda/tools/outbound-tool.js";
import {
  ScheduledTaskCancelTool,
  ScheduledTaskCreateTool,
  ScheduledTaskUpdateTool,
} from "../../src/panda/tools/scheduled-task-tools.js";
import {SpawnSubagentTool} from "../../src/panda/tools/spawn-subagent-tool.js";
import {ThinkingSetTool} from "../../src/panda/tools/thinking-set-tool.js";
import {
  WatchCreateTool,
  WatchDisableTool,
  WatchSchemaGetTool,
  WatchUpdateTool,
} from "../../src/panda/tools/watch-tools.js";
import {WikiTool} from "../../src/panda/tools/wiki-tool.js";
import {TelegramReactTool} from "../../src/integrations/channels/telegram/telegram-react-tool.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const snapshotPath = path.join(repoRoot, "scripts/ci/prompt-contracts.snapshot.json");

const contractRoots = [
  "src/prompts",
  "src/panda/contexts",
];

const contractFiles = [
  "src/app/runtime/background-tool-thread-input.ts",
  "src/app/runtime/create-runtime.ts",
  "src/app/runtime/daemon-bootstrap.ts",
  "src/app/runtime/panda-path-context.ts",
  "src/app/runtime/panda-session-context.ts",
  "src/app/runtime/runtime-bootstrap.ts",
  "src/app/runtime/thread-definition.ts",
  "src/domain/subagents/builtins.ts",
  "src/domain/subagents/tool-groups.ts",
  "src/panda/defaults.ts",
  "src/panda/definition.ts",
  "src/panda/subagents/policy.ts",
  "src/panda/worker-tool-policy.ts",
];

interface ContractFileRecord {
  path: string;
  sha256: string;
  bytes: number;
  lines: number;
}

interface ToolContractRecord {
  name: string;
  description: string;
  parameters: unknown;
}

interface PromptContractSnapshot {
  version: 1;
  generatedBy: string;
  files: ContractFileRecord[];
  toolCatalog: ToolContractRecord[];
  toolsets: Record<string, string[]>;
  workerPolicy: {
    controlToolNames: string[];
    defaultAllowedToolNames: string[];
    defaultAllowedWithReadonlyPostgres: string[];
    knownToolNames: string[];
    postgresReadonlyToolName: string;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lineCount(value: string): number {
  if (!value) {
    return 0;
  }
  return value.endsWith("\n") ? value.split("\n").length - 1 : value.split("\n").length;
}

async function listTypescriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {withFileTypes: true});
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listTypescriptFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  }));
  return nested.flat();
}

function relativeToRepo(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

async function collectContractFilePaths(): Promise<string[]> {
  const rootFiles = (await Promise.all(
    contractRoots.map((root) => listTypescriptFiles(path.join(repoRoot, root))),
  )).flat();
  const explicitFiles = contractFiles.map((file) => path.join(repoRoot, file));
  return [...new Set([...rootFiles, ...explicitFiles].map(relativeToRepo))].toSorted();
}

async function snapshotFile(relativePath: string): Promise<ContractFileRecord> {
  const content = await readFile(path.join(repoRoot, relativePath), "utf8");
  return {
    path: relativePath,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content, "utf8"),
    lines: lineCount(content),
  };
}

function fakeService(): any {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }
      return async () => {
        throw new Error("Prompt contract snapshot fake service was called.");
      };
    },
  });
}

function mergeToolsByName(toolGroups: readonly (readonly Tool[])[]): readonly Tool[] {
  const seen = new Set<string>();
  const merged: Tool[] = [];
  for (const tools of toolGroups) {
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        continue;
      }
      seen.add(tool.name);
      merged.push(tool);
    }
  }
  return merged;
}

function toolNames(tools: readonly Tool[]): string[] {
  return tools.map((tool) => tool.name);
}

function snapshotTool(tool: Tool): ToolContractRecord {
  const piTool = tool.piTool;
  return {
    name: piTool.name,
    description: piTool.description,
    parameters: piTool.parameters,
  };
}

function collectTools(): {
  toolCatalog: ToolContractRecord[];
  toolsets: Record<string, string[]>;
} {
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  const previousBraveApiKey = process.env.BRAVE_API_KEY;
  process.env.OPENAI_API_KEY = "snapshot-openai-key";
  process.env.BRAVE_API_KEY = "BSA-snapshot-key";

  try {
    const service = fakeService();
    const jobService = fakeService();
    const postgresPool = fakeService();
    const registry = createDefaultAgentToolRegistry({
      bash: {
        jobService,
      },
      browser: {
        service,
      },
      imageGenerate: {
        env: process.env,
        jobService,
      },
      postgresReadonly: {
        pool: postgresPool,
      },
      webResearch: {
        env: process.env,
        jobService,
      },
    });

    const agentSkillTool = new AgentSkillTool({store: service});
    const wikiTool = new WikiTool({
      bindings: service,
      env: process.env,
    });
    const defaultToolsets = buildDefaultAgentToolsetsFromRegistry(
      registry,
      [],
      [wikiTool],
      [agentSkillTool],
      [agentSkillTool],
    );
    const mainExtras: Tool[] = [
      new ThinkingSetTool({
        persistence: service,
      }),
      new SpawnSubagentTool({
        service,
        jobService,
      }),
      new AgentPromptTool({
        store: service,
      }),
      new AppCreateTool(service),
      new AppListTool(service),
      new AppLinkCreateTool(service, service),
      new AppCheckTool(service),
      new AppViewTool(service),
      new AppActionTool(service),
      wikiTool,
      agentSkillTool,
      new SetEnvValueTool({
        service,
      }),
      new ClearEnvValueTool({
        service,
      }),
      new ScheduledTaskCreateTool({
        store: service,
      }),
      new ScheduledTaskUpdateTool({
        store: service,
      }),
      new ScheduledTaskCancelTool({
        store: service,
      }),
      new WatchCreateTool({
        mutations: service,
        store: service,
      }),
      new WatchSchemaGetTool(),
      new WatchUpdateTool({
        mutations: service,
        store: service,
      }),
      new WatchDisableTool({
        mutations: service,
        store: service,
      }),
    ];
    const runtimeMain = buildDefaultAgentToolsetsFromRegistry(registry, mainExtras).main;
    const runtimeWorker = mergeToolsByName([defaultToolsets.worker, runtimeMain]);
    const workerControl = [
      new EnvironmentCreateTool({
        lifecycle: service,
      }),
      new EnvironmentStopTool({
        environments: service,
        lifecycle: service,
      }),
      new WorkerSpawnTool({
        workerSessions: service,
        availableToolNames: () => toolNames(runtimeWorker),
      }),
    ];
    const daemonChannelExtras = [
      new EmailSendTool({
        store: service,
      }),
      new OutboundTool(),
      new MessageAgentTool(),
      new TelegramReactTool(),
    ];
    const allTools = mergeToolsByName([
      defaultToolsets.main,
      defaultToolsets.workspace,
      defaultToolsets.memory,
      defaultToolsets.browser,
      defaultToolsets.worker,
      defaultToolsets.skill_maintainer,
      runtimeMain,
      runtimeWorker,
      workerControl,
      daemonChannelExtras,
    ]);

    return {
      toolCatalog: allTools.map(snapshotTool).toSorted((left, right) => left.name.localeCompare(right.name)),
      toolsets: {
        defaultMain: toolNames(defaultToolsets.main),
        defaultWorkspace: toolNames(defaultToolsets.workspace),
        defaultMemory: toolNames(defaultToolsets.memory),
        defaultBrowser: toolNames(defaultToolsets.browser),
        defaultWorker: toolNames(defaultToolsets.worker),
        defaultSkillMaintainer: toolNames(defaultToolsets.skill_maintainer),
        runtimeMain: toolNames(runtimeMain),
        runtimeWorker: toolNames(runtimeWorker),
        workerControl: toolNames(workerControl),
        daemonChannelExtras: toolNames(daemonChannelExtras),
      },
    };
  } finally {
    if (previousOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }
    if (previousBraveApiKey === undefined) {
      delete process.env.BRAVE_API_KEY;
    } else {
      process.env.BRAVE_API_KEY = previousBraveApiKey;
    }
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

async function buildSnapshot(): Promise<PromptContractSnapshot> {
  const files = await Promise.all((await collectContractFilePaths()).map(snapshotFile));
  const tools = collectTools();
  return {
    version: 1,
    generatedBy: "scripts/ci/prompt-contracts.ts",
    files,
    ...tools,
    workerPolicy: {
      controlToolNames: [...WORKER_CONTROL_TOOL_NAMES].toSorted(),
      defaultAllowedToolNames: [...DEFAULT_WORKER_ALLOWED_TOOL_NAMES],
      defaultAllowedWithReadonlyPostgres: buildDefaultWorkerAllowedTools({
        allowReadonlyPostgres: true,
      }),
      knownToolNames: [...KNOWN_WORKER_TOOL_NAMES].toSorted(),
      postgresReadonlyToolName: POSTGRES_READONLY_TOOL_NAME,
    },
  };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const update = args.has("--update");
  const check = args.has("--check") || !update;
  const snapshot = stableJson(await buildSnapshot());

  if (update) {
    await writeFile(snapshotPath, snapshot);
    process.stdout.write(`Updated ${relativeToRepo(snapshotPath)}\n`);
    return;
  }

  if (check) {
    const expected = await readFile(snapshotPath, "utf8");
    if (expected !== snapshot) {
      process.stderr.write([
        "Prompt/tool contract snapshot is stale.",
        "Run `pnpm ci:prompt-contracts:update` and commit the updated snapshot.",
        "",
      ].join("\n"));
      process.exitCode = 1;
      return;
    }
    process.stdout.write("Prompt/tool contract snapshot is current.\n");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
