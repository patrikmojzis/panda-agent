import {randomUUID} from "node:crypto";
import process from "node:process";
import path from "node:path";
import {mkdir} from "node:fs/promises";

import {Command, InvalidArgumentError} from "commander";
import type {Pool} from "pg";

import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {ensureSchemas, withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {resolveAgentDir} from "../../app/runtime/data-dir.js";
import {CredentialService, PostgresCredentialStore, resolveCredentialCrypto} from "../credentials/index.js";
import {isMissingThreadError, PostgresThreadRuntimeStore} from "../threads/runtime/index.js";
import {parseIdentityHandle} from "../identity/cli.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {createSessionWithInitialThread, PostgresSessionStore, resetSessionCurrentThread} from "../sessions/index.js";
import {isMissingAgentError} from "./errors.js";
import {
    discoverLegacyAgentSourceDirs,
    type ImportedLegacyAgentResult,
    importLegacyAgent,
    type LegacyAgentImportPlan,
    planLegacyAgentImport,
} from "./legacy-import.js";
import {PostgresAgentStore} from "./postgres.js";
import {DEFAULT_AGENT_PROMPT_TEMPLATES} from "../../prompts/templates/agent-prompts.js";
import {type AgentRecord, normalizeAgentKey} from "./types.js";

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

interface AgentCliStores {
  pool: Pool;
  agentStore: PostgresAgentStore;
  identityStore: PostgresIdentityStore;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
}

export interface EnsureAgentResult {
  agentKey: string;
  displayName: string;
  createdAgent: boolean;
  createdMainSession: boolean;
  createdMainThread: boolean;
  sessionId: string;
  threadId: string;
  homeDir: string;
}

function createAgentCliStores(pool: Pool): AgentCliStores {
  const identityStore = new PostgresIdentityStore({pool});
  return {
    pool,
    agentStore: new PostgresAgentStore({pool}),
    identityStore,
    sessionStore: new PostgresSessionStore({pool}),
    threadStore: new PostgresThreadRuntimeStore({pool}),
  };
}

async function withAgentStores<T>(
  options: AgentCliOptions,
  fn: (stores: AgentCliStores) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores = createAgentCliStores(pool);
    await ensureSchemas([
      stores.identityStore,
      stores.agentStore,
      stores.sessionStore,
      stores.threadStore,
    ]);
    return fn(stores);
  });
}

async function withLegacyImportStores<T>(
  options: AgentCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    credentialService: CredentialService | null;
    identityStore: PostgresIdentityStore;
    pool: Pool;
    sessionStore: PostgresSessionStore;
    threadStore: PostgresThreadRuntimeStore;
  }) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores = createAgentCliStores(pool);
    const credentialStore = new PostgresCredentialStore({pool});
    await ensureSchemas([
      stores.identityStore,
      stores.agentStore,
      stores.sessionStore,
      stores.threadStore,
      credentialStore,
    ]);
    const crypto = resolveCredentialCrypto();
    const credentialService = crypto
      ? new CredentialService({
        store: credentialStore,
        crypto,
      })
      : null;
    return fn({
      ...stores,
      credentialService,
    });
  });
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

function buildMainThreadContext(agentKey: string, sessionId: string, env: NodeJS.ProcessEnv): {
  agentKey: string;
  sessionId: string;
  cwd: string;
} {
  return {
    agentKey,
    sessionId,
    cwd: resolveAgentDir(agentKey, env),
  };
}

async function createMainSessionThread(
  stores: Pick<AgentCliStores, "sessionStore" | "threadStore"> & {pool?: Pool},
  agentKey: string,
  env: NodeJS.ProcessEnv,
): Promise<{sessionId: string; threadId: string}> {
  const sessionId = randomUUID();
  const threadId = randomUUID();
  if (stores.pool) {
    await createSessionWithInitialThread({
      pool: stores.pool,
      sessionStore: stores.sessionStore,
      threadStore: stores.threadStore,
      session: {
        id: sessionId,
        agentKey,
        kind: "main",
        currentThreadId: threadId,
      },
      thread: {
        id: threadId,
        sessionId,
        context: buildMainThreadContext(agentKey, sessionId, env),
      },
    });
  } else {
    await stores.sessionStore.createSession({
      id: sessionId,
      agentKey,
      kind: "main",
      currentThreadId: threadId,
    });
    await stores.threadStore.createThread({
      id: threadId,
      sessionId,
      context: buildMainThreadContext(agentKey, sessionId, env),
    });
  }
  return {sessionId, threadId};
}

