import {randomUUID} from "node:crypto";

import {Agent} from "../../kernel/agent/agent.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import type {LlmContext} from "../../kernel/agent/llm-context.js";
import type {JsonObject} from "../../kernel/agent/types.js";
import type {Tool} from "../../kernel/agent/tool.js";
import type {AgentStore} from "../../domain/agents/store.js";
import {createSessionWithInitialThread, PostgresSessionStore, type SessionRecord, type SessionStore} from "../../domain/sessions/index.js";
import {
  PostgresThreadRuntimeStore,
  type ResolvedThreadDefinition,
  type ThreadInputPayload,
  type ThreadRecord,
  type ThreadRuntimeBeforeRunStepInput,
} from "../../domain/threads/runtime/index.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {PgPoolLike} from "../../domain/threads/runtime/postgres-db.js";
import type {WikiBindingService} from "../../domain/wiki/index.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined, truncateText} from "../../lib/strings.js";
import {resolveRuntimeDefaultModelSelector} from "../../kernel/models/default-model.js";
import {buildDefaultAgentLlmContexts} from "../../panda/contexts/builder.js";
import {resolveDefaultAgentIntuitionSidecarModelSelector} from "../../panda/defaults.js";
import {BraveSearchTool, hasBraveSearchApiKey} from "../../panda/tools/brave-search-tool.js";
import {CurrentDateTimeTool} from "../../panda/tools/current-datetime-tool.js";
import {
  IntuitionWhisperTool,
  type IntuitionWhisper,
  type IntuitionWhisperSink,
} from "../../panda/tools/intuition-whisper-tool.js";
import {PostgresReadonlyQueryTool} from "../../panda/tools/postgres-readonly-query-tool.js";
import {WebFetchTool} from "../../panda/tools/web-fetch-tool.js";
import {WikiReadonlyTool} from "../../panda/tools/wiki-tool.js";
import {
  INTUITION_SIDECAR_PROMPT,
  renderIntuitionObservationPrompt,
} from "../../prompts/runtime/intuition-sidecar.js";

export const INTUITION_SIDECAR_SOURCE = "intuition_sidecar";
export const INTUITION_OBSERVATION_SOURCE = "intuition_observation";
export const INTUITION_SIDECAR_KIND = "intuition_sidecar";
export const INTUITION_SIDECAR_SOFT_WAIT_MS = 5_000;

interface IntuitionSidecarBinding {
  parentSessionId: string;
}

export interface IntuitionSidecarRuntime {
  submitInput(
    threadId: string,
    payload: ThreadInputPayload,
    mode?: "wake" | "queue",
  ): Promise<void>;
}

