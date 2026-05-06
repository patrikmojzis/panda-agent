import {createHash, randomUUID} from "node:crypto";

import {Agent} from "../../kernel/agent/agent.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import type {LlmContext} from "../../kernel/agent/llm-context.js";
import type {JsonObject} from "../../kernel/agent/types.js";
import type {Tool} from "../../kernel/agent/tool.js";
import type {AgentStore} from "../../domain/agents/store.js";
import {
  createSessionWithInitialThread,
  PostgresSessionStore,
  type SessionRecord,
  type SessionStore,
} from "../../domain/sessions/index.js";
import {
  PostgresThreadRuntimeStore,
  type ResolvedThreadDefinition,
  type ThreadInputPayload,
  type ThreadRecord,
  type ThreadRuntimeAfterRunFinishInput,
  type ThreadRuntimeBeforeRunStepInput,
  type ThreadRuntimeCheckpointInput,
} from "../../domain/threads/runtime/index.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {PgPoolLike} from "../../domain/threads/runtime/postgres-db.js";
import type {WikiBindingService} from "../../domain/wiki/index.js";
import {
  SIDECAR_EVENT_SOURCE,
  SIDECAR_INPUT_SOURCE,
  SIDECAR_SESSION_BINDING_KIND,
  type SidecarDefinitionRecord,
  type SidecarTrigger,
} from "../../domain/sidecars/index.js";
import type {PostgresSidecarRepo} from "../../domain/sidecars/repo.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined, truncateText} from "../../lib/strings.js";
import {resolveRuntimeDefaultModelSelector} from "../../kernel/models/default-model.js";
import {buildDefaultAgentLlmContexts} from "../../panda/contexts/builder.js";
import {BraveSearchTool, hasBraveSearchApiKey} from "../../panda/tools/brave-search-tool.js";
import {CurrentDateTimeTool} from "../../panda/tools/current-datetime-tool.js";
import {
  PostgresReadonlyQueryTool,
  type PostgresReadonlyQueryToolOptions,
} from "../../panda/tools/postgres-readonly-query-tool.js";
import {type SidecarNote, type SidecarNoteSink, SendToMainTool} from "../../panda/tools/send-to-main-tool.js";
import {WebFetchTool} from "../../panda/tools/web-fetch-tool.js";
import {WikiReadonlyTool} from "../../panda/tools/wiki-tool.js";
import {renderSidecarEventPrompt} from "../../prompts/runtime/sidecar.js";

export interface SidecarBinding {
  parentSessionId: string;
  sidecarKey: string;
}

export interface SidecarRuntime {
  submitInput(
    threadId: string,
    payload: ThreadInputPayload,
    mode?: "wake" | "queue",
  ): Promise<void>;
}