export async function ensureAgent(
  stores: Pick<AgentCliStores, "agentStore" | "sessionStore" | "threadStore"> & {pool?: Pool},
  agentKey: string,
  options: {name?: string; env?: NodeJS.ProcessEnv} = {},
): Promise<EnsureAgentResult> {
  const normalizedAgentKey = normalizeAgentKey(agentKey);
  const env = options.env ?? process.env;
  let createdAgent = false;
  let createdMainSession = false;
  let createdMainThread = false;

  let agent: AgentRecord;
  try {
    agent = await stores.agentStore.getAgent(normalizedAgentKey);
  } catch (error) {
    if (!isMissingAgentError(error, normalizedAgentKey)) {
      throw error;
    }

    agent = await stores.agentStore.bootstrapAgent({
      agentKey: normalizedAgentKey,
      displayName: options.name?.trim() || normalizedAgentKey,
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    createdAgent = true;
  }

  const homeDir = resolveAgentDir(agent.agentKey, env);
  await mkdir(homeDir, {recursive: true});

  const mainSession = await stores.sessionStore.getMainSession(agent.agentKey);
  let sessionId: string;
  let threadId: string;

  if (!mainSession) {
    const created = await createMainSessionThread(stores, agent.agentKey, env);
    sessionId = created.sessionId;
    threadId = created.threadId;
    createdMainSession = true;
    createdMainThread = true;
  } else {
    sessionId = mainSession.id;
    threadId = mainSession.currentThreadId;

    try {
      await stores.threadStore.getThread(threadId);
    } catch (error) {
      if (!isMissingThreadError(error, threadId)) {
        throw error;
      }

      threadId = randomUUID();
      if (stores.pool) {
        await resetSessionCurrentThread({
          pool: stores.pool,
          sessionStore: stores.sessionStore,
          threadStore: stores.threadStore,
          thread: {
            id: threadId,
            sessionId,
            context: buildMainThreadContext(agent.agentKey, sessionId, env),
          },
          session: {
            sessionId,
            currentThreadId: threadId,
          },
        });
      } else {
        await stores.threadStore.createThread({
          id: threadId,
          sessionId,
          context: buildMainThreadContext(agent.agentKey, sessionId, env),
        });
        await stores.sessionStore.updateCurrentThread({
          sessionId,
          currentThreadId: threadId,
        });
      }
      createdMainThread = true;
    }
  }

  return {
    agentKey: agent.agentKey,
    displayName: agent.displayName,
    createdAgent,
    createdMainSession,
    createdMainThread,
    sessionId,
    threadId,
    homeDir,
  };
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
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    const agentHome = resolveAgentDir(created.agentKey);
    const {sessionId, threadId} = await createMainSessionThread(
      {sessionStore, threadStore},
      created.agentKey,
      process.env,
    );
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

export async function ensureAgentCommand(agentKey: string, options: CreateAgentCliOptions): Promise<void> {
  await withAgentStores(options, async ({agentStore, sessionStore, threadStore}) => {
    const ensured = await ensureAgent(
      {agentStore, sessionStore, threadStore},
      agentKey,
      {name: options.name, env: process.env},
    );

    process.stdout.write(
      [
        `Ensured agent ${ensured.agentKey}.`,
        `name ${ensured.displayName}`,
        `agent created ${ensured.createdAgent ? "yes" : "no"}`,
        `main session created ${ensured.createdMainSession ? "yes" : "no"}`,
        `main thread created ${ensured.createdMainThread ? "yes" : "no"}`,
        `main session ${ensured.sessionId}`,
        `current thread ${ensured.threadId}`,
        `home ${ensured.homeDir}`,
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

function renderLegacyPlan(plan: LegacyAgentImportPlan, options: {identityHandle?: string; includeMessages?: boolean} = {}): string {
  return [
    `${plan.agentKey}`,
    `  name ${plan.displayName}`,
    `  source ${plan.sourceDir}`,
    ...(options.identityHandle ? [`  identity ${options.identityHandle}`] : []),
    `  prompts ${renderPromptSummary(plan)}`,
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
    pool,
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
        pool,
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
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: AgentCliOptions) => {
      return listAgentsCommand(options);
    });

  agentProgram
    .command("create")
    .description("Create a Panda agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--name <displayName>", "Display name to show in UIs")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: CreateAgentCliOptions) => {
      return createAgentCommand(agentKey, options);
    });

  agentProgram
    .command("ensure")
    .description("Create a Panda agent if missing and repair its main session scaffold")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--name <displayName>", "Display name to use when the agent is created")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: CreateAgentCliOptions) => {
      return ensureAgentCommand(agentKey, options);
    });

  agentProgram
    .command("pair")
    .description("Pair an identity with an agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("<identityHandle>", "Identity handle")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, identityHandle: string, options: PairAgentCliOptions) => {
      return pairAgentCommand(agentKey, identityHandle, options);
    });

  agentProgram
    .command("unpair")
    .description("Remove an identity pairing from an agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .argument("<identityHandle>", "Identity handle")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, identityHandle: string, options: PairAgentCliOptions) => {
      return unpairAgentCommand(agentKey, identityHandle, options);
    });

  agentProgram
    .command("pairings")
    .description("List identities paired to an agent")
    .argument("<agentKey>", "Agent key", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: PairAgentCliOptions) => {
      return listPairingsCommand(agentKey, options);
    });

  agentProgram
    .command("import-openclaw")
    .description("Import OpenClaw agents into Panda")
    .argument("<sourcePath>", "OpenClaw agent directory or parent directory containing agent folders")
    .option("--dry-run", "Show the migration plan without writing to Postgres")
    .option("--identity <handle>", "Identity handle to scope credentials and imported user messages", parseIdentityHandle)
    .option("--include-messages", "Import lossy legacy user/assistant transcript pairs into the main Panda thread")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sourcePath: string, options: ImportLegacyAgentCliOptions) => {
      return importLegacyCommand(sourcePath, options);
    });
}
