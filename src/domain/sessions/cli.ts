import {randomUUID} from "node:crypto";
import process from "node:process";

import {Command, InvalidArgumentError} from "commander";
import type {Pool} from "pg";

import {DB_URL_OPTION_DESCRIPTION, parsePositiveIntegerOption} from "../../lib/cli.js";
import {ensureSchemas, withPostgresPool} from "../../lib/postgres-bootstrap.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {normalizeAgentKey} from "../agents/types.js";
import {ConversationRepo} from "./conversations/repo.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/postgres.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {createSessionWithInitialThread} from "./lifecycle.js";
import {PostgresSessionStore} from "./postgres.js";
import {SESSION_BRIEFING_PROMPT_SLUG, normalizeSessionAlias, type SessionRecord} from "./types.js";

export interface SessionCliOptions {
  dbUrl?: string;
}

interface CreateSessionCliOptions extends SessionCliOptions {
  alias?: string;
  displayName?: string;
}

interface ScopedSessionRefCliOptions extends SessionCliOptions {
  agent?: string;
}

interface LabelCliOptions extends ScopedSessionRefCliOptions {
  alias?: string;
  displayName?: string;
  clearAlias?: boolean;
  clearDisplayName?: boolean;
}

interface HeartbeatCliOptions extends ScopedSessionRefCliOptions {
  enable?: boolean;
  disable?: boolean;
  every?: number;
}

interface SessionPromptCliOptions extends ScopedSessionRefCliOptions {
  content?: string;
  stdin?: boolean;
}

interface WithSessionStores {
  pool: Pool;
  agentStore: PostgresAgentStore;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  conversations: ConversationRepo;
}

export function createSessionCliStores(pool: Pool): WithSessionStores & {
  identityStore: PostgresIdentityStore;
} {
  const identityStore = new PostgresIdentityStore({pool});
  return {
    pool,
    agentStore: new PostgresAgentStore({pool}),
    identityStore,
    sessionStore: new PostgresSessionStore({pool}),
    threadStore: new PostgresThreadRuntimeStore({pool}),
    conversations: new ConversationRepo({pool}),
  };
}

export async function withSessionStores<T>(
  options: SessionCliOptions,
  fn: (stores: WithSessionStores) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores = createSessionCliStores(pool);
    await ensureSchemas([
      stores.identityStore,
      stores.agentStore,
      stores.sessionStore,
      stores.threadStore,
      stores.conversations,
    ]);
    return fn(stores);
  });
}

function normalizeSessionRef(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Session ref must not be empty.");
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new Error(
      "Session ref must use letters, numbers, hyphens, or underscores, and start with a letter or number.",
    );
  }

  return normalized;
}

function parseCliValue<T>(value: string, parser: (value: string) => T): T {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidArgumentError(error.message);
    }

    throw error;
  }
}

function parseCreateAgentKey(value: string): string {
  return parseCliValue(value, normalizeAgentKey);
}

function parseSessionRefArgument(value: string): string {
  return parseCliValue(value, normalizeSessionRef);
}

function parseSessionAliasOption(value: string): string {
  return parseCliValue(value, normalizeSessionAlias);
}

function parseDisplayNameOption(value: string): string {
  return parseCliValue(value, (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Session display name must not be empty.");
    }

    return trimmed;
  });
}

function parseAgentKeyOption(value: string): string {
  return parseCliValue(value, normalizeAgentKey);
}

function isUnknownSessionError(error: unknown, sessionId: string): boolean {
  return error instanceof Error && error.message === `Unknown session ${sessionId}`;
}

function isDuplicateSessionIdError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as {code?: unknown}).code;
    if (code === "23505") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("duplicate key");
}

function duplicateSessionRefError(sessionId: string): Error {
  return new Error(`Session ${sessionId} already exists. Pick a different session ref.`);
}

function duplicateSessionAliasError(agentKey: string, alias: string): Error {
  return new Error(`Session alias ${alias} already exists for agent ${agentKey}. Pick a different alias.`);
}

async function assertSessionIdAvailable(sessionStore: PostgresSessionStore, sessionId: string): Promise<void> {
  try {
    await sessionStore.getSession(sessionId);
  } catch (error) {
    if (isUnknownSessionError(error, sessionId)) {
      return;
    }

    throw error;
  }

  throw duplicateSessionRefError(sessionId);
}

async function assertSessionAliasAvailable(input: {
  sessionStore: PostgresSessionStore;
  agentKey: string;
  alias?: string;
  currentSessionId?: string;
}): Promise<void> {
  if (!input.alias) {
    return;
  }

  const existing = await input.sessionStore.getSessionByAlias(input.agentKey, input.alias);
  if (existing && existing.id !== input.currentSessionId) {
    throw duplicateSessionAliasError(input.agentKey, input.alias);
  }
}