export interface SidecarServiceOptions {
  sessionStore: SessionStore;
  threadStore: ThreadRuntimeStore;
  sidecarRepo: Pick<PostgresSidecarRepo, "getDefinition" | "listAgentDefinitions">;
  runtime: SidecarRuntime;
  pool?: PgPoolLike;
  postgresReadonly?: PostgresReadonlyQueryToolOptions;
  agentStore?: AgentStore;
  wikiBindings?: Pick<WikiBindingService, "getBinding">;
  env?: NodeJS.ProcessEnv;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readSidecarBinding(value: unknown): SidecarBinding | null {
  if (!isRecord(value)) {
    return null;
  }

  const sidecar = isRecord(value.sidecar) ? value.sidecar : null;
  if (!sidecar || sidecar.kind !== SIDECAR_SESSION_BINDING_KIND) {
    return null;
  }

  const parentSessionId = readString(sidecar.parentSessionId);
  const sidecarKey = readString(sidecar.sidecarKey);
  return parentSessionId && sidecarKey ? {parentSessionId, sidecarKey} : null;
}

function buildSidecarSessionId(parentSessionId: string, sidecarKey: string): string {
  return `sidecar-${sidecarKey}-${parentSessionId}`;
}

function buildSidecarThreadId(parentSessionId: string, sidecarKey: string): string {
  return `${buildSidecarSessionId(parentSessionId, sidecarKey)}-thread`;
}

export function buildSidecarPromptCacheKey(parentSessionId: string, sidecarKey: string): string {
  const parentHash = createHash("sha256").update(parentSessionId).digest("hex").slice(0, 12);
  return `sidecar:${sidecarKey}:${parentHash}`;
}

function buildSidecarMetadata(input: SidecarBinding): JsonObject {
  return {
    sidecar: {
      kind: SIDECAR_SESSION_BINDING_KIND,
      parentSessionId: input.parentSessionId,
      sidecarKey: input.sidecarKey,
    },
  };
}

function buildSidecarThreadContext(input: {
  sessionId: string;
  agentKey: string;
  parentSessionId: string;
  sidecarKey: string;
  cwd?: string;
}): JsonObject {
  return {
    sessionId: input.sessionId,
    agentKey: input.agentKey,
    ...(input.cwd ? {cwd: input.cwd} : {}),
    ...buildSidecarMetadata({
      parentSessionId: input.parentSessionId,
      sidecarKey: input.sidecarKey,
    }),
  };
}

function readCwd(thread: ThreadRecord): string | undefined {
  return isRecord(thread.context) ? trimToUndefined(thread.context.cwd) : undefined;
}

function isMissingSessionError(error: unknown, sessionId: string): boolean {
  return error instanceof Error && error.message === `Unknown session ${sessionId}`;
}

function formatNoteForMain(input: Pick<SidecarNote, "message" | "sidecarKey">): string {
  return [
    `[Sidecar note: ${input.sidecarKey}]`,
    truncateText(input.message.trim(), 4_000),
  ].join("\n");
}

function runHasOnlySidecarInputs(messages: readonly {origin: string; source: string}[]): boolean {
  const appliedInputs = messages.filter((entry) => entry.origin === "input");
  return appliedInputs.length > 0 && appliedInputs.every((entry) => entry.source === SIDECAR_INPUT_SOURCE);
}

export class SidecarService implements SidecarNoteSink {
  private readonly sessionStore: SessionStore;
  private readonly threadStore: ThreadRuntimeStore;
  private readonly sidecarRepo: Pick<PostgresSidecarRepo, "getDefinition" | "listAgentDefinitions">;
  private readonly runtime: SidecarRuntime;
  private readonly pool?: PgPoolLike;
  private readonly postgresReadonly?: PostgresReadonlyQueryToolOptions;
  private readonly agentStore?: AgentStore;
  private readonly wikiBindings?: Pick<WikiBindingService, "getBinding">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sidecarThreadCreates = new Map<string, Promise<ThreadRecord>>();

  constructor(options: SidecarServiceOptions) {
    this.sessionStore = options.sessionStore;
    this.threadStore = options.threadStore;
    this.sidecarRepo = options.sidecarRepo;
    this.runtime = options.runtime;
    this.pool = options.pool;
    this.postgresReadonly = options.postgresReadonly;
    this.agentStore = options.agentStore;
    this.wikiBindings = options.wikiBindings;
    this.env = options.env ?? process.env;
  }

  isSidecarThread(thread: Pick<ThreadRecord, "context">): boolean {
    return readSidecarBinding(thread.context) !== null;
  }

  async beforeRunStep(input: ThreadRuntimeBeforeRunStepInput): Promise<void> {
    await this.dispatch({
      trigger: "before_run_step",
      run: input.run,
      mainThread: input.thread,
      messages: input.messages,
    });
  }

  async afterCheckpoint(input: ThreadRuntimeCheckpointInput): Promise<void> {
    const trigger = input.checkpoint.phase === "after_assistant"
      ? "after_assistant"
      : "after_tool_result";
    await this.dispatch({
      trigger,
      run: input.run,
      mainThread: input.thread,
      messages: input.messages,
      checkpoint: input.checkpoint,
    });
  }

  async afterRunFinish(input: ThreadRuntimeAfterRunFinishInput): Promise<void> {
    if (input.run.status !== "completed") {
      return;
    }

    await this.dispatch({
      trigger: "after_run_finish",
      run: input.run,
      mainThread: input.thread,
      messages: input.messages,
    });
  }

