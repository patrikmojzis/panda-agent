import {randomUUID} from "node:crypto";

import {stringToUserMessage} from "../../kernel/agent/index.js";
import type {JsonObject, JsonValue} from "../../kernel/agent/types.js";
import {
    type CreateSessionInput,
    createSessionWithInitialThread,
    type SessionRecord,
    type SessionStore,
} from "../../domain/sessions/index.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import {PostgresThreadRuntimeStore, type ThreadRecord} from "../../domain/threads/runtime/index.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {CreateThreadInput, InferenceProjection} from "../../domain/threads/runtime/types.js";
import type {PgPoolLike} from "../../domain/threads/runtime/postgres-db.js";
import {buildSessionTableNames} from "../../domain/sessions/postgres-shared.js";
import type {
    ExecutionCredentialPolicy,
    ExecutionEnvironmentRecord,
    ExecutionSkillPolicy,
    ExecutionToolPolicy,
    SessionEnvironmentBindingRecord,
} from "../../domain/execution-environments/index.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/index.js";
import {normalizeSkillKey} from "../../domain/agents/types.js";
import {buildWorkerSessionMetadata} from "../../domain/sessions/worker-metadata.js";
import {renderSubagentHandoff} from "../../prompts/runtime/subagents.js";
import type {ThinkingLevel} from "@mariozechner/pi-ai";
import {stableStringify} from "../../lib/json.js";
import {trimToUndefined} from "../../lib/strings.js";
import {ExecutionEnvironmentLifecycleService} from "./execution-environment-service.js";

const WORKER_INPUT_SOURCE = "worker";
export const DEFAULT_WORKER_ENVIRONMENT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_WORKER_THINKING: ThinkingLevel = "xhigh";

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
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
  credentialAllowlist?: readonly string[];
  credentialPolicy?: ExecutionCredentialPolicy;
  skillAllowlist?: readonly string[];
  skillPolicy?: ExecutionSkillPolicy;
  toolPolicy?: ExecutionToolPolicy;
  ttlMs?: number;
  systemPrompt?: string | readonly string[];
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

export interface WorkerSessionServiceOptions {
  pool?: PgPoolLike;
  sessions: SessionStore;
  threads: ThreadRuntimeStore;
  coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;
  environments: ExecutionEnvironmentLifecycleService;
  fallbackContext: {cwd: string};
}

function buildWorkerEnvironmentId(sessionId: string): string {
  return `worker:${sessionId}`;
}

function normalizeAllowlist(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function buildCredentialPolicy(input: CreateWorkerSessionInput): ExecutionCredentialPolicy {
  return input.credentialPolicy ?? {
    mode: "allowlist",
    envKeys: normalizeAllowlist(input.credentialAllowlist),
  };
}

function normalizeSkillAllowlist(values: readonly string[] | undefined): string[] {
  return normalizeAllowlist(values).map((value) => normalizeSkillKey(value));
}

function buildSkillPolicy(input: CreateWorkerSessionInput): ExecutionSkillPolicy {
  return input.skillPolicy ?? {
    mode: "allowlist",
    skillKeys: normalizeSkillAllowlist(input.skillAllowlist),
  };
}

function buildThreadContext(input: {
  fallbackContext: {cwd: string};
  sessionId: string;
  agentKey: string;
  workerMetadata: JsonObject;
}): JsonObject {
  return {
    ...input.fallbackContext,
    agentKey: input.agentKey,
    sessionId: input.sessionId,
    worker: input.workerMetadata.worker as JsonValue,
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

export class WorkerSessionService {
  private readonly pool?: PgPoolLike;
  private readonly sessions: SessionStore;
  private readonly threads: ThreadRuntimeStore;
  private readonly coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;
  private readonly environments: ExecutionEnvironmentLifecycleService;
  private readonly fallbackContext: {cwd: string};

  constructor(options: WorkerSessionServiceOptions) {
    this.pool = options.pool;
    this.sessions = options.sessions;
    this.threads = options.threads;
    this.coordinator = options.coordinator;
    this.environments = options.environments;
    this.fallbackContext = options.fallbackContext;
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
      context: buildThreadContext({
        fallbackContext: this.fallbackContext,
        sessionId,
        agentKey,
        workerMetadata,
      }),
      systemPrompt: input.systemPrompt,
      model: input.model,
      thinking: input.thinking ?? DEFAULT_WORKER_THINKING,
      inferenceProjection: input.inferenceProjection,
    };

    const created = await this.createSessionAndThread(sessionInput, threadInput);
    const environmentId = buildWorkerEnvironmentId(created.session.id);
    let result: CreateWorkerSessionResult | null = null;
    try {
      const environment = await this.environments.createDisposableForSession({
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
        if (result) {
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
  ): Promise<{session: SessionRecord; thread: ThreadRecord; wasCreated: boolean}> {
    const existing = await this.readExistingSessionAndThread(session, thread);
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
      });
      return {
        ...created,
        wasCreated: true,
      };
    }

    const createdSession = await this.sessions.createSession(session);
    const createdThread = await this.threads.createThread(thread);
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
    if (
      !sameJson(existingSession.metadata, session.metadata)
      || !sameJson(existingThread.context, thread.context)
      || !sameJson(existingThread.systemPrompt as JsonValue | undefined, thread.systemPrompt as JsonValue | undefined)
      || existingThread.model !== thread.model
      || existingThread.thinking !== thread.thinking
      || !sameJson(existingThread.inferenceProjection as JsonValue | undefined, thread.inferenceProjection as JsonValue | undefined)
    ) {
      throw new Error(`Worker session ${session.id} already exists with different input.`);
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
