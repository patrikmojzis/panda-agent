import {randomUUID} from "node:crypto";
import process from "node:process";
import path from "node:path";
import {mkdir} from "node:fs/promises";

import {Command, InvalidArgumentError} from "commander";

import {PANDA_DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {createPandaPool, requirePandaDatabaseUrl} from "../../app/runtime/create-runtime.js";
import {resolvePandaAgentDir} from "../../app/runtime/data-dir.js";
import {CredentialService, PostgresCredentialStore, resolveCredentialCrypto} from "../credentials/index.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/index.js";
import {parseIdentityHandle} from "../identity/cli.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {PostgresSessionStore} from "../sessions/index.js";
import {
  discoverLegacyAgentSourceDirs,
  type ImportedLegacyAgentResult,
  importLegacyAgent,
  type LegacyAgentImportPlan,
  planLegacyAgentImport,
} from "./legacy-import.js";
import {PostgresAgentStore} from "./postgres.js";
import {DEFAULT_AGENT_DOCUMENT_TEMPLATES} from "./templates.js";
import {normalizeAgentKey} from "./types.js";

interface AgentCliOptions {
  dbUrl?: string;
}

interface CreateAgentCliOptions extends AgentCliOptions {
  name?: string;
}

interface PairAgentCliOptions extends AgentCliOptions {}

interface ImportLegacyAgentCliOptions extends AgentCliOptions {
  dryRun?: boolean;
  identity?: string;
  includeMessages?: boolean;
}

async function withAgentStores<T>(
  options: AgentCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    identityStore: PostgresIdentityStore;
    sessionStore: PostgresSessionStore;
    threadStore: PostgresThreadRuntimeStore;
  }) => Promise<T>,
): Promise<T> {
  const pool = createPandaPool(requirePandaDatabaseUrl(options.dbUrl));
  const identityStore = new PostgresIdentityStore({pool});
  const agentStore = new PostgresAgentStore({pool});
  const sessionStore = new PostgresSessionStore({pool});
  const threadStore = new PostgresThreadRuntimeStore({pool, identityStore});

  try {
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await sessionStore.ensureSchema();
    await threadStore.ensureSchema();
    return await fn({agentStore, identityStore, sessionStore, threadStore});
  } finally {
    await pool.end();
  }
}

async function withLegacyImportStores<T>(
  options: AgentCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    credentialService: CredentialService | null;
    identityStore: PostgresIdentityStore;
    sessionStore: PostgresSessionStore;
    threadStore: PostgresThreadRuntimeStore;
  }) => Promise<T>,
): Promise<T> {
  const pool = createPandaPool(requirePandaDatabaseUrl(options.dbUrl));
  const identityStore = new PostgresIdentityStore({pool});
  const agentStore = new PostgresAgentStore({pool});
  const sessionStore = new PostgresSessionStore({pool});
  const threadStore = new PostgresThreadRuntimeStore({pool, identityStore});
  const credentialStore = new PostgresCredentialStore({pool});

  try {
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await sessionStore.ensureSchema();
    await threadStore.ensureSchema();
    await credentialStore.ensureSchema();
    const crypto = resolveCredentialCrypto();
    const credentialService = crypto
      ? new CredentialService({
        store: credentialStore,
        crypto,
      })
      : null;
    return await fn({agentStore, credentialService, identityStore, sessionStore, threadStore});
  } finally {
    await pool.end();
  }
}

export function parseAgentKey(value: string): string {
  try {
    return normalizeAgentKey(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidArgumentError(error.message);
    }

    throw error;
  }
}

export async function listAgentsCommand(options: AgentCliOptions): Promise<void> {
  await withAgentStores(options, async ({agentStore, sessionStore}) => {
    const agents = await agentStore.listAgents();

    if (agents.length === 0) {
      process.stdout.write("No agents yet.\n");
      return;
    }

    for (const agent of agents) {
      const sessions = await sessionStore.listAgentSessions(agent.agentKey);
      const main = sessions.find((session) => session.kind === "main");
      process.stdout.write(
        [
          agent.agentKey,
          `  name ${agent.displayName} · status ${agent.status} · created ${new Date(agent.createdAt).toISOString()}`,
          `  main session ${main?.id ?? "-"}`,
        ].join("\n") + "\n\n",
      );
    }
  });
}

