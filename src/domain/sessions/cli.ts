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
import {PostgresExecutionEnvironmentStore} from "../execution-environments/postgres.js";
import type {
  ExecutionEnvironmentRecord,
  ExecutionToolPolicy,
  SessionEnvironmentBindingRecord,
} from "../execution-environments/types.js";
import {normalizeExecutionEnvironmentAlias} from "../execution-environments/types.js";
import {buildRunnerEndpoint, makeNetworkTimeoutSignal, resolveBashExecutionMode, resolveRunnerUrl, resolveRunnerUrlTemplate} from "../execution-environments/runner-config.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {createSessionWithInitialThread} from "./lifecycle.js";
import {PostgresSessionStore} from "./postgres.js";
import {SESSION_BRIEF_PROMPT_SLUG, normalizeSessionAlias, normalizeSessionPromptSlug, type SessionPromptSlug, type SessionRecord} from "./types.js";

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
  slug?: SessionPromptSlug;
  stdin?: boolean;
}

interface SessionTargetListCliOptions extends ScopedSessionRefCliOptions {
  alias?: string;
}

interface SessionTargetBindCliOptions extends ScopedSessionRefCliOptions {
  environmentId?: string;
  runnerUrl?: string;
  runnerCwd?: string;
  default?: boolean;
  allowTools?: string;
}

interface SessionTargetDetachCliOptions extends ScopedSessionRefCliOptions {}

type SessionTargetHealth = "reachable" | "unreachable" | "unknown" | "not_applicable";

interface WithSessionStores {
  pool: Pool;
  agentStore: PostgresAgentStore;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  executionEnvironmentStore: PostgresExecutionEnvironmentStore;
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
    executionEnvironmentStore: new PostgresExecutionEnvironmentStore({pool}),
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
      stores.executionEnvironmentStore,
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

function parseSessionPromptSlugOption(value: string): SessionPromptSlug {
  return parseCliValue(value, normalizeSessionPromptSlug);
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

function parseAllowedToolsOption(value: string | undefined): ExecutionToolPolicy {
  const allowedTools = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowedTools.length === 0) {
    throw new Error("Session target bind requires --allow-tools so selected targets fail closed.");
  }
  return {allowedTools: [...new Set(allowedTools)]};
}

function defaultTargetEnvironmentId(sessionId: string, alias: string): string {
  return `persistent_agent_runner:${sessionId}:${alias}`;
}

function formatRunnerUrl(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function formatAllowedTools(policy: ExecutionToolPolicy | undefined): string {
  return policy?.allowedTools?.length ? policy.allowedTools.join(",") : "none";
}

function normalizeTargetAliasFilter(alias: string | undefined): string | undefined {
  const normalized = alias?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalized === "default" ? "default" : normalizeExecutionEnvironmentAlias(normalized);
}

async function probeRunnerHealth(runnerUrl: string | undefined, kind: string, state: string): Promise<SessionTargetHealth> {
  if (kind === "local") {
    return "not_applicable";
  }
  if (state !== "ready" || !runnerUrl) {
    return "unknown";
  }
  try {
    const response = await fetch(buildRunnerEndpoint(runnerUrl, "health"), {
      method: "GET",
      signal: makeNetworkTimeoutSignal(1_500),
    });
    return response.ok ? "reachable" : "unreachable";
  } catch {
    return "unreachable";
  }
}

async function renderTargetLine(input: {
  alias: string;
  binding?: SessionEnvironmentBindingRecord;
  environment: Pick<ExecutionEnvironmentRecord, "id" | "kind" | "state" | "networkPolicy" | "runnerUrl" | "runnerCwd">;
}): Promise<string> {
  const health = await probeRunnerHealth(input.environment.runnerUrl, input.environment.kind, input.environment.state);
  return [
    `${input.alias}${input.binding?.isDefault ? " (default binding)" : ""}`,
    `  environment ${input.environment.id}`,
    `  kind ${input.environment.kind} · state ${input.environment.state} · networkPolicy ${input.environment.networkPolicy} · health ${health}`,
    `  runner ${formatRunnerUrl(input.environment.runnerUrl)} · cwd ${input.environment.runnerCwd ?? "-"}`,
    `  allowedTools ${formatAllowedTools(input.binding?.toolPolicy)}`,
  ].join("\n");
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

function promptSlug(options: {slug?: SessionPromptSlug}): SessionPromptSlug {
  return options.slug ?? SESSION_BRIEF_PROMPT_SLUG;
}

function hasPromptLabel(slug: SessionPromptSlug): string {
  return `has ${slug}`;
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
  options: SessionPromptCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const slug = promptSlug(options);
    const prompt = await sessionStore.readSessionPrompt(session.id, slug);
    if (!prompt) {
      process.stdout.write(
        [
          `Session prompt for ${session.id}.`,
          `slug ${slug}`,
          `${hasPromptLabel(slug)} no`,
        ].join("\n") + "\n",
      );
      return;
    }

    process.stdout.write(
      [
        `Session prompt for ${session.id}.`,
        `slug ${prompt.slug}`,
        `${hasPromptLabel(prompt.slug)} yes`,
        `updated ${new Date(prompt.updatedAt).toISOString()}`,
        "",
        prompt.content,
      ].join("\n") + "\n",
    );
  });
}

async function readSessionPromptCommand(
  sessionRef: string,
  options: SessionPromptCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const prompt = await sessionStore.readSessionPrompt(session.id, promptSlug(options));
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
    const slug = promptSlug(options);
    const prompt = await sessionStore.setSessionPrompt({
      sessionId: session.id,
      slug,
      content: resolvedContent,
    });
    process.stdout.write(
      [
        `Updated session prompt for ${session.id}.`,
        `slug ${prompt.slug}`,
        `${hasPromptLabel(prompt.slug)} yes`,
      ].join("\n") + "\n",
    );
  });
}