async function resolveSessionCliRef(
  sessionStore: PostgresSessionStore,
  sessionRef: string,
  options: ScopedSessionRefCliOptions,
): Promise<SessionRecord> {
  return sessionStore.resolveSessionRef({
    sessionRef,
    agentKey: options.agent,
  });
}

async function readStdinText(): Promise<string> {
  const chunks: string[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  }

  return chunks.join("");
}

async function resolvePromptContent(
  positionalContent: string | undefined,
  options: SessionPromptCliOptions,
): Promise<string> {
  const inputPaths = [
    positionalContent !== undefined,
    options.content !== undefined,
    options.stdin === true,
  ].filter(Boolean).length;

  if (inputPaths > 1) {
    throw new Error("Pick one session prompt input path: positional content, --content, or --stdin.");
  }

  const content = options.stdin ? await readStdinText() : options.content ?? positionalContent;
  if (content === undefined) {
    throw new Error("Pass session prompt content as an argument, with --content, or pipe it with --stdin.");
  }

  if (!content.trim()) {
    throw new Error("Session prompt content must not be empty.");
  }

  return content;
}

function writePromptContent(content: string): void {
  process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
}

function buildSessionCreateOutput(input: {
  agentKey: string;
  sessionRef?: string;
  alias?: string;
  displayName?: string;
  sessionId: string;
  threadId: string;
}): string {
  return [
    "Created branch session.",
    `agent ${input.agentKey}`,
    ...(input.sessionRef ? [`ref ${input.sessionRef}`] : []),
    ...(input.alias ? [`alias ${input.alias}`] : []),
    ...(input.displayName ? [`displayName ${input.displayName}`] : []),
    `sessionId ${input.sessionId}`,
    `initialThread ${input.threadId}`,
    "",
    "Discord bind example:",
    `panda discord bind-channel --account <accountKey> --channel <discordChannelId> --session ${input.sessionId}`,
  ].join("\n") + "\n";
}

async function createSessionCommand(
  agentKey: string,
  sessionRef: string | undefined,
  options: CreateSessionCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({pool, agentStore, sessionStore, threadStore}) => {
    const agent = await agentStore.getAgent(agentKey);
    const normalizedRef = sessionRef ? normalizeSessionRef(sessionRef) : undefined;
    const sessionId = normalizedRef ? `${agent.agentKey}:${normalizedRef}` : randomUUID();
    const threadId = randomUUID();

    if (normalizedRef) {
      await assertSessionIdAvailable(sessionStore, sessionId);
    }
    await assertSessionAliasAvailable({
      sessionStore,
      agentKey: agent.agentKey,
      alias: options.alias,
    });

    try {
      await createSessionWithInitialThread({
        pool,
        sessionStore,
        threadStore,
        session: {
          id: sessionId,
          agentKey: agent.agentKey,
          kind: "branch",
          currentThreadId: threadId,
          alias: options.alias,
          displayName: options.displayName,
        },
        thread: {
          id: threadId,
          sessionId,
        },
      });
    } catch (error) {
      if (options.alias && isDuplicateSessionIdError(error)) {
        throw duplicateSessionAliasError(agent.agentKey, options.alias);
      }
      if (normalizedRef && isDuplicateSessionIdError(error)) {
        throw duplicateSessionRefError(sessionId);
      }

      throw error;
    }

    process.stdout.write(buildSessionCreateOutput({
      agentKey: agent.agentKey,
      sessionRef: normalizedRef,
      alias: options.alias,
      displayName: options.displayName,
      sessionId,
      threadId,
    }));
  });
}

async function listSessionsCommand(agentKey: string, options: SessionCliOptions): Promise<void> {
  await withSessionStores(options, async ({sessionStore}) => {
    const sessions = await sessionStore.listAgentSessions(agentKey);
    if (sessions.length === 0) {
      process.stdout.write(`No sessions for ${agentKey}.\n`);
      return;
    }

    const promptEntries = await Promise.all(sessions.map(async (session) => {
      return [session.id, await sessionStore.readSessionPrompt(session.id)] as const;
    }));
    const promptsBySessionId = new Map(promptEntries);

    for (const session of sessions) {
      process.stdout.write(
        [
          session.displayName ? `${session.displayName} (${session.id})` : session.id,
          ` alias ${session.alias ?? "-"} · kind ${session.kind} · current thread ${session.currentThreadId} · has brief ${promptsBySessionId.get(session.id) ? "yes" : "no"}`,
          ` created by ${session.createdByIdentityId ?? "-"}`,
        ].join("\n") + "\n\n",
      );
    }
  });
}

