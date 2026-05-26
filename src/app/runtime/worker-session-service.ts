import {randomUUID} from "node:crypto";

import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import type {JsonObject, JsonValue} from "../../lib/json.js";
import {createSessionWithInitialThread} from "../../domain/sessions/lifecycle.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {
  CreateSessionInput,
  SessionRecord,
  SessionRuntimeConfigRecord,
  UpdateSessionRuntimeConfigInput,
} from "../../domain/sessions/types.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {CreateThreadInput, InferenceProjection, ThreadRecord} from "../../domain/threads/runtime/types.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {buildSessionTableNames} from "../../domain/sessions/postgres-shared.js";
import type {
    ExecutionCredentialPolicy,
    ExecutionEnvironmentRecord,
    ExecutionSkillPolicy,
    ExecutionToolPolicy,
    SessionEnvironmentBindingRecord,
} from "../../domain/execution-environments/types.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/filesystem.js";
import {normalizeSkillKey} from "../../domain/agents/types.js";
import {buildWorkerSessionMetadata} from "../../domain/sessions/worker-metadata.js";
import {renderSubagentHandoff} from "../../prompts/runtime/subagents.js";
import type {ThinkingLevel} from "@mariozechner/pi-ai";
import {stableStringify} from "../../lib/json.js";
import {trimToUndefined, uniqueTrimmedStrings} from "../../lib/strings.js";
import {
    DEFAULT_DISPOSABLE_ENVIRONMENT_TTL_MS,
    ExecutionEnvironmentLifecycleService,
} from "./execution-environment-service.js";

const WORKER_INPUT_SOURCE = "worker";
export const DEFAULT_WORKER_ENVIRONMENT_TTL_MS = DEFAULT_DISPOSABLE_ENVIRONMENT_TTL_MS;

export interface CreateWorkerSessionInput {
  agentKey: string;
  task: string;
  context?: string;
  role?: string;
  sessionId?: string;
  threadId?: string;
  parentSessionId?: string;
  createdByIdentityId?: string;
  model?: string;
  thinking?: ThinkingLevel | null;
  inferenceProjection?: InferenceProjection;
  credentialAllowlist?: readonly string[];
  credentialPolicy?: ExecutionCredentialPolicy;
  environmentId?: string;
  skillAllowlist?: readonly string[];
  skillPolicy?: ExecutionSkillPolicy;
  toolPolicy?: ExecutionToolPolicy;
  ttlMs?: number;
  deliveryMode?: "queue" | "wake";
  metadata?: JsonObject;
  beforeHandoff?: (created: CreateWorkerSessionResult) => Promise<void>;
}

export interface CreateWorkerSessionResult {
  session: SessionRecord;
  thread: ThreadRecord;
  environment: ExecutionEnvironmentRecord;
  binding: SessionEnvironmentBindingRecord;
}

type WorkerRuntimeConfig = Omit<UpdateSessionRuntimeConfigInput, "sessionId">;
type WorkerSessionStore = Pick<
  SessionStore,
  "createSession" | "getSession" | "getSessionRuntimeConfig" | "updateSessionRuntimeConfig"
>;
type WorkerThreadStore = Pick<ThreadRuntimeStore, "createThread" | "enqueueInput" | "getThread">;

interface WorkerSessionServiceOptions {
  pool?: PgPoolLike;
  sessions: WorkerSessionStore;
  threads: WorkerThreadStore;
  coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;
  environments: ExecutionEnvironmentLifecycleService;
}

function buildWorkerEnvironmentId(sessionId: string): string {
  return `worker:${sessionId}`;
}

function buildCredentialPolicy(input: CreateWorkerSessionInput): ExecutionCredentialPolicy {
  return input.credentialPolicy ?? {
    mode: "allowlist",
    envKeys: uniqueTrimmedStrings(input.credentialAllowlist ?? []),
  };
}

function normalizeSkillAllowlist(values: readonly string[] | undefined): string[] {
  return uniqueTrimmedStrings(values ?? []).map((value) => normalizeSkillKey(value));
}

function buildSkillPolicy(input: CreateWorkerSessionInput): ExecutionSkillPolicy {
  return input.skillPolicy ?? {
    mode: "allowlist",
    skillKeys: normalizeSkillAllowlist(input.skillAllowlist),
  };
}

function buildWorkerFileSharingContext(input: {
  environment: ExecutionEnvironmentRecord;
  parentSessionId?: string;
  role?: string;
}): string {
  const filesystem = readExecutionEnvironmentFilesystemMetadata(input.environment.metadata);
  const parentPath = filesystem?.root.parentRunnerPath;
  const role = trimToUndefined(input.role);
  return [
    ...(role ? [`Worker role: ${role}.`] : []),
    "Worker filesystem:",
    "- Use /workspace for normal work.",
    "- Read parent-provided files from /inbox.",
    "- Put reviewable outputs in /artifacts.",
    ...(parentPath ? [`- The parent agent can inspect this worker at ${parentPath}.`] : []),
    ...(input.parentSessionId
      ? [
        `- Send status, questions, and completion notes to the parent with message_agent using sessionId ${JSON.stringify(input.parentSessionId)}.`,
        "- Format worker messages with status: done|blocked|question|progress, summary, artifacts, and needs.",
      ]
      : []),
  ].join("\n");
}

