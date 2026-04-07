import type {
  AssistantMessage,
  Message,
  ThinkingLevel,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

import type { Agent } from "./agent.js";
import {
  InvalidJSONResponseError,
  InvalidSchemaResponseError,
  MaxTurnsReachedError,
  StreamingFailedError,
  ToolError,
} from "./exceptions.js";
import { estimateTokensFromString, type TokenCounter } from "./helpers/token-count.js";
import { gatherContexts, type LlmContext } from "./llm-context.js";
import type { Hook } from "./hook.js";
import {
  buildConversationContext,
  buildToolResultMessage,
  collectAssistantToolCalls,
} from "./pi/messages.js";
import { PiAiRuntime } from "./pi/runtime.js";
import { assertProviderName, getProviderConfig, type ProviderName } from "./provider.js";
import { RunContext } from "./run-context.js";
import type { LlmRuntime, LlmRuntimeRequest } from "./runtime.js";
import type { RunPipeline } from "./run-pipeline.js";
import { throwIfAborted } from "./abort.js";
import type { ThreadCheckpointDecision, ThreadCheckpointHandler } from "./thread-checkpoint.js";
import { Tool, isToolResultPayload } from "./tool.js";
import type {
  JsonValue,
  ThreadRunEvent,
  ThreadStreamEvent,
  ToolResultContent,
  ToolProgressEvent,
} from "./types.js";

export interface ThreadOptions<TContext = unknown, TOutput = unknown> {
  agent: Agent<TOutput>;
  messages?: ReadonlyArray<Message>;
  systemPrompt?: string | ReadonlyArray<string>;
  maxTurns?: number;
  context?: TContext;
  llmContexts?: ReadonlyArray<LlmContext>;
  hooks?: ReadonlyArray<Hook<TContext>>;
  maxInputTokens?: number;
  promptCacheKey?: string;
  runPipelines?: ReadonlyArray<RunPipeline<TContext>>;
  provider?: ProviderName;
  model?: string;
  temperature?: number;
  thinking?: ThinkingLevel;
  runtime?: LlmRuntime;
  countTokens?: TokenCounter;
  signal?: AbortSignal;
  checkpoint?: ThreadCheckpointHandler;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyJson(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function extractMessageText(message: AssistantMessage): string {
  const text = message.content.flatMap((part) => {
    return part.type === "text" && part.text ? [part.text] : [];
  }).join("");

  if (!text) {
    throw new InvalidJSONResponseError("No textual content found in output item");
  }

  return text;
}

function formatToolErrorText(message: string, details?: JsonValue): string {
  if (details === undefined) {
    return message;
  }

  const serializedDetails = stringifyJson(details);
  if (!serializedDetails || serializedDetails === message) {
    return message;
  }

  return `${message}\n\n${serializedDetails}`;
}

function textToolResultContent(text: string): ToolResultContent {
  return [{ type: "text", text }];
}

function isAssistantMessage(event: ThreadRunEvent): event is AssistantMessage {
  return "role" in event && event.role === "assistant";
}

export class Thread<TContext = unknown, TOutput = unknown> {
  readonly agent: Agent<TOutput>;
  readonly maxTurns: number;
  readonly context?: TContext;
  readonly llmContexts?: ReadonlyArray<LlmContext>;
  readonly hooks?: ReadonlyArray<Hook<TContext>>;
  turnCount = 0;
  readonly maxInputTokens?: number;
  readonly promptCacheKey?: string;
  readonly runPipelines?: ReadonlyArray<RunPipeline<TContext>>;
  readonly systemPrompt?: string | ReadonlyArray<string>;
  readonly model: string;
  readonly temperature?: number;
  readonly thinking?: ThinkingLevel;

  private readonly providerName: ProviderName;
  private readonly runtime: LlmRuntime;
  private readonly countTokens: TokenCounter;
  private readonly history: Message[];
  private readonly signal?: AbortSignal;
  private readonly checkpoint?: ThreadCheckpointHandler;

  constructor(options: ThreadOptions<TContext, TOutput>) {
    this.agent = options.agent;
    this.maxTurns = options.maxTurns ?? 100;
    this.history = [...(options.messages ?? [])];
    this.systemPrompt = options.systemPrompt;
    this.context = options.context;
    this.llmContexts = options.llmContexts;
    this.hooks = options.hooks;
    this.maxInputTokens = options.maxInputTokens;
    this.promptCacheKey = options.promptCacheKey;
    this.runPipelines = options.runPipelines;
    this.providerName = options.provider === undefined ? "openai" : assertProviderName(options.provider);
    this.model = options.model ?? getProviderConfig(this.providerName).defaultModel;
    this.temperature = options.temperature;
    this.thinking = options.thinking;
    this.runtime = options.runtime ?? new PiAiRuntime();
    this.countTokens = options.countTokens ?? estimateTokensFromString;
    this.signal = options.signal;
    this.checkpoint = options.checkpoint;
  }

  get messages(): readonly Message[] {
    return this.history;
  }

  addMessage(message: Message): void {
    this.history.push(message);
  }

  createRunContext(runMessages: Message[]): RunContext<TContext> {
    return new RunContext({
      agent: this.agent,
      turn: this.turnCount,
      maxTurns: this.maxTurns,
      messages: runMessages,
      context: this.context,
      signal: this.signal,
    });
  }

  private resolveCheckpointDecision(
    decision?: ThreadCheckpointDecision | void,
  ): ThreadCheckpointDecision {
    return decision ?? { action: "continue" };
  }

  private buildCancelledToolResultMessage(
    toolCall: ToolCall,
    reason?: string,
  ): ToolResultMessage<JsonValue> {
    return buildToolResultMessage({
      toolCall,
      content: textToolResultContent(reason ?? "Tool call cancelled before execution."),
      isError: true,
      details: reason ? { cancelled: true, reason } : { cancelled: true },
    });
  }

  private async *emitCancelledToolResults(
    toolCalls: readonly ToolCall[],
    runContext: RunContext<TContext>,
    reason?: string,
  ): AsyncGenerator<ToolResultMessage<JsonValue>> {
    for (const toolCall of toolCalls) {
      const cancelledResult = this.buildCancelledToolResultMessage(toolCall, reason);
      this.addMessage(cancelledResult);
      runContext.messages.push(cancelledResult);
      yield cancelledResult;
    }
  }

  private async prepareTurn(): Promise<{
    runMessages: Message[];
    runContext: RunContext<TContext>;
  }> {
    throwIfAborted(this.signal);
    this.verifyMaxTurns();

    if (this.runPipelines?.length) {
      await Promise.all(this.runPipelines.map((pipeline) => pipeline.preflight(this)));
    }

    const runMessages = await this.getRunInput();
    const runContext = this.createRunContext([...runMessages]);

    if (this.hooks?.length) {
      await Promise.all(this.hooks.map((hook) => hook.onStart(runContext)));
    }

    return {
      runMessages,
      runContext,
    };
  }

  private async finalizeAssistantTurn(
    response: AssistantMessage,
    runContext: RunContext<TContext>,
  ): Promise<ToolCall[]> {
    this.addMessage(response);
    runContext.messages.push(response);

    if (this.hooks?.length) {
      await Promise.all(this.hooks.map((hook) => hook.onEnd(runContext, response)));
    }

    if (this.runPipelines?.length) {
      await Promise.all(this.runPipelines.map((pipeline) => pipeline.postflight(this, response)));
    }

    return collectAssistantToolCalls(response);
  }

  async *executeToolCalls<TNextEvent>(
    functionCalls: ToolCall[],
    runContext: RunContext<TContext>,
    nextTurn: () => AsyncGenerator<TNextEvent>,
  ): AsyncGenerator<ToolProgressEvent | ToolResultMessage<JsonValue> | TNextEvent> {
    for (const [index, call] of functionCalls.entries()) {
      const progressQueue: ToolProgressEvent[] = [];
      let wakeProgressWaiter: (() => void) | undefined;

      const toolRunContext = new RunContext({
        agent: runContext.agent,
        turn: runContext.turn,
        maxTurns: runContext.maxTurns,
        messages: runContext.messages,
        context: runContext.context,
        signal: this.signal,
        onToolProgress: (progress) => {
          progressQueue.push({
            type: "tool_progress",
            toolCallId: call.id,
            toolName: call.name,
            details: progress,
            timestamp: Date.now(),
          });

          wakeProgressWaiter?.();
          wakeProgressWaiter = undefined;
        },
      });

      throwIfAborted(this.signal);

      let response: ToolResultMessage<JsonValue> | undefined;
      let toolError: unknown;
      let toolCompleted = false;

      const toolPromise = this.callTool(call, toolRunContext)
        .then((toolResultMessage) => {
          response = toolResultMessage;
        })
        .catch((error) => {
          toolError = error;
        })
        .finally(() => {
          toolCompleted = true;
          wakeProgressWaiter?.();
          wakeProgressWaiter = undefined;
        });

      while (!toolCompleted || progressQueue.length > 0) {
        if (progressQueue.length > 0) {
          const progressEvent = progressQueue.shift();
          if (progressEvent) {
            yield progressEvent;
          }
          continue;
        }

        await new Promise<void>((resolve) => {
          wakeProgressWaiter = resolve;
        });
      }

      await toolPromise;
      throwIfAborted(this.signal);

      if (toolError) {
        throw toolError;
      }

      if (!response) {
        continue;
      }

      this.addMessage(response);
      runContext.messages.push(response);
      yield response;

      if (this.checkpoint) {
        const remainingToolCalls = functionCalls.slice(index + 1);
        const decision = this.resolveCheckpointDecision(await this.checkpoint({
          phase: "after_tool_result",
          runContext,
          toolCall: call,
          toolResult: response,
          remainingToolCalls,
        }));

        if (decision.action === "interrupt") {
          if (decision.cancelPendingToolCalls !== false) {
            yield* this.emitCancelledToolResults(remainingToolCalls, runContext, decision.reason);
          }

          return;
        }
      }
    }

    yield* nextTurn();
  }

  async getRunInput(): Promise<Message[]> {
    if (!this.maxInputTokens) {
      return [...this.history];
    }

    const trimmedMessages: Message[] = [];
    let currentTokens = 0;

    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const message = this.history[index];
      if (!message) {
        continue;
      }

      const messageTokens = this.countTokens(JSON.stringify(message));
      if (currentTokens + messageTokens > this.maxInputTokens) {
        break;
      }

      trimmedMessages.unshift(message);
      currentTokens += messageTokens;
    }

    return trimmedMessages;
  }

  async parseStructuredOutput(output: AssistantMessage): Promise<TOutput> {
    const text = extractMessageText(output);

    try {
      const parsed = JSON.parse(text);
      if (!this.agent.outputSchema) {
        return parsed as TOutput;
      }

      return await this.agent.outputSchema.parseAsync(parsed);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new InvalidJSONResponseError(error.message);
      }

      throw new InvalidSchemaResponseError(stringifyUnknown(error));
    }
  }

  async callTool(
    toolCall: ToolCall,
    runContext: RunContext<TContext>,
  ): Promise<ToolResultMessage<JsonValue>> {
    throwIfAborted(this.signal);
    const tool = this.agent.tools.find((candidate) => candidate.name === toolCall.name);

    if (!tool) {
      return buildToolResultMessage({
        toolCall,
        content: textToolResultContent(`No tool found with name ${toolCall.name}`),
        isError: true,
      });
    }

    try {
      const output = await tool.run(toolCall.arguments ?? {}, runContext);
      if (isToolResultPayload(output)) {
        return buildToolResultMessage({
          toolCall,
          content: output.content,
          isError: false,
          details: output.details,
        });
      }

      return buildToolResultMessage({
        toolCall,
        content: textToolResultContent(stringifyJson(output)),
        isError: false,
        details: output,
      });
    } catch (error) {
      if (error instanceof ToolError) {
        return buildToolResultMessage({
          toolCall,
          content: error.content ?? textToolResultContent(formatToolErrorText(error.message, error.details)),
          isError: true,
          details: error.details,
        });
      }

      throw error;
    }
  }

  verifyMaxTurns(): void {
    if (this.turnCount >= this.maxTurns) {
      throw new MaxTurnsReachedError();
    }

    this.turnCount += 1;
  }

  private async buildRuntimeRequest(runMessages: Message[]): Promise<LlmRuntimeRequest> {
    const llmContextDump = this.llmContexts?.length ? await gatherContexts([...this.llmContexts]) : undefined;

    return {
      providerName: this.providerName,
      model: this.model,
      temperature: this.temperature,
      thinking: this.thinking,
      promptCacheKey: this.promptCacheKey,
      signal: this.signal,
      context: buildConversationContext({
        agent: this.agent,
        messages: runMessages,
        systemPrompt: this.systemPrompt,
        llmContextDump,
      }),
    };
  }

  async *run(): AsyncGenerator<ThreadRunEvent> {
    const { runMessages, runContext } = await this.prepareTurn();

    throwIfAborted(this.signal);
    const response = await this.runtime.complete(await this.buildRuntimeRequest(runMessages));
    throwIfAborted(this.signal);

    yield response;

    const functionCalls = await this.finalizeAssistantTurn(response, runContext);
    if (functionCalls.length > 0) {
      if (this.checkpoint) {
        const decision = this.resolveCheckpointDecision(await this.checkpoint({
          phase: "after_assistant",
          runContext,
          assistantMessage: response,
          toolCalls: functionCalls,
        }));

        if (decision.action === "interrupt") {
          if (decision.cancelPendingToolCalls !== false) {
            yield* this.emitCancelledToolResults(functionCalls, runContext, decision.reason);
          }

          return;
        }
      }

      yield* this.executeToolCalls(functionCalls, runContext, () => this.run());
    }
  }

  async *stream(): AsyncGenerator<ThreadStreamEvent> {
    const { runMessages, runContext } = await this.prepareTurn();

    throwIfAborted(this.signal);
    const stream = this.runtime.stream(await this.buildRuntimeRequest(runMessages));

    for await (const event of stream) {
      yield event;
    }

    const response = await stream.result();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new StreamingFailedError(response.errorMessage ?? "Streaming failed");
    }

    const functionCalls = await this.finalizeAssistantTurn(response, runContext);
    if (functionCalls.length > 0) {
      if (this.checkpoint) {
        const decision = this.resolveCheckpointDecision(await this.checkpoint({
          phase: "after_assistant",
          runContext,
          assistantMessage: response,
          toolCalls: functionCalls,
        }));

        if (decision.action === "interrupt") {
          if (decision.cancelPendingToolCalls !== false) {
            yield* this.emitCancelledToolResults(functionCalls, runContext, decision.reason);
          }

          return;
        }
      }

      yield* this.executeToolCalls(functionCalls, runContext, () => this.stream());
    }
  }

  async runToCompletion(): Promise<TOutput | ThreadRunEvent | null> {
    let finalOutput: ThreadRunEvent | null = null;

    for await (const output of this.run()) {
      finalOutput = output;
    }

    if (finalOutput && this.agent.outputSchema) {
      if (!isAssistantMessage(finalOutput)) {
        throw new InvalidJSONResponseError("No assistant message found in output item");
      }

      return this.parseStructuredOutput(finalOutput);
    }

    return finalOutput;
  }
}
