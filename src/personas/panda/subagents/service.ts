import type {AssistantMessage, Message} from "@mariozechner/pi-ai";

import {Agent, stringToUserMessage, Thread, ToolError} from "../../../kernel/agent/index.js";
import type {RunContext} from "../../../kernel/agent/run-context.js";
import type {AgentStore} from "../../../domain/agents/store.js";
import type {ThreadRuntimeStore} from "../../../domain/threads/runtime/store.js";
import type {ThreadDefinitionResolver} from "../../../domain/threads/runtime/types.js";
import {renderSubagentHandoff} from "../../../prompts/runtime/subagents.js";
import {
  resolveDefaultPandaExploreSubagentModelSelector,
  resolveDefaultPandaMemoryExplorerSubagentModelSelector,
} from "../defaults.js";
import {buildPandaLlmContexts} from "../contexts/builder.js";
import type {PandaSessionContext} from "../types.js";
import {filterToolsForSubagentRole, getPandaSubagentRolePolicy, type PandaSubagentRole,} from "./policy.js";

export interface PandaSubagentRunInput {
  run: RunContext<PandaSessionContext>;
  role: PandaSubagentRole;
  task: string;
  context?: string;
  model?: string;
}

export interface PandaSubagentRunResult {
  role: PandaSubagentRole;
  finalMessage: string;
  toolCallCount: number;
  durationMs: number;
}

export interface PandaSubagentServiceOptions {
  store: ThreadRuntimeStore;
  resolveDefinition: ThreadDefinitionResolver;
  agentStore?: AgentStore;
  maxSubagentDepth?: number;
}

function isPandaSessionContext(value: unknown): value is PandaSessionContext {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildSubagentSystemPrompt(
  parentSystemPrompt: string | readonly string[] | undefined,
  rolePrompt: string,
): string | readonly string[] {
  if (parentSystemPrompt === undefined) {
    return rolePrompt;
  }

  if (typeof parentSystemPrompt === "string") {
    return [parentSystemPrompt, rolePrompt];
  }

  return [...parentSystemPrompt, rolePrompt];
}

function buildSubagentContext(
  parentContext: PandaSessionContext | undefined,
  depth: number,
): PandaSessionContext {
  if (!parentContext?.agentKey || !parentContext?.sessionId || !parentContext?.threadId) {
    throw new ToolError("Subagents require agentKey, sessionId, and threadId in the current Panda session context.");
  }

  return {
    cwd: parentContext?.cwd,
    agentKey: parentContext.agentKey,
    sessionId: parentContext.sessionId,
    threadId: parentContext.threadId,
    subagentDepth: depth,
  };
}

function extractAssistantText(message: AssistantMessage | null): string {
  const text = message?.content.flatMap((part) => {
    return part.type === "text" && part.text.trim() ? [part.text.trim()] : [];
  }).join("\n\n") ?? "";
  return text.trim();
}

function resolveDefaultSubagentModelSelector(role: PandaSubagentRole): string | undefined {
  switch (role) {
    case "explore":
      return resolveDefaultPandaExploreSubagentModelSelector();
    case "memory_explorer":
      return resolveDefaultPandaMemoryExplorerSubagentModelSelector();
  }
}

export class PandaSubagentService {
  private readonly store: ThreadRuntimeStore;
  private readonly resolveDefinition: ThreadDefinitionResolver;
  private readonly agentStore?: PandaSubagentServiceOptions["agentStore"];
  private readonly maxSubagentDepth: number;

  constructor(options: PandaSubagentServiceOptions) {
    this.store = options.store;
    this.resolveDefinition = options.resolveDefinition;
    this.agentStore = options.agentStore;
    this.maxSubagentDepth = options.maxSubagentDepth ?? 1;
  }

  async runSubagent(input: PandaSubagentRunInput): Promise<PandaSubagentRunResult> {
    const parentContext = isPandaSessionContext(input.run.context) ? input.run.context : undefined;
    const currentDepth = parentContext?.subagentDepth ?? 0;
    if (currentDepth >= this.maxSubagentDepth) {
      throw new ToolError(
        `Subagent depth limit reached (${this.maxSubagentDepth}). Solve the task yourself.`,
        { details: { maxSubagentDepth: this.maxSubagentDepth, currentDepth } },
      );
    }

    const threadId = parentContext?.threadId?.trim();
    if (!threadId) {
      throw new ToolError("Subagents require a parent thread id in the current Panda runtime context.");
    }

    const threadRecord = await this.store.getThread(threadId);
    const parentDefinition = await this.resolveDefinition(threadRecord);
    const policy = getPandaSubagentRolePolicy(input.role);
    const childContext = buildSubagentContext(parentContext, currentDepth + 1);
    const childMessages: Message[] = [stringToUserMessage(renderSubagentHandoff(input.task, input.context))];
    const childTools = filterToolsForSubagentRole(input.run.agent.tools, input.role);
    const threadStore = typeof this.store.listBashJobs === "function" ? this.store : undefined;
    const defaultRoleModel = resolveDefaultSubagentModelSelector(input.role);
    const childThread = new Thread<PandaSessionContext>({
      agent: new Agent({
        name: `${childContext.agentKey}-${input.role}`,
        instructions: input.run.agent.instructions,
        tools: childTools,
      }),
      messages: childMessages,
      systemPrompt: buildSubagentSystemPrompt(
        parentDefinition.systemPrompt ?? threadRecord.systemPrompt,
        policy.prompt,
      ),
      maxTurns: parentDefinition.maxTurns ?? threadRecord.maxTurns,
        context: childContext,
        llmContexts: buildPandaLlmContexts({
          context: childContext,
          agentStore: this.agentStore,
          threadStore,
          agentKey: childContext.agentKey,
          threadId,
          sections: policy.visibleContextSections,
        }),
      maxInputTokens: parentDefinition.maxInputTokens ?? threadRecord.maxInputTokens,
      promptCacheKey: parentDefinition.promptCacheKey ?? threadRecord.promptCacheKey,
      runPipelines: parentDefinition.runPipelines,
      model: input.model ?? defaultRoleModel ?? parentDefinition.model ?? threadRecord.model,
      temperature: parentDefinition.temperature ?? threadRecord.temperature,
      thinking: policy.thinking,
      runtime: parentDefinition.runtime,
      countTokens: parentDefinition.countTokens,
      signal: input.run.signal,
    });

    const startedAt = Date.now();
    let finalAssistant: AssistantMessage | null = null;

    try {
      for await (const event of childThread.run()) {
        if ("role" in event && event.role === "assistant") {
          finalAssistant = event;
        }
      }
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Unknown subagent failure.";
      throw new ToolError(`Subagent failed: ${message}`, {
        details: {
          role: input.role,
        },
      });
    }

    const finalMessage = extractAssistantText(finalAssistant);
    if (!finalMessage) {
      throw new ToolError("Subagent completed without a textual final message.", {
        details: { role: input.role },
      });
    }

    return {
      role: input.role,
      finalMessage,
      toolCallCount: childThread.messages.filter((message) => message.role === "toolResult").length,
      durationMs: Date.now() - startedAt,
    };
  }
}