function appendWorkerHandoffContext(input: {
  context?: string;
  environment: ExecutionEnvironmentRecord;
  parentSessionId?: string;
  role?: string;
}): string {
  const fileSharingContext = buildWorkerFileSharingContext({
    environment: input.environment,
    parentSessionId: input.parentSessionId,
    role: input.role,
  });
  const trimmedContext = input.context?.trim();
  return trimmedContext
    ? `${trimmedContext}\n\n${fileSharingContext}`
    : fileSharingContext;
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return stableStringify(left) === stableStringify(right);
}

function buildWorkerRuntimeConfig(
  input: CreateWorkerSessionInput,
): WorkerRuntimeConfig | undefined {
  const runtimeConfig = {
    ...(input.model !== undefined ? {model: input.model} : {}),
    ...(input.thinking !== undefined ? {thinking: input.thinking} : {}),
    ...(input.inferenceProjection !== undefined ? {inferenceProjection: input.inferenceProjection} : {}),
  } satisfies WorkerRuntimeConfig;
  return Object.keys(runtimeConfig).length > 0 ? runtimeConfig : undefined;
}

function requestedRuntimeConfigMatches(
  existing: SessionRuntimeConfigRecord,
  requested: WorkerRuntimeConfig,
): boolean {
  if (requested.model !== undefined && existing.model !== requested.model) {
    return false;
  }

  if (requested.thinking !== undefined) {
    const requestedThinking = requested.thinking ?? undefined;
    if (!existing.thinkingConfigured || existing.thinking !== requestedThinking) {
      return false;
    }
  }

  if (
    requested.inferenceProjection !== undefined
    && !sameJson(
      existing.inferenceProjection as JsonValue | undefined,
      requested.inferenceProjection as JsonValue | undefined,
    )
  ) {
    return false;
  }

  return true;
}

export class WorkerSessionService {
  private readonly pool?: PgPoolLike;
  private readonly sessions: WorkerSessionStore;
  private readonly threads: WorkerThreadStore;
  private readonly coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;
  private readonly environments: ExecutionEnvironmentLifecycleService;

  constructor(options: WorkerSessionServiceOptions) {
    this.pool = options.pool;
    this.sessions = options.sessions;
    this.threads = options.threads;
    this.coordinator = options.coordinator;
    this.environments = options.environments;
  }

  async createWorkerSession(input: CreateWorkerSessionInput): Promise<CreateWorkerSessionResult> {
    const agentKey = trimToUndefined(input.agentKey);
    const task = trimToUndefined(input.task);
    if (!agentKey) {
      throw new Error("Worker session agentKey must not be empty.");
    }
    if (!task) {
      throw new Error("Worker session task must not be empty.");
    }

    const sessionId = trimToUndefined(input.sessionId) ?? randomUUID();
    const threadId = trimToUndefined(input.threadId) ?? randomUUID();
    const workerMetadata = buildWorkerSessionMetadata({
      ...input,
      task,
    });
    const sessionInput: CreateSessionInput = {
      id: sessionId,
      agentKey,
      kind: "worker",
      currentThreadId: threadId,
      createdByIdentityId: input.createdByIdentityId,
      metadata: workerMetadata,
    };
    const threadInput: CreateThreadInput = {
      id: threadId,
      sessionId,
    };
    const runtimeConfig = buildWorkerRuntimeConfig(input);

    const created = await this.createSessionAndThread(sessionInput, threadInput, runtimeConfig);
    const environmentId = trimToUndefined(input.environmentId) ?? buildWorkerEnvironmentId(created.session.id);
    const createsFreshEnvironment = !trimToUndefined(input.environmentId);
    let result: CreateWorkerSessionResult | null = null;
    try {
      const environment = createsFreshEnvironment
        ? await this.environments.createDisposableForSession({
          session: created.session,
          environmentId,
          createdBySessionId: input.parentSessionId,
          alias: "self",
          isDefault: true,
          credentialPolicy: buildCredentialPolicy(input),
          skillPolicy: buildSkillPolicy(input),
          toolPolicy: input.toolPolicy ?? {},
          ttlMs: input.ttlMs ?? DEFAULT_WORKER_ENVIRONMENT_TTL_MS,
          metadata: workerMetadata,
        })
        : await this.environments.attachSessionToDisposableEnvironment({
          session: created.session,
          environmentId,
          ownerSessionId: input.parentSessionId ?? "",
          alias: "self",
          isDefault: true,
          credentialPolicy: buildCredentialPolicy(input),
          skillPolicy: buildSkillPolicy(input),
          toolPolicy: input.toolPolicy ?? {},
        });

      result = {
        session: created.session,
        thread: created.thread,
        environment: environment.environment,
        binding: environment.binding,
      };
      await input.beforeHandoff?.(result);

      await this.enqueueHandoff({
        threadId: created.thread.id,
        task,
        context: appendWorkerHandoffContext({
          context: input.context,
          environment: environment.environment,
          parentSessionId: input.parentSessionId,
          role: input.role,
        }),
        identityId: input.createdByIdentityId,
        metadata: workerMetadata,
        deliveryMode: input.deliveryMode ?? "wake",
      });

      return result;
    } catch (error) {
      if (created.wasCreated) {
        if (result && createsFreshEnvironment) {
          await this.environments.stopEnvironment(environmentId).catch(() => {});
        }
        await this.deleteCreatedWorkerSession(created.session.id, created.thread.id).catch(() => {});
      }
      throw error;
    }
  }