  async sendToMain(input: SidecarNote): Promise<void> {
    await this.runtime.submitInput(input.parentThreadId, {
      message: stringToUserMessage(formatNoteForMain(input)),
      source: SIDECAR_INPUT_SOURCE,
      externalMessageId: `sidecar_note:${input.sidecarKey}:${input.parentRunId}:${randomUUID()}`,
      metadata: {
        sidecar: {
          kind: SIDECAR_SESSION_BINDING_KIND,
          sidecarKey: input.sidecarKey,
          parentRunId: input.parentRunId,
          sidecarThreadId: input.sidecarThreadId,
          ...(input.sidecarRunId ? {sidecarRunId: input.sidecarRunId} : {}),
        },
      },
    });
  }

  async resolveDefinition(
    thread: ThreadRecord,
    session: SessionRecord,
  ): Promise<ResolvedThreadDefinition> {
    const binding = readSidecarBinding(thread.context) ?? readSidecarBinding(session.metadata);
    if (!binding) {
      throw new Error(`Thread ${thread.id} is not a sidecar thread.`);
    }

    const sidecar = await this.sidecarRepo.getDefinition(session.agentKey, binding.sidecarKey);
    const context = {
      cwd: readCwd(thread),
      agentKey: session.agentKey,
      sessionId: binding.parentSessionId,
      threadId: thread.id,
      subagentDepth: 0,
      sidecar: {
        kind: SIDECAR_SESSION_BINDING_KIND,
        sidecarKey: binding.sidecarKey,
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
        name: `${session.agentKey}-${sidecar.sidecarKey}`,
        instructions: sidecar.prompt,
        tools: this.buildTools(sidecar),
      }),
      context,
      llmContexts,
      promptCacheKey: buildSidecarPromptCacheKey(binding.parentSessionId, sidecar.sidecarKey),
      model: sidecar.model ?? thread.model ?? resolveRuntimeDefaultModelSelector(this.env),
      thinking: sidecar.thinking ?? thread.thinking,
      temperature: thread.temperature,
    };
  }

  private buildTools(sidecar: SidecarDefinitionRecord): readonly Tool[] {
    if (sidecar.toolset !== "readonly") {
      throw new Error(`Unsupported sidecar toolset ${sidecar.toolset}.`);
    }

    return [
      new CurrentDateTimeTool(),
      new PostgresReadonlyQueryTool(this.postgresReadonly ?? {pool: this.pool}),
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
      new SendToMainTool({
        sink: this,
      }),
    ];
  }

  private async dispatch(input: {
    trigger: SidecarTrigger;
    run: ThreadRuntimeAfterRunFinishInput["run"];
    mainThread: ThreadRecord;
    messages: readonly ThreadRuntimeAfterRunFinishInput["messages"][number][];
    checkpoint?: ThreadRuntimeCheckpointInput["checkpoint"];
  }): Promise<void> {
    if (this.isSidecarThread(input.mainThread)) {
      return;
    }
    if (input.messages.length === 0) {
      return;
    }
    if (runHasOnlySidecarInputs(input.messages)) {
      return;
    }

    const mainSession = await this.sessionStore.getSession(input.mainThread.sessionId);
    const sidecars = (await this.sidecarRepo.listAgentDefinitions(mainSession.agentKey, {enabled: true}))
      .filter((sidecar) => sidecar.triggers.includes(input.trigger));
    await Promise.all(sidecars.map(async (sidecar) => {
      const sidecarThread = await this.ensureSidecarThread(input.mainThread, sidecar);
      await this.runtime.submitInput(sidecarThread.id, {
        message: stringToUserMessage(renderSidecarEventPrompt({
          trigger: input.trigger,
          sidecar,
          run: input.run,
          mainThread: input.mainThread,
          checkpoint: input.checkpoint,
        })),
        source: SIDECAR_EVENT_SOURCE,
        externalMessageId: `sidecar_event:${sidecar.sidecarKey}:${input.trigger}:${input.run.id}:${randomUUID()}`,
        metadata: {
          sidecar: {
            kind: SIDECAR_SESSION_BINDING_KIND,
            sidecarKey: sidecar.sidecarKey,
            trigger: input.trigger,
            parentRunId: input.run.id,
            parentThreadId: input.mainThread.id,
            parentSessionId: input.mainThread.sessionId,
          },
          sidecarKey: sidecar.sidecarKey,
          trigger: input.trigger,
          parentRunId: input.run.id,
          parentThreadId: input.mainThread.id,
          parentSessionId: input.mainThread.sessionId,
        },
      });
    }));
  }

