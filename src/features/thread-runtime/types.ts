import type { Message, ThinkingLevel } from "@mariozechner/pi-ai";

import type { Agent } from "../agent-core/agent.js";
import type { TokenCounter } from "../agent-core/helpers/token-count.js";
import type { Hook } from "../agent-core/hook.js";
import type { LlmContext } from "../agent-core/llm-context.js";
import type { ProviderName, JsonValue } from "../agent-core/types.js";
import type { LlmRuntime } from "../agent-core/runtime.js";
import type { RunPipeline } from "../agent-core/run-pipeline.js";

export interface CreateThreadInput {
  id: string;
  agentKey: string;
  systemPrompt?: string | ReadonlyArray<string>;
  maxTurns?: number;
  context?: JsonValue;
  maxInputTokens?: number;
  promptCacheKey?: string;
  provider?: ProviderName;
  model?: string;
  temperature?: number;
  thinking?: ThinkingLevel;
}

export type ThreadUpdate = Partial<Omit<CreateThreadInput, "id" | "thinking">> & {
  thinking?: ThinkingLevel | null;
};

export interface ThreadRecord extends CreateThreadInput {
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedThreadDefinition {
  agent: Agent<unknown>;
  systemPrompt?: string | ReadonlyArray<string>;
  maxTurns?: number;
  context?: unknown;
  llmContexts?: ReadonlyArray<LlmContext>;
  hooks?: ReadonlyArray<Hook>;
  maxInputTokens?: number;
  promptCacheKey?: string;
  runPipelines?: ReadonlyArray<RunPipeline>;
  provider?: ProviderName;
  model?: string;
  temperature?: number;
  thinking?: ThinkingLevel;
  runtime?: LlmRuntime;
  countTokens?: TokenCounter;
}

export type ThreadDefinitionResolver = (
  thread: ThreadRecord,
) => Promise<ResolvedThreadDefinition> | ResolvedThreadDefinition;

export type ThreadDefinitionFactory =
  | ResolvedThreadDefinition
  | ThreadDefinitionResolver;

export interface ThreadMessageMetadata {
  source: string;
  channelId?: string;
  externalMessageId?: string;
  actorId?: string;
}

export type ThreadMessageOrigin = "input" | "runtime";
export type ThreadInputDeliveryMode = "wake" | "queue";

export interface ThreadMessageRecord extends ThreadMessageMetadata {
  id: string;
  threadId: string;
  sequence: number;
  origin: ThreadMessageOrigin;
  message: Message;
  runId?: string;
  createdAt: number;
}

export interface ThreadSummaryRecord {
  thread: ThreadRecord;
  messageCount: number;
  pendingInputCount: number;
  lastMessage?: ThreadMessageRecord;
}

export interface ThreadInputRecord extends ThreadMessageMetadata {
  id: string;
  threadId: string;
  order: number;
  deliveryMode: ThreadInputDeliveryMode;
  message: Message;
  createdAt: number;
  appliedAt?: number;
}

export interface ThreadInputPayload extends ThreadMessageMetadata {
  message: Message;
}

export interface ThreadRuntimeMessagePayload extends ThreadMessageMetadata {
  message: Message;
  runId?: string;
}

export type ThreadRunStatus = "running" | "completed" | "failed";

export interface ThreadRunRecord {
  id: string;
  threadId: string;
  status: ThreadRunStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  abortRequestedAt?: number;
  abortReason?: string;
}

export class ThreadDefinitionRegistry {
  private readonly factories = new Map<string, ThreadDefinitionResolver>();

  register(agentKey: string, definition: ThreadDefinitionFactory): this {
    const resolver: ThreadDefinitionResolver =
      typeof definition === "function" ? definition : async () => definition;
    this.factories.set(agentKey, resolver);
    return this;
  }

  unregister(agentKey: string): void {
    this.factories.delete(agentKey);
  }

  async resolve(thread: ThreadRecord): Promise<ResolvedThreadDefinition> {
    const resolver = this.factories.get(thread.agentKey);
    if (!resolver) {
      throw new Error(`No thread definition registered for agent key ${thread.agentKey}.`);
    }

    return resolver(thread);
  }
}
