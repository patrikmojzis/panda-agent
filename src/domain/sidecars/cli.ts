import process from "node:process";
import {readFile} from "node:fs/promises";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {ensureSchemas, withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {parseAgentKey} from "../agents/cli.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {PostgresSidecarRepo} from "./repo.js";
import {
  normalizeSidecarKey,
  normalizeSidecarTriggers,
  type SidecarDefinitionRecord,
} from "./types.js";

interface SidecarCliOptions {
  dbUrl?: string;
}

interface SetSidecarCliOptions extends SidecarCliOptions {
  disabled?: boolean;
  model?: string;
  name?: string;
  prompt?: string;
  promptFile?: string;
  thinking?: SidecarDefinitionRecord["thinking"];
  trigger?: string[];
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function parseSidecarKey(value: string): string {
  try {
    return normalizeSidecarKey(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidArgumentError(error.message);
    }

    throw error;
  }
}

async function readPrompt(options: Pick<SetSidecarCliOptions, "prompt" | "promptFile">): Promise<string> {
  if (options.prompt && options.promptFile) {
    throw new Error("Pick one prompt source: --prompt or --prompt-file.");
  }
  if (options.prompt) {
    return options.prompt;
  }
  if (options.promptFile) {
    return readFile(options.promptFile, "utf8");
  }

  throw new Error("Sidecar set requires --prompt or --prompt-file.");
}

async function withSidecarStores<T>(
  options: SidecarCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    sidecarRepo: PostgresSidecarRepo;
  }) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const sidecarRepo = new PostgresSidecarRepo({pool});
    await ensureSchemas([identityStore, agentStore, sidecarRepo]);
    return fn({agentStore, sidecarRepo});
  });
}

function renderSidecar(record: SidecarDefinitionRecord): string {
  return [
    `${record.agentKey}/${record.sidecarKey}`,
    `  name ${record.displayName}`,
    `  enabled ${record.enabled ? "yes" : "no"}`,
    `  triggers ${record.triggers.join(", ")}`,
    `  toolset ${record.toolset}`,
    ...(record.model ? [`  model ${record.model}`] : []),
    ...(record.thinking ? [`  thinking ${record.thinking}`] : []),
    `  updated ${new Date(record.updatedAt).toISOString()}`,
  ].join("\n");
}

export async function listSidecarsCommand(agentKey: string, options: SidecarCliOptions): Promise<void> {
  await withSidecarStores(options, async ({agentStore, sidecarRepo}) => {
    const agent = await agentStore.getAgent(agentKey);
    const sidecars = await sidecarRepo.listAgentDefinitions(agent.agentKey);
    if (sidecars.length === 0) {
      process.stdout.write(`No sidecars for ${agent.agentKey}.\n`);
      return;
    }

    process.stdout.write(`${sidecars.map(renderSidecar).join("\n\n")}\n`);
  });
}

export async function setSidecarCommand(
  agentKey: string,
  sidecarKey: string,
  options: SetSidecarCliOptions,
): Promise<void> {
  await withSidecarStores(options, async ({agentStore, sidecarRepo}) => {
    const agent = await agentStore.getAgent(agentKey);
    const triggers = normalizeSidecarTriggers(options.trigger ?? []);
    const sidecar = await sidecarRepo.upsertDefinition({
      agentKey: agent.agentKey,
      sidecarKey,
      displayName: options.name,
      enabled: options.disabled === true ? false : true,
      prompt: await readPrompt(options),
      triggers,
      model: options.model,
      thinking: options.thinking,
      toolset: "readonly",
    });

    process.stdout.write(`Saved sidecar ${sidecar.agentKey}/${sidecar.sidecarKey}. enabled ${sidecar.enabled ? "yes" : "no"} triggers ${sidecar.triggers.join(", ")}\n`);
  });
}

export async function setSidecarEnabledCommand(
  agentKey: string,
  sidecarKey: string,
  enabled: boolean,
  options: SidecarCliOptions,
): Promise<void> {
  await withSidecarStores(options, async ({agentStore, sidecarRepo}) => {
    const agent = await agentStore.getAgent(agentKey);
    const sidecar = await sidecarRepo.setEnabled(agent.agentKey, sidecarKey, enabled);
    process.stdout.write(`${enabled ? "Enabled" : "Disabled"} sidecar ${sidecar.agentKey}/${sidecar.sidecarKey}.\n`);
  });
}

export async function deleteSidecarCommand(
  agentKey: string,
  sidecarKey: string,
  options: SidecarCliOptions,
): Promise<void> {
  await withSidecarStores(options, async ({agentStore, sidecarRepo}) => {
    const agent = await agentStore.getAgent(agentKey);
    const deleted = await sidecarRepo.deleteDefinition(agent.agentKey, sidecarKey);
    process.stdout.write(deleted
      ? `Deleted sidecar ${agent.agentKey}/${sidecarKey}.\n`
      : `No sidecar ${agent.agentKey}/${sidecarKey} existed.\n`);
  });
}

export function registerSidecarCommands(program: Command): void {
  const sidecar = program
    .command("sidecar")
    .description("Manage per-agent sidecar agents");

  sidecar
    .command("list")
    .description("List sidecars for an agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: SidecarCliOptions) => {
      return listSidecarsCommand(agentKey, options);
    });

  sidecar
    .command("set")
    .description("Create or replace a sidecar definition")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("<sidecarKey>", "Sidecar key", parseSidecarKey)
    .option("--trigger <trigger>", "Trigger event; repeat for more", collectOption, [])
    .option("--prompt <text>", "Sidecar system prompt")
    .option("--prompt-file <path>", "Read sidecar system prompt from a file")
    .option("--name <name>", "Display name")
    .option("--model <selector>", "Model selector override")
    .option("--thinking <level>", "Thinking level override")
    .option("--disabled", "Save the sidecar inactive")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, sidecarKey: string, options: SetSidecarCliOptions) => {
      return setSidecarCommand(agentKey, sidecarKey, options);
    });

  sidecar
    .command("enable")
    .description("Enable a sidecar")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("<sidecarKey>", "Sidecar key", parseSidecarKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, sidecarKey: string, options: SidecarCliOptions) => {
      return setSidecarEnabledCommand(agentKey, sidecarKey, true, options);
    });

  sidecar
    .command("disable")
    .description("Disable a sidecar")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("<sidecarKey>", "Sidecar key", parseSidecarKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, sidecarKey: string, options: SidecarCliOptions) => {
      return setSidecarEnabledCommand(agentKey, sidecarKey, false, options);
    });

  sidecar
    .command("delete")
    .description("Delete a sidecar definition")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("<sidecarKey>", "Sidecar key", parseSidecarKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, sidecarKey: string, options: SidecarCliOptions) => {
      return deleteSidecarCommand(agentKey, sidecarKey, options);
    });
}