  private async createSessionAndThread(
    session: CreateSessionInput,
    thread: CreateThreadInput,
    runtimeConfig: WorkerRuntimeConfig | undefined,
  ): Promise<{session: SessionRecord; thread: ThreadRecord; wasCreated: boolean}> {
    const existing = await this.readExistingSessionAndThread(session, thread, runtimeConfig);
    if (existing) {
      return {
        ...existing,
        wasCreated: false,
      };
    }

    if (
      this.pool
      && this.sessions instanceof PostgresSessionStore
      && this.threads instanceof PostgresThreadRuntimeStore
    ) {
      const created = await createSessionWithInitialThread({
        pool: this.pool,
        sessionStore: this.sessions,
        threadStore: this.threads,
        session,
        thread,
        runtimeConfig,
      });
      return {
        ...created,
        wasCreated: true,
      };
    }

    const createdSession = await this.sessions.createSession(session);
    const createdThread = await this.threads.createThread(thread);
    if (runtimeConfig) {
      await this.sessions.updateSessionRuntimeConfig({
        sessionId: createdSession.id,
        ...runtimeConfig,
      });
    }
    return {
      session: createdSession,
      thread: createdThread,
      wasCreated: true,
    };
  }

  private async deleteCreatedWorkerSession(sessionId: string, threadId: string): Promise<void> {
    if (!this.pool) {
      return;
    }

    const tables = buildSessionTableNames();
    await this.pool.query(
      `DELETE FROM ${tables.sessions} WHERE id = $1 AND kind = 'worker' AND current_thread_id = $2`,
      [sessionId, threadId],
    );
  }

  private async readExistingSessionAndThread(
    session: CreateSessionInput,
    thread: CreateThreadInput,
    runtimeConfig: WorkerRuntimeConfig | undefined,
  ): Promise<{session: SessionRecord; thread: ThreadRecord} | null> {
    const existingSession = await this.sessions.getSession(session.id).catch(() => null);
    const existingThread = await this.threads.getThread(thread.id).catch(() => null);
    if (!existingSession && !existingThread) {
      return null;
    }

    if (!existingSession || !existingThread) {
      throw new Error(`Worker session ${session.id} is partially created.`);
    }
    if (
      existingSession.kind !== "worker"
      || existingSession.agentKey !== session.agentKey
      || existingSession.currentThreadId !== thread.id
      || existingThread.sessionId !== session.id
    ) {
      throw new Error(`Worker session ${session.id} already exists with different state.`);
    }
    if (!sameJson(existingSession.metadata, session.metadata)) {
      throw new Error(`Worker session ${session.id} already exists with different input.`);
    }

    if (runtimeConfig) {
      const existingRuntimeConfig = await this.sessions.getSessionRuntimeConfig(session.id);
      if (!requestedRuntimeConfigMatches(existingRuntimeConfig, runtimeConfig)) {
        throw new Error(`Worker session ${session.id} already exists with different runtime config.`);
      }
    }

    return {
      session: existingSession,
      thread: existingThread,
    };
  }

  private async enqueueHandoff(input: {
    threadId: string;
    task: string;
    context?: string;
    identityId?: string;
    metadata: JsonObject;
    deliveryMode: "queue" | "wake";
  }): Promise<void> {
    const payload = {
      message: stringToUserMessage(renderSubagentHandoff(input.task, input.context)),
      source: WORKER_INPUT_SOURCE,
      externalMessageId: `worker-handoff:${input.threadId}`,
      identityId: input.identityId,
      metadata: input.metadata,
    };
    if (this.coordinator) {
      await this.coordinator.submitInput(input.threadId, payload, input.deliveryMode);
      return;
    }

    await this.threads.enqueueInput(input.threadId, payload, input.deliveryMode);
  }
}