async function clearSessionPromptCommand(
  sessionRef: string,
  options: SessionPromptCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const slug = promptSlug(options);
    await sessionStore.deleteSessionPrompt({
      sessionId: session.id,
      slug,
    });
    process.stdout.write(
      [
        `Cleared session prompt for ${session.id}.`,
        `slug ${slug}`,
        `${hasPromptLabel(slug)} no`,
      ].join("\n") + "\n",
    );
  });
}

async function listSessionPromptsCommand(
  sessionRef: string,
  options: ScopedSessionRefCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({sessionStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const prompts = await sessionStore.listSessionPrompts(session.id);
    const promptsBySlug = new Map(prompts.map((prompt) => [prompt.slug, prompt]));
    process.stdout.write(`Session prompts for ${session.id}.\n`);
    for (const slug of ["brief", "memory", "heartbeat"] as const) {
      const prompt = promptsBySlug.get(slug);
      process.stdout.write([
        `slug ${slug}`,
        `${hasPromptLabel(slug)} ${prompt ? "yes" : "no"}`,
        `chars ${(prompt?.content.length ?? 0).toLocaleString()}`,
        `updated ${prompt ? new Date(prompt.updatedAt).toISOString() : "-"}`,
      ].join(" · ") + "\n");
    }
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

async function listSessionTargetsCommand(
  sessionRef: string,
  options: SessionTargetListCliOptions,
): Promise<void> {
  await withSessionStores(options, async ({sessionStore, executionEnvironmentStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const aliasFilter = normalizeTargetAliasFilter(options.alias);
    const bindings = await executionEnvironmentStore.listBindingsForSession(session.id);
    const lines: string[] = [`Execution targets for ${session.id}.`];

    const defaultBinding = bindings.find((binding) => binding.isDefault);
    if (!aliasFilter || aliasFilter === "default") {
      if (defaultBinding) {
        const environment = await executionEnvironmentStore.getEnvironment(defaultBinding.environmentId);
        lines.push(await renderTargetLine({
          alias: "default",
          binding: defaultBinding,
          environment,
        }));
      } else {
        const executionMode = resolveBashExecutionMode(process.env);
        const runnerUrlTemplate = resolveRunnerUrlTemplate(process.env);
        const runnerUrl = executionMode === "remote" && runnerUrlTemplate
          ? resolveRunnerUrl(runnerUrlTemplate, session.agentKey)
          : undefined;
        lines.push(await renderTargetLine({
          alias: "default",
          environment: {
            id: executionMode === "remote" ? `persistent_agent_runner:${session.agentKey}` : `local:${session.agentKey}`,
            kind: executionMode === "remote" ? "persistent_agent_runner" : "local",
            state: "ready",
            networkPolicy: "public",
            runnerUrl,
            runnerCwd: undefined,
          },
        }));
      }
    }

    for (const binding of bindings) {
      if (aliasFilter && binding.alias !== aliasFilter) {
        continue;
      }
      const environment = await executionEnvironmentStore.getEnvironment(binding.environmentId);
      lines.push(await renderTargetLine({
        alias: binding.alias,
        binding,
        environment,
      }));
    }

    if (lines.length === 1) {
      lines.push(`No execution target alias ${aliasFilter ?? "-"} is bound to ${session.id}.`);
    }

    process.stdout.write(lines.join("\n\n") + "\n");
  });
}

async function bindSessionTargetCommand(
  sessionRef: string,
  aliasInput: string,
  options: SessionTargetBindCliOptions,
): Promise<void> {
  const alias = normalizeExecutionEnvironmentAlias(aliasInput);
  if (!options.runnerUrl && !options.environmentId?.trim()) {
    throw new Error("Session target bind requires --runner-url unless --environment-id is provided.");
  }

  await withSessionStores(options, async ({sessionStore, executionEnvironmentStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const requestedEnvironmentId = options.environmentId?.trim() || undefined;
    const environmentId = requestedEnvironmentId ?? defaultTargetEnvironmentId(session.id, alias);
    let environment: ExecutionEnvironmentRecord;
    if (options.runnerUrl) {
      environment = await executionEnvironmentStore.createEnvironment({
        id: environmentId,
        agentKey: session.agentKey,
        kind: "persistent_agent_runner",
        state: "ready",
        runnerUrl: options.runnerUrl,
        runnerCwd: options.runnerCwd,
      });
    } else {
      environment = await executionEnvironmentStore.getEnvironment(environmentId);
      if (environment.agentKey !== session.agentKey) {
        throw new Error(`Execution environment ${environment.id} belongs to agent ${environment.agentKey}, not ${session.agentKey}.`);
      }
    }

    const binding = await executionEnvironmentStore.bindSession({
      sessionId: session.id,
      environmentId: environment.id,
      alias,
      isDefault: options.default === true,
      toolPolicy: parseAllowedToolsOption(options.allowTools),
    });

    process.stdout.write([
      `Bound execution target ${binding.alias} to session ${session.id}.`,
      `environment ${binding.environmentId}`,
      `default ${binding.isDefault ? "yes" : "no"}`,
      `runner ${formatRunnerUrl(environment.runnerUrl)}`,
      `networkPolicy ${environment.networkPolicy}`,
      `allowedTools ${formatAllowedTools(binding.toolPolicy)}`,
    ].join("\n") + "\n");
  });
}

async function detachSessionTargetCommand(
  sessionRef: string,
  aliasInput: string,
  options: SessionTargetDetachCliOptions,
): Promise<void> {
  const alias = normalizeExecutionEnvironmentAlias(aliasInput);
  await withSessionStores(options, async ({sessionStore, executionEnvironmentStore}) => {
    const session = await resolveSessionCliRef(sessionStore, sessionRef, options);
    const binding = await executionEnvironmentStore.getBindingByAlias(session.id, alias);
    if (!binding) {
      process.stdout.write(`No execution target ${alias} is bound to session ${session.id}.\n`);
      return;
    }
    if (binding.isDefault) {
      throw new Error(`Refusing to detach default execution target ${alias}. Bind another default target first.`);
    }
    const deleted = await executionEnvironmentStore.deleteBindingByAlias(session.id, alias);
    process.stdout.write(deleted
      ? `Detached execution target ${alias} from session ${session.id}.\n`
      : `No execution target ${alias} is bound to session ${session.id}.\n`);
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
    .description("Manage session prompts");

  promptProgram
    .command("list")
    .description("List session prompt slots")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: ScopedSessionRefCliOptions) => {
      return listSessionPromptsCommand(sessionRef, options);
    });

  promptProgram
    .command("show")
    .description("Show a session prompt with metadata")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--slug <slug>", "Prompt slug: brief, memory, or heartbeat", parseSessionPromptSlugOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: SessionPromptCliOptions) => {
      return showSessionPromptCommand(sessionRef, options);
    });

  promptProgram
    .command("read")
    .description("Print raw session prompt content")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--slug <slug>", "Prompt slug: brief, memory, or heartbeat", parseSessionPromptSlugOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: SessionPromptCliOptions) => {
      return readSessionPromptCommand(sessionRef, options);
    });

  promptProgram
    .command("set")
    .description("Set a session prompt")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .argument("[content]", "Prompt content. Prefer --stdin for multiline content.")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--slug <slug>", "Prompt slug: brief, memory, or heartbeat", parseSessionPromptSlugOption)
    .option("--content <content>", "Prompt content")
    .option("--stdin", "Read prompt content from stdin")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, content: string | undefined, options: SessionPromptCliOptions) => {
      return setSessionPromptCommand(sessionRef, content, options);
    });

  promptProgram
    .command("clear")
    .description("Clear a session prompt")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--slug <slug>", "Prompt slug: brief, memory, or heartbeat", parseSessionPromptSlugOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: SessionPromptCliOptions) => {
      return clearSessionPromptCommand(sessionRef, options);
    });

  const targetsProgram = sessionProgram
    .command("targets")
    .description("Manage execution targets bound to a session");

  targetsProgram
    .command("list")
    .description("List execution targets and runner reachability for a session")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--alias <alias>", "Show one target alias")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, options: SessionTargetListCliOptions) => {
      return listSessionTargetsCommand(sessionRef, options);
    });

  targetsProgram
    .command("status")
    .description("Alias for targets list; shows target status/reachability")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .argument("[alias]", "Optional target alias")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, alias: string | undefined, options: SessionTargetListCliOptions) => {
      return listSessionTargetsCommand(sessionRef, {...options, alias});
    });

  targetsProgram
    .command("bind")
    .description("Register a persistent runner endpoint and bind it to a session alias")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .argument("<alias>", "Target alias, for example vps")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--environment-id <id>", "Existing or desired execution environment id")
    .option("--runner-url <url>", "Runner base URL for this target")
    .option("--runner-cwd <path>", "Initial cwd inside the runner")
    .option("--default", "Make this binding the session default target")
    .option("--allow-tools <csv>", "Restrict this target to comma-separated tool names")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, alias: string, options: SessionTargetBindCliOptions) => {
      return bindSessionTargetCommand(sessionRef, alias, options);
    });

  targetsProgram
    .command("detach")
    .description("Detach a non-default execution target alias from a session")
    .argument("<sessionRef>", "Session id, or alias when --agent is provided")
    .argument("<alias>", "Target alias to detach")
    .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((sessionRef: string, alias: string, options: SessionTargetDetachCliOptions) => {
      return detachSessionTargetCommand(sessionRef, alias, options);
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
