import type {AssistantMessage, Message} from "@earendil-works/pi-ai";

import {Agent} from "../../kernel/agent/agent.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {joinMessageTextParts} from "../../kernel/agent/helpers/message-text.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Thread} from "../../kernel/agent/thread.js";
import type {AgentStore} from "../../domain/agents/store.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {ThreadDefinitionResolver} from "../../domain/threads/runtime/types.js";
import {renderSubagentHandoff} from "../../prompts/runtime/subagents.js";
import {resolveDefaultAgentModelSelector, resolveDefaultAgentSubagentModelSelector} from "../defaults.js";
import {buildDefaultAgentLlmContexts} from "../contexts/builder.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {WikiBindingService} from "../../domain/wiki/service.js";
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

export type DefaultAgentSubagentStore =
  Pick<ThreadRuntimeStore, "getThread">
  & Partial<Pick<ThreadRuntimeStore, "listToolJobs">>;

export interface DefaultAgentSubagentServiceOptions {
  store: DefaultAgentSubagentStore;
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
  return message ? joinMessageTextParts(message.content) : "";
}

function hasToolJobListing(
  store: DefaultAgentSubagentStore,
): store is DefaultAgentSubagentStore & Pick<ThreadRuntimeStore, "listToolJobs"> {
  return typeof store.listToolJobs === "function";
}

/**
 * Legacy in-process role runner retained for non-runtime policy/model tests.
 * V2 runtime delegation must go through durable `panda subagent spawn` / `SubagentSessionService`;
 * do not wire this service back into active model-facing delegation.
 */
export class DefaultAgentSubagentService {
  private readonly store: DefaultAgentSubagentStore;
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
    const threadStore = hasToolJobListing(this.store) ? this.store : undefined;
    const defaultRoleModel = resolveDefaultAgentSubagentModelSelector(input.role);
    const childThread = new Thread<DefaultAgentSessionContext>({
      agent: new Agent({
        name: `${childContext.agentKey}-${input.role}`,
        instructions: "",
        tools: childTools,
      }),
      messages: childMessages,
      // Subagents get only their role prompt and scoped runtime context.
      // Reusing the parent's prompt leaks main-agent policy into specialist subagents.
      systemPrompt: policy.prompt,
      maxTurns: parentDefinition.maxTurns,
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
      promptCacheKey: parentDefinition.promptCacheKey,
      runPipelines: parentDefinition.runPipelines,
      model: input.model ?? defaultRoleModel ?? parentDefinition.model ?? resolveDefaultAgentModelSelector(),
      temperature: parentDefinition.temperature,
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
