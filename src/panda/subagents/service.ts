import type {AssistantMessage, Message} from "@mariozechner/pi-ai";

import {Agent, stringToUserMessage, Thread, ToolError} from "../../kernel/agent/index.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {AgentStore} from "../../domain/agents/store.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {ThreadDefinitionResolver} from "../../domain/threads/runtime/types.js";
import {renderSubagentHandoff} from "../../prompts/runtime/subagents.js";
import {
    resolveDefaultAgentBrowserSubagentModelSelector,
    resolveDefaultAgentMemorySubagentModelSelector,
    resolveDefaultAgentSkillMaintainerSubagentModelSelector,
    resolveDefaultAgentWorkspaceSubagentModelSelector,
} from "../defaults.js";
import {buildDefaultAgentLlmContexts} from "../contexts/builder.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {WikiBindingService} from "../../domain/wiki/index.js";
import type {DefaultAgentToolsets} from "../definition.js";
import {type DefaultAgentSubagentRole, getDefaultAgentSubagentRolePolicy,} from "./policy.js";

export interface DefaultAgentSubagentRunInput {
  run: RunContext<DefaultAgentSessionContext>;
  role: DefaultAgentSubagentRole;
  task: string;
  context?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface DefaultAgentSubagentRunResult {
  role: DefaultAgentSubagentRole;
  finalMessage: string;
  toolCallCount: number;
  durationMs: number;
}

export interface DefaultAgentSubagentServiceOptions {
  store: ThreadRuntimeStore;
  resolveDefinition: ThreadDefinitionResolver;
  toolsets: Pick<DefaultAgentToolsets, "workspace" | "memory" | "browser" | "skill_maintainer">;
  agentStore?: AgentStore;
  wikiBindings?: Pick<WikiBindingService, "getBinding">;
  maxSubagentDepth?: number;
}

function isDefaultAgentSessionContext(value: unknown): value is DefaultAgentSessionContext {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildSubagentContext(
  parentContext: DefaultAgentSessionContext | undefined,
  depth: number,
): DefaultAgentSessionContext {
  if (!parentContext?.agentKey || !parentContext?.sessionId || !parentContext?.threadId) {
    throw new ToolError("Subagents require agentKey, sessionId, and threadId in the current runtime session context.");
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

function resolveDefaultSubagentModelSelector(role: DefaultAgentSubagentRole): string | undefined {
  switch (role) {
    case "workspace":
      return resolveDefaultAgentWorkspaceSubagentModelSelector();
    case "memory":
      return resolveDefaultAgentMemorySubagentModelSelector();
    case "browser":
      return resolveDefaultAgentBrowserSubagentModelSelector();
    case "skill_maintainer":
      return resolveDefaultAgentSkillMaintainerSubagentModelSelector();
  }
}

export class DefaultAgentSubagentService {
  private readonly store: ThreadRuntimeStore;
  private readonly resolveDefinition: ThreadDefinitionResolver;
  private readonly toolsets: Pick<DefaultAgentToolsets, "workspace" | "memory" | "browser" | "skill_maintainer">;
  private readonly agentStore?: DefaultAgentSubagentServiceOptions["agentStore"];
  private readonly wikiBindings?: DefaultAgentSubagentServiceOptions["wikiBindings"];
  private readonly maxSubagentDepth: number;

  constructor(options: DefaultAgentSubagentServiceOptions) {
    this.store = options.store;
    this.resolveDefinition = options.resolveDefinition;
    this.toolsets = options.toolsets;
    this.agentStore = options.agentStore;
    this.wikiBindings = options.wikiBindings;
    this.maxSubagentDepth = options.maxSubagentDepth ?? 1;
  }

  async runSubagent(input: DefaultAgentSubagentRunInput): Promise<DefaultAgentSubagentRunResult> {
    const parentContext = isDefaultAgentSessionContext(input.run.context) ? input.run.context : undefined;
    const currentDepth = parentContext?.subagentDepth ?? 0;
    if (currentDepth >= this.maxSubagentDepth) {
      throw new ToolError(
        `Subagent depth limit reached (${this.maxSubagentDepth}). Solve the task yourself.`,
        { details: { maxSubagentDepth: this.maxSubagentDepth, currentDepth } },
      );
    }

    const threadId = parentContext?.threadId?.trim();
    if (!threadId) {
      throw new ToolError("Subagents require a parent thread id in the current runtime context.");
    }

    const threadRecord = await this.store.getThread(threadId);
    const parentDefinition = await this.resolveDefinition(threadRecord);
    const policy = getDefaultAgentSubagentRolePolicy(input.role);
    const childContext = buildSubagentContext(parentContext, currentDepth + 1);
    const childMessages: Message[] = [stringToUserMessage(renderSubagentHandoff(input.task, input.context))];
    const childTools = this.toolsets[policy.toolset];
    const threadStore = typeof this.store.listToolJobs === "function" ? this.store : undefined;
    const defaultRoleModel = resolveDefaultSubagentModelSelector(input.role);
    const childThread = new Thread<DefaultAgentSessionContext>({
      agent: new Agent({
        name: `${childContext.agentKey}-${input.role}`,
        instructions: "",
        tools: childTools,
      }),
      messages: childMessages,
      // Subagents get only their role prompt and scoped runtime context.
      // Reusing the parent's prompt leaks main-agent policy into specialist workers.
      systemPrompt: policy.prompt,
      maxTurns: parentDefinition.maxTurns ?? threadRecord.maxTurns,
      context: childContext,
      llmContexts: buildDefaultAgentLlmContexts({
        context: childContext,
        agentStore: this.agentStore,
        threadStore,
        wikiBindings: this.wikiBindings,
        agentKey: childContext.agentKey,
        threadId,
        sections: policy.visibleContextSections,
      }),
      promptCacheKey: parentDefinition.promptCacheKey ?? threadRecord.promptCacheKey,
      runPipelines: parentDefinition.runPipelines,
      model: input.model ?? defaultRoleModel ?? parentDefinition.model ?? threadRecord.model,
      temperature: parentDefinition.temperature ?? threadRecord.temperature,
      thinking: policy.thinking,
      runtime: parentDefinition.runtime,
      countTokens: parentDefinition.countTokens,
      signal: input.signal ?? input.run.signal,
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