async function inspectSessionCommand(sessionRef: string, options: ScopedSessionRefCliOptions): Promise<void> {
  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const heartbeat = await sessionStore.getHeartbeat(session.id);
    const prompt = await sessionStore.readSessionPrompt(session.id);
    const runtimeConfig = await sessionStore.getSessionRuntimeConfig(session.id);

    process.stdout.write(
      [
        `Session ${session.id}`,
        `agent ${session.agentKey}`,
        `alias ${session.alias ?? "-"}`,
        `displayName ${session.displayName ?? "-"}`,
        `has brief ${prompt ? "yes" : "no"}`,
        `kind ${session.kind}`,
        `current thread ${session.currentThreadId}`,
        `created by ${session.createdByIdentityId ?? "-"}`,
        `runtime model ${runtimeConfig.model ?? "-"}`,
        `runtime thinking ${runtimeConfig.thinkingConfigured ? runtimeConfig.thinking ?? "off" : "-"}`,
        `heartbeat enabled ${heartbeat?.enabled ? "yes" : "no"}`,
        `heartbeat every ${heartbeat?.everyMinutes ?? "-"} minutes`,
      ].join("\n") + "\n",
    );
  });
}

async function showSessionPromptCommand(
  sessionRef: string,
  options: ScopedSessionRefCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const prompt = await sessionStore.readSessionPrompt(session.id, SESSION_BRIEFING_PROMPT_SLUG);
    if (!prompt) {
      process.stdout.write(
        [
          `Session prompt for ${session.id}.`,
          `slug ${SESSION_BRIEFING_PROMPT_SLUG}`,
          "has brief no",
        ].join("\n") + "\n",
      );
      return;
    }

    process.stdout.write(
      [
        `Session prompt for ${session.id}.`,
        `slug ${prompt.slug}`,
        "has brief yes",
        `updated ${new Date(prompt.updatedAt).toISOString()}`,
        "",
        prompt.content,
      ].join("\n") + "\n",
    );
  });
}

async function readSessionPromptCommand(
  sessionRef: string,
  options: ScopedSessionRefCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const prompt = await sessionStore.readSessionPrompt(session.id, SESSION_BRIEFING_PROMPT_SLUG);
    if (prompt) {
      writePromptContent(prompt.content);
    }
  });
}

async function setSessionPromptCommand(
  sessionRef: string,
  content: string | undefined,
  options: SessionPromptCliOptions,
): Promise<void> {
  const resolvedContent = await resolvePromptContent(content, options);
  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const prompt = await sessionStore.setSessionPrompt({
      sessionId: session.id,
      slug: SESSION_BRIEFING_PROMPT_SLUG,
      content: resolvedContent,
    });
    process.stdout.write(
      [
        `Updated session prompt for ${session.id}.`,
        `slug ${prompt.slug}`,
        "has brief yes",
      ].join("\n") + "\n",
    );
  });
}

async function clearSessionPromptCommand(
  sessionRef: string,
  options: ScopedSessionRefCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    await sessionStore.deleteSessionPrompt({
      sessionId: session.id,
      slug: SESSION_BRIEFING_PROMPT_SLUG,
    });
    process.stdout.write(
      [
        `Cleared session prompt for ${session.id}.`,
        `slug ${SESSION_BRIEFING_PROMPT_SLUG}`,
        "has brief no",
      ].join("\n") + "\n",
    );
  });
}

async function heartbeatCommand(sessionRef: string, options: HeartbeatCliOptions): Promise<void> {
  if (options.enable && options.disable) {
    throw new Error("Pick one: --enable or --disable.");
  }

  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const heartbeat = await sessionStore.updateHeartbeatConfig({
      sessionId: session.id,
      enabled: options.disable ? false : options.enable ? true : undefined,
      everyMinutes: options.every,
    });
    process.stdout.write(
      [
        `Updated heartbeat for ${session.id}.`,
        `enabled ${heartbeat.enabled ? "yes" : "no"}`,
        `every ${heartbeat.everyMinutes} minutes`,
      ].join("\n") + "\n",
    );
  });
}

async function bindConversationCommand(
  sessionRef: string,
  source: string,
  connectorKey: string,
  externalConversationId: string,
  options: ScopedSessionRefCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({conversations, sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const binding = await conversations.bindConversation({
      source,
      connectorKey,
      externalConversationId,
      sessionId: session.id,
    });
    process.stdout.write(
      [
        `Bound conversation to session ${binding.binding.sessionId}.`,
        `${binding.binding.source}/${binding.binding.connectorKey}/${binding.binding.externalConversationId}`,
      ].join("\n") + "\n",
    );
  });
}