  private async ensureSidecarThread(
    parentThread: ThreadRecord,
    sidecar: SidecarDefinitionRecord,
  ): Promise<ThreadRecord> {
    const parentSession = await this.sessionStore.getSession(parentThread.sessionId);
    const sessionId = buildSidecarSessionId(parentSession.id, sidecar.sidecarKey);
    const threadId = buildSidecarThreadId(parentSession.id, sidecar.sidecarKey);
    const inFlight = this.sidecarThreadCreates.get(sessionId);
    if (inFlight) {
      return inFlight;
    }

    const creation = this.ensureSidecarThreadUnlocked({
      parentThread,
      parentSession,
      sidecar,
      sessionId,
      threadId,
    }).finally(() => {
      this.sidecarThreadCreates.delete(sessionId);
    });
    this.sidecarThreadCreates.set(sessionId, creation);
    return creation;
  }

  private async ensureSidecarThreadUnlocked(input: {
    parentThread: ThreadRecord;
    parentSession: SessionRecord;
    sidecar: SidecarDefinitionRecord;
    sessionId: string;
    threadId: string;
  }): Promise<ThreadRecord> {
    const {parentThread, parentSession, sidecar, sessionId, threadId} = input;
    try {
      const existing = await this.sessionStore.getSession(sessionId);
      const binding = readSidecarBinding(existing.metadata);
      if (existing.kind !== "sidecar"
        || binding?.parentSessionId !== parentSession.id
        || binding.sidecarKey !== sidecar.sidecarKey) {
        throw new Error(`Session ${sessionId} exists but is not the ${sidecar.sidecarKey} sidecar for ${parentSession.id}.`);
      }
      try {
        return await this.threadStore.getThread(existing.currentThreadId);
      } catch {
        return this.createReplacementSidecarThread(existing, parentThread, sidecar);
      }
    } catch (error) {
      if (!isMissingSessionError(error, sessionId)) {
        throw error;
      }
    }

    const binding = {
      parentSessionId: parentSession.id,
      sidecarKey: sidecar.sidecarKey,
    };
    const sessionInput = {
      id: sessionId,
      agentKey: parentSession.agentKey,
      kind: "sidecar" as const,
      currentThreadId: threadId,
      createdByIdentityId: parentSession.createdByIdentityId,
      metadata: buildSidecarMetadata(binding),
    };
    const threadInput = {
      id: threadId,
      sessionId,
      promptCacheKey: buildSidecarPromptCacheKey(parentSession.id, sidecar.sidecarKey),
      context: buildSidecarThreadContext({
        sessionId,
        agentKey: parentSession.agentKey,
        cwd: readCwd(parentThread),
        parentSessionId: parentSession.id,
        sidecarKey: sidecar.sidecarKey,
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
    sidecar: SidecarDefinitionRecord,
  ): Promise<ThreadRecord> {
    const thread = await this.threadStore.createThread({
      id: `${session.id}-thread-${randomUUID()}`,
      sessionId: session.id,
      promptCacheKey: buildSidecarPromptCacheKey(parentThread.sessionId, sidecar.sidecarKey),
      context: buildSidecarThreadContext({
        sessionId: session.id,
        agentKey: session.agentKey,
        cwd: readCwd(parentThread),
        parentSessionId: parentThread.sessionId,
        sidecarKey: sidecar.sidecarKey,
      }),
    });
    await this.sessionStore.updateCurrentThread({
      sessionId: session.id,
      currentThreadId: thread.id,
    });
    return thread;
  }
}