export interface IntuitionSidecarServiceOptions {
  sessionStore: SessionStore;
  threadStore: ThreadRuntimeStore;
  runtime: IntuitionSidecarRuntime;
  pool?: PgPoolLike;
  agentStore?: AgentStore;
  wikiBindings?: Pick<WikiBindingService, "getBinding">;
  env?: NodeJS.ProcessEnv;
  softWaitMs?: number;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSidecarBinding(value: unknown): IntuitionSidecarBinding | null {
  if (!isRecord(value)) {
    return null;
  }

  const sidecar = isRecord(value.intuitionSidecar) ? value.intuitionSidecar : null;
  if (!sidecar || sidecar.kind !== INTUITION_SIDECAR_KIND) {
    return null;
  }

  const parentSessionId = readString(sidecar.parentSessionId);
  return parentSessionId ? {parentSessionId} : null;
}

function buildSidecarSessionId(parentSessionId: string): string {
  return `intuition-sidecar-${parentSessionId}`;
}

function buildSidecarThreadId(parentSessionId: string): string {
  return `${buildSidecarSessionId(parentSessionId)}-thread`;
}

function buildSidecarMetadata(parentSessionId: string) {
  return {
    intuitionSidecar: {
      kind: INTUITION_SIDECAR_KIND,
      parentSessionId,
    },
  } satisfies JsonObject;
}

function buildSidecarThreadContext(input: {
  sessionId: string;
  agentKey: string;
  parentSessionId: string;
  cwd?: string;
}): JsonObject {
  return {
    sessionId: input.sessionId,
    agentKey: input.agentKey,
    ...(input.cwd ? {cwd: input.cwd} : {}),
    ...buildSidecarMetadata(input.parentSessionId),
  };
}

function readCwd(thread: ThreadRecord): string | undefined {
  return isRecord(thread.context) ? trimToUndefined(thread.context.cwd) : undefined;
}

function formatWhisperForMain(message: string): string {
  return [
    "[Internal intuition note]",
    truncateText(message.trim(), 4_000),
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class IntuitionSidecarService implements IntuitionWhisperSink {
  private readonly sessionStore: SessionStore;
  private readonly threadStore: ThreadRuntimeStore;
  private readonly runtime: IntuitionSidecarRuntime;
  private readonly pool?: PgPoolLike;
  private readonly agentStore?: AgentStore;
  private readonly wikiBindings?: Pick<WikiBindingService, "getBinding">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly softWaitMs: number;
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(options: IntuitionSidecarServiceOptions) {
    this.sessionStore = options.sessionStore;
    this.threadStore = options.threadStore;
    this.runtime = options.runtime;
    this.pool = options.pool;
    this.agentStore = options.agentStore;
    this.wikiBindings = options.wikiBindings;
    this.env = options.env ?? process.env;
    this.softWaitMs = options.softWaitMs ?? INTUITION_SIDECAR_SOFT_WAIT_MS;
  }

  isSidecarThread(thread: Pick<ThreadRecord, "context">): boolean {
    return readSidecarBinding(thread.context) !== null;
  }

  async beforeRunStep(input: ThreadRuntimeBeforeRunStepInput): Promise<void> {
    if (this.isSidecarThread(input.thread)) {
      return;
    }
    if (input.appliedInputs.length === 0) {
      return;
    }
    if (input.appliedInputs.every((entry) => entry.source === INTUITION_SIDECAR_SOURCE)) {
      return;
    }

    const sidecarThread = await this.ensureSidecarThread(input.thread);
    const waiter = this.waitForWhisper(input.run.id, this.softWaitMs);
    await this.runtime.submitInput(sidecarThread.id, {
      message: stringToUserMessage(renderIntuitionObservationPrompt({
        run: input.run,
        mainThread: input.thread,
        appliedInputs: input.appliedInputs,
        transcript: input.transcript,
      })),
      source: INTUITION_OBSERVATION_SOURCE,
      externalMessageId: `intuition_observation:${input.run.id}:${randomUUID()}`,
      metadata: {
        intuitionObservation: {
          kind: INTUITION_SIDECAR_KIND,
          parentRunId: input.run.id,
          parentThreadId: input.thread.id,
          parentSessionId: input.thread.sessionId,
          appliedInputIds: input.appliedInputs.map((entry) => entry.id),
        },
        parentRunId: input.run.id,
        parentThreadId: input.thread.id,
        parentSessionId: input.thread.sessionId,
      },
    });

    await waiter;
  }

  async emitWhisper(input: IntuitionWhisper): Promise<void> {
    await this.runtime.submitInput(input.parentThreadId, {
      message: stringToUserMessage(formatWhisperForMain(input.message)),
      source: INTUITION_SIDECAR_SOURCE,
      metadata: {
        intuitionSidecar: {
          kind: INTUITION_SIDECAR_KIND,
          parentRunId: input.parentRunId,
          sidecarThreadId: input.sidecarThreadId,
          ...(input.sidecarRunId ? {sidecarRunId: input.sidecarRunId} : {}),
        },
      },
    });

    const waiters = this.waiters.get(input.parentRunId);
    if (!waiters) {
      return;
    }

    this.waiters.delete(input.parentRunId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  async resolveDefinition(
    thread: ThreadRecord,
    session: SessionRecord,
  ): Promise<ResolvedThreadDefinition> {
    const binding = readSidecarBinding(thread.context) ?? readSidecarBinding(session.metadata);
    if (!binding) {
      throw new Error(`Thread ${thread.id} is not an intuition sidecar thread.`);
    }

    const context = {
      cwd: readCwd(thread),
      agentKey: session.agentKey,
      sessionId: binding.parentSessionId,
      threadId: thread.id,
      subagentDepth: 0,
      intuitionSidecar: {
        kind: INTUITION_SIDECAR_KIND,
        parentSessionId: binding.parentSessionId,
        sidecarSessionId: session.id,
        sidecarThreadId: thread.id,
      },
    };
    const llmContexts: LlmContext[] = buildDefaultAgentLlmContexts({
      context,
      agentStore: this.agentStore,
      wikiBindings: this.wikiBindings,
      agentKey: session.agentKey,
      threadId: thread.id,
      sections: ["environment", "wiki_overview", "skills"],
    });

    return {
      agent: new Agent({
        name: `${session.agentKey}-intuition`,
        instructions: INTUITION_SIDECAR_PROMPT,
        tools: this.buildTools(),
      }),
      context,
      llmContexts,
      model: resolveDefaultAgentIntuitionSidecarModelSelector(this.env)
        ?? thread.model
        ?? resolveRuntimeDefaultModelSelector(this.env),
      thinking: thread.thinking,
      temperature: thread.temperature,
    };
  }

  private buildTools(): readonly Tool[] {
    return [
      new CurrentDateTimeTool(),
      new PostgresReadonlyQueryTool({
        pool: this.pool,
      }),
      ...(this.wikiBindings
        ? [
          new WikiReadonlyTool({
            env: this.env,
            bindings: this.wikiBindings,
          }),
        ]
        : []),
      ...(hasBraveSearchApiKey(this.env) ? [new BraveSearchTool({env: this.env})] : []),
      new WebFetchTool(),
      new IntuitionWhisperTool({
        sink: this,
      }),
    ];
  }

  private async ensureSidecarThread(parentThread: ThreadRecord): Promise<ThreadRecord> {
    const parentSession = await this.sessionStore.getSession(parentThread.sessionId);
    const existing = (await this.sessionStore.listAgentSessions(parentSession.agentKey))
      .find((candidate) => candidate.kind === "sidecar"
        && readSidecarBinding(candidate.metadata)?.parentSessionId === parentSession.id);
    if (existing) {
      try {
        return await this.threadStore.getThread(existing.currentThreadId);
      } catch {
        return this.createReplacementSidecarThread(existing, parentThread);
      }
    }

    const sessionId = buildSidecarSessionId(parentSession.id);
    const threadId = buildSidecarThreadId(parentSession.id);
    const sessionInput = {
      id: sessionId,
      agentKey: parentSession.agentKey,
      kind: "sidecar" as const,
      currentThreadId: threadId,
      createdByIdentityId: parentSession.createdByIdentityId,
      metadata: buildSidecarMetadata(parentSession.id),
    };
    const threadInput = {
      id: threadId,
      sessionId,
      context: buildSidecarThreadContext({
        sessionId,
        agentKey: parentSession.agentKey,
        cwd: readCwd(parentThread),
        parentSessionId: parentSession.id,
      }),
    };

    if (
      this.pool
      && this.sessionStore instanceof PostgresSessionStore
      && this.threadStore instanceof PostgresThreadRuntimeStore
    ) {
      const created = await createSessionWithInitialThread({
        pool: this.pool,
        sessionStore: this.sessionStore,
        threadStore: this.threadStore,
        session: sessionInput,
        thread: threadInput,
      });
      return created.thread;
    }

    await this.sessionStore.createSession(sessionInput);
    return this.threadStore.createThread(threadInput);
  }

  private async createReplacementSidecarThread(
    session: SessionRecord,
    parentThread: ThreadRecord,
  ): Promise<ThreadRecord> {
    const thread = await this.threadStore.createThread({
      id: `${session.id}-thread-${randomUUID()}`,
      sessionId: session.id,
      context: buildSidecarThreadContext({
        sessionId: session.id,
        agentKey: session.agentKey,
        cwd: readCwd(parentThread),
        parentSessionId: parentThread.sessionId,
      }),
    });
    await this.sessionStore.updateCurrentThread({
      sessionId: session.id,
      currentThreadId: thread.id,
    });
    return thread;
  }

  private waitForWhisper(parentRunId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        const waiters = this.waiters.get(parentRunId);
        waiters?.delete(finish);
        if (waiters && waiters.size === 0) {
          this.waiters.delete(parentRunId);
        }
        resolve();
      };

      const waiters = this.waiters.get(parentRunId) ?? new Set<() => void>();
      waiters.add(finish);
      this.waiters.set(parentRunId, waiters);
      void sleep(timeoutMs).then(finish);
    });
  }
}