export async function createAgentCommand(agentKey: string, options: CreateAgentCliOptions): Promise<void> {
  await withAgentStores(options, async ({agentStore, sessionStore, threadStore}) => {
    const created = await agentStore.bootstrapAgent({
      agentKey,
      displayName: options.name?.trim() || agentKey,
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    const agentHome = resolvePandaAgentDir(created.agentKey);

    const sessionId = randomUUID();
    const threadId = randomUUID();
    await sessionStore.createSession({
      id: sessionId,
      agentKey: created.agentKey,
      kind: "main",
      currentThreadId: threadId,
    });
    await threadStore.createThread({
      id: threadId,
      sessionId,
      context: {
        agentKey: created.agentKey,
        sessionId,
        cwd: agentHome,
      },
    });

    await mkdir(agentHome, {recursive: true});

    process.stdout.write(
      [
        `Created agent ${created.agentKey}.`,
        `name ${created.displayName}`,
        `main session ${sessionId}`,
        `initial thread ${threadId}`,
        `home ${agentHome}`,
      ].join("\n") + "\n",
    );
  });
}

async function pairAgentCommand(
  agentKey: string,
  identityHandle: string,
  options: PairAgentCliOptions,
): Promise<void> {
  await withAgentStores(options, async ({agentStore, identityStore}) => {
    const identity = await identityStore.getIdentityByHandle(identityHandle);
    await agentStore.getAgent(agentKey);
    const pairing = await agentStore.ensurePairing(agentKey, identity.id);
    process.stdout.write(
      [
        `Paired ${identity.handle} with ${pairing.agentKey}.`,
        `identity ${pairing.identityId}`,
      ].join("\n") + "\n",
    );
  });
}

async function unpairAgentCommand(
  agentKey: string,
  identityHandle: string,
  options: PairAgentCliOptions,
): Promise<void> {
  await withAgentStores(options, async ({agentStore, identityStore}) => {
    const identity = await identityStore.getIdentityByHandle(identityHandle);
    const deleted = await agentStore.deletePairing(agentKey, identity.id);
    process.stdout.write(
      `${deleted ? "Removed" : "No"} pairing for ${identity.handle} and ${agentKey}.\n`,
    );
  });
}

async function listPairingsCommand(agentKey: string, options: PairAgentCliOptions): Promise<void> {
  await withAgentStores(options, async ({agentStore, identityStore}) => {
    const pairings = await agentStore.listAgentPairings(agentKey);
    if (pairings.length === 0) {
      process.stdout.write(`No pairings for ${agentKey}.\n`);
      return;
    }

    for (const pairing of pairings) {
      const identity = await identityStore.getIdentity(pairing.identityId);
      process.stdout.write(`${identity.handle} (${pairing.identityId})\n`);
    }
  });
}

function renderPromptSummary(plan: LegacyAgentImportPlan): string {
  return plan.prompts.map((prompt) => {
    if (!prompt.sourcePath) {
      return `${prompt.slug} (generated/default)`;
    }

    return `${prompt.slug} (${path.basename(prompt.sourcePath)})`;
  }).join(", ");
}

function renderMemorySummary(plan: LegacyAgentImportPlan): string {
  if (!plan.memory) {
    return "-";
  }

  return plan.memory.sourcePaths.map((sourcePath) => path.basename(sourcePath)).join(" + ");
}

function renderLegacyPlan(plan: LegacyAgentImportPlan, options: {identityHandle?: string; includeMessages?: boolean} = {}): string {
  return [
    `${plan.agentKey}`,
    `  name ${plan.displayName}`,
    `  source ${plan.sourceDir}`,
    ...(options.identityHandle ? [`  identity ${options.identityHandle}`] : []),
    `  prompts ${renderPromptSummary(plan)}`,
    `  memory ${renderMemorySummary(plan)}`,
    `  diary ${plan.diary.length} merged day entries`,
    ...(options.includeMessages ? [`  messages ${plan.messages.length}`] : []),
    `  skills ${plan.skills.length}`,
    `  credentials ${plan.credentials.length}`,
    `  legacy copy ${plan.legacyCopyDir}`,
    ...plan.warnings.map((warning) => `  warning ${warning}`),
  ].join("\n");
}

function renderLegacyImportResult(
  result: ImportedLegacyAgentResult,
  options: {identityHandle?: string; includeMessages?: boolean} = {},
): string {
  return [
    `Imported ${result.agentKey}.`,
    `name ${result.displayName}`,
    `source ${result.sourceDir}`,
    `home ${result.homeDir}`,
    `legacy copy ${result.legacyCopyDir}`,
    `agent created ${result.createdAgent ? "yes" : "no"}`,
    `main session created ${result.createdMainSession ? "yes" : "no"}`,
    ...(options.identityHandle ? [`identity ${options.identityHandle} (${result.identityId ?? "unresolved"})`] : []),
    `prompts ${result.promptCount}`,
    `memory ${result.importedMemory ? "yes" : "no"}`,
    `diary entries ${result.diaryEntryCount}`,
    ...(options.includeMessages ? [`messages imported ${result.messageCount}`] : []),
    `skills ${result.skillCount}`,
    `credentials imported ${result.credentialCount}`,
    `credentials skipped ${result.skippedCredentialCount}`,
    ...result.warnings.map((warning) => `warning ${warning}`),
  ].join("\n");
}

async function importLegacyCommand(sourcePath: string, options: ImportLegacyAgentCliOptions): Promise<void> {
  const sourceDirs = await discoverLegacyAgentSourceDirs(sourcePath);
  if (sourceDirs.length === 0) {
    throw new Error(`No OpenClaw agents found under ${path.resolve(sourcePath)}.`);
  }

  const plans = await Promise.all(sourceDirs.map((dir) => {
    return planLegacyAgentImport(dir, {
      env: process.env,
      includeMessages: options.includeMessages,
    });
  }));

  if (options.dryRun) {
    process.stdout.write(
      [
        `Discovered ${plans.length} OpenClaw agent${plans.length === 1 ? "" : "s"}.`,
        "",
        ...plans.map((plan) => renderLegacyPlan(plan, {
          identityHandle: options.identity,
          includeMessages: options.includeMessages,
        })),
        "",
        "Dry run only. No database writes happened.",
      ].join("\n") + "\n",
    );
    return;
  }

  await withLegacyImportStores(options, async ({
    agentStore,
    credentialService,
    identityStore,
    sessionStore,
    threadStore,
  }) => {
    const identityId = options.identity
      ? (await identityStore.getIdentityByHandle(options.identity)).id
      : undefined;
    const results: ImportedLegacyAgentResult[] = [];
    for (const plan of plans) {
      results.push(await importLegacyAgent(plan, {
        agentStore,
        credentialService: credentialService ?? undefined,
        identityId,
        includeMessages: options.includeMessages,
        sessionStore,
        threadStore,
      }));
    }

    process.stdout.write(results.map((result) => renderLegacyImportResult(result, {
      identityHandle: options.identity,
      includeMessages: options.includeMessages,
    })).join("\n\n") + "\n");
  });
}

export function registerAgentCommands(program: Command): void {
  const agentProgram = program
    .command("agent")
    .description("Manage Panda agents");

  agentProgram
    .command("list")
    .description("List stored Panda agents")
    .option("--db-url <url>", PANDA_DB_URL_OPTION_DESCRIPTION)
    .action((options: AgentCliOptions) => {
      return listAgentsCommand(options);
    });

  agentProgram
    .command("create")
    .description("Create a Panda agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--name <displayName>", "Display name to show in UIs")
    .option("--db-url <url>", PANDA_DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: CreateAgentCliOptions) => {
      return createAgentCommand(agentKey, options);
    });

  agentProgram
    .command("pair")
    .description("Pair an identity with an agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("<identityHandle>", "Identity handle")
    .option("--db-url <url>", PANDA_DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, identityHandle: string, options: PairAgentCliOptions) => {
      return pairAgentCommand(agentKey, identityHandle, options);
    });

  agentProgram
    .command("unpair")
    .description("Remove an identity pairing from an agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("<identityHandle>", "Identity handle")
    .option("--db-url <url>", PANDA_DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, identityHandle: string, options: PairAgentCliOptions) => {
      return unpairAgentCommand(agentKey, identityHandle, options);
    });

  agentProgram
    .command("pairings")
    .description("List identities paired to an agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--db-url <url>", PANDA_DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: PairAgentCliOptions) => {
      return listPairingsCommand(agentKey, options);
    });

  agentProgram
    .command("import-openclaw")
    .description("Import OpenClaw agents into Panda")
    .argument("<sourcePath>", "OpenClaw agent directory or parent directory containing agent folders")
    .option("--dry-run", "Show the migration plan without writing to Postgres")
    .option("--identity <handle>", "Identity handle to scope memory, diary, credentials, and imported user messages", parseIdentityHandle)
    .option("--include-messages", "Import lossy legacy user/assistant transcript pairs into the main Panda thread")
    .option("--db-url <url>", PANDA_DB_URL_OPTION_DESCRIPTION)
    .action((sourcePath: string, options: ImportLegacyAgentCliOptions) => {
      return importLegacyCommand(sourcePath, options);
    });
}