async function labelSessionCommand(
  sessionRef: string,
  options: LabelCliOptions,
): Promise<void> {
  if (options.alias && options.clearAlias) {
    throw new Error("Pick one: --alias or --clear-alias.");
  }
  if (options.displayName && options.clearDisplayName) {
    throw new Error("Pick one: --display-name or --clear-display-name.");
  }

  const updatesAlias = options.alias !== undefined || options.clearAlias === true;
  const updatesDisplayName = options.displayName !== undefined || options.clearDisplayName === true;
  if (!updatesAlias && !updatesDisplayName) {
    throw new Error("Pass --alias, --display-name, --clear-alias, or --clear-display-name.");
  }

  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    if (options.alias) {
      await assertSessionAliasAvailable({
        sessionStore,
        agentKey: session.agentKey,
        alias: options.alias,
        currentSessionId: session.id,
      });
    }

    let updated: SessionRecord;
    try {
      updated = await sessionStore.updateSessionLabel({
        sessionId: session.id,
        ...(updatesAlias ? {alias: options.clearAlias ? null : options.alias ?? null} : {}),
        ...(updatesDisplayName ? {displayName: options.clearDisplayName ? null : options.displayName ?? null} : {}),
      });
    } catch (error) {
      if (options.alias && isDuplicateSessionIdError(error)) {
        throw duplicateSessionAliasError(session.agentKey, options.alias);
      }

      throw error;
    }

    process.stdout.write(
      [
        `Updated session ${updated.id}.`,
        `alias ${updated.alias ?? "-"}`,
        `displayName ${updated.displayName ?? "-"}`,
      ].join("\n") + "\n",
    );
  });
}

export function registerSessionManagementCommands(sessionProgram: Command): void {
  sessionProgram
    .command("create")
    .description("Create a branch session for an agent")
    .argument("<agentKey>", "Agent key", parseCreateAgentKey)
    .argument("[sessionRef]", "Optional readable session ref", parseSessionRefArgument)
    .option("--alias <alias>", "Alias for this session scoped to the agent", parseSessionAliasOption)
    .option("--display-name <name>", "Human-readable display name", parseDisplayNameOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, sessionRef: string | undefined, options: CreateSessionCliOptions) => {
      return createSessionCommand(agentKey, sessionRef, options);
    });

  sessionProgram
    .command("list")
    .description("List sessions for an agent")
    .argument("<agentKey>", "Agent key")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((agentKey: string, options: SessionCliOptions) => {
      return listSessionsCommand(agentKey, options);
    });

  sessionProgram
    .command("label")
    .description("Set or clear a session alias/display name")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--alias <alias>", "Alias scoped to this session's agent", parseSessionAliasOption)
    .option("--display-name <name>", "Human-readable display name", parseDisplayNameOption)
    .option("--clear-alias", "Clear the session alias")
    .option("--clear-display-name", "Clear the display name")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: LabelCliOptions) => {
      return labelSessionCommand(sessionRef, options);
    });

  sessionProgram
    .command("inspect")
    .description("Inspect one session")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: ScopedSessionRefCliOptions) => {
      return inspectSessionCommand(sessionRef, options);
    });

  const promptProgram = sessionProgram
    .command("prompt")
    .description("Manage a session briefing prompt");

  promptProgram
    .command("show")
    .description("Show a session briefing prompt with metadata")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: ScopedSessionRefCliOptions) => {
      return showSessionPromptCommand(sessionRef, options);
    });

  promptProgram
    .command("read")
    .description("Print the raw session briefing prompt content")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: ScopedSessionRefCliOptions) => {
      return readSessionPromptCommand(sessionRef, options);
    });

  promptProgram
    .command("set")
    .description("Set a session briefing prompt")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .argument("[content]", "Prompt content. Prefer --stdin for multiline content.")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--content <content>", "Prompt content")
    .option("--stdin", "Read prompt content from stdin")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, content: string | undefined, options: SessionPromptCliOptions) => {
      return setSessionPromptCommand(sessionRef, content, options);
    });

  promptProgram
    .command("clear")
    .description("Clear a session briefing prompt")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: ScopedSessionRefCliOptions) => {
      return clearSessionPromptCommand(sessionRef, options);
    });

  sessionProgram
    .command("heartbeat")
    .description("Configure session heartbeat")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--enable", "Enable heartbeat")
    .option("--disable", "Disable heartbeat")
    .option("--every <minutes>", "Heartbeat interval in minutes", parsePositiveIntegerOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionId: string, options: HeartbeatCliOptions) => {
      return heartbeatCommand(sessionId, options);
    });

  sessionProgram
    .command("bind-conversation")
    .description("Bind an external conversation to a session")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .argument("<source>", "Channel source, for example telegram")
    .argument("<connectorKey>", "Connector key")
    .argument("<externalConversationId>", "External conversation id")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((
      sessionRef: string,
      source: string,
      connectorKey: string,
      externalConversationId: string,
      options: ScopedSessionRefCliOptions,
    ) => {
      return bindConversationCommand(sessionRef, source, connectorKey, externalConversationId, options);
    });
}

export function registerSessionCommands(program: Command): void {
  registerSessionManagementCommands(
    program
      .command("session")
      .description("Manage Panda agent sessions"),
  );
}
