import type { AssistantMessage, ToolCall } from "@mariozechner/pi-ai";

import type { Agent } from "./agent.js";
import {
  InvalidJSONResponseError,
  InvalidSchemaResponseError,
  MaxTurnsReachedError,
  StreamingFailedError,
} from "./exceptions.js";
import { estimateTokensFromString, type TokenCounter } from "./helpers/token-count.js";
import { gatherContexts, type LlmContext } from "./llm-context.js";
import type { Hook } from "./hook.js";
import {
  assistantMessageToOutputItems,
  buildConversationContext,
  buildToolResultMessage,
  collectAssistantToolCalls,
} from "./pi/messages.js";
import { PiAiRuntime } from "./pi/runtime.js";
import { assertProviderName, type ProviderName } from "./provider.js";
import { RunContext } from "./run-context.js";
import type { LlmRuntime, LlmRuntimeRequest } from "./runtime.js";
import type { RunPipeline } from "./run-pipeline.js";
import { Tool } from "./tool.js";
import { ToolResponse } from "./tool-response.js";
import type { InputItem, ResponseOutputItemLike, ThreadStreamEvent } from "./types.js";

export interface ThreadOptions<TContext = unknown, TOutput = unknown> {
  agent: Agent<TOutput>;
  messages?: ReadonlyArray<InputItem>;
  maxTurns?: number;
  context?: TContext;
  llmContexts?: ReadonlyArray<LlmContext>;
  hooks?: ReadonlyArray<Hook<TContext>>;
  maxInputTokens?: number;
  promptCacheKey?: string;
  runPipelines?: ReadonlyArray<RunPipeline<TContext>>;
  provider?: ProviderName;
  runtime?: LlmRuntime;
  countTokens?: TokenCounter;
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

function extractMessageText(output: ResponseOutputItemLike): string {
  if (output.type !== "message") {
    throw new InvalidJSONResponseError("No textual content found in output item");
  }

  const text = output.content.map((part) => part.text).join("");
  if (!text) {
    throw new InvalidJSONResponseError("No textual content found in output item");
  }

  return text;
}

type ThreadFunctionCall = {
  name: string;
  arguments: string;
  callId: string;
  raw: ToolCall;
};

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

  private readonly providerName: ProviderName;
  private readonly runtime: LlmRuntime;
  private readonly countTokens: TokenCounter;
  private readonly history: InputItem[];

  constructor(options: ThreadOptions<TContext, TOutput>) {
    this.agent = options.agent;
    this.maxTurns = options.maxTurns ?? 100;
    this.history = [...(options.messages ?? [])];
    this.context = options.context;
    this.llmContexts = options.llmContexts;
    this.hooks = options.hooks;
    this.maxInputTokens = options.maxInputTokens;
    this.promptCacheKey = options.promptCacheKey;
    this.runPipelines = options.runPipelines;
    this.providerName = options.provider === undefined ? "openai" : assertProviderName(options.provider);
    this.runtime = options.runtime ?? new PiAiRuntime();
    this.countTokens = options.countTokens ?? estimateTokensFromString;
  }

  get messages(): readonly InputItem[] {
    return this.history;
  }

  addMessage(message: InputItem): void {
    this.history.push(message);
  }

  addMessages(messages: Iterable<InputItem>): void {
    for (const message of messages) {
      this.addMessage(message);
    }
  }

  createRunContext(runMessages: InputItem[]): RunContext<TContext> {
    return new RunContext({
      agent: this.agent,
      turn: this.turnCount,
      maxTurns: this.maxTurns,
      messages: runMessages,
      context: this.context,
    });
  }

  async *executeToolCalls<TNextEvent>(
    functionCalls: ThreadFunctionCall[],
    runContext: RunContext<TContext>,
    nextTurn: () => AsyncGenerator<TNextEvent>,
  ): AsyncGenerator<ResponseOutputItemLike | TNextEvent> {
    for (const call of functionCalls) {
      const progressQueue: ResponseOutputItemLike[] = [];
      let wakeProgressWaiter: (() => void) | undefined;

      const toolRunContext = new RunContext({
        agent: runContext.agent,
        turn: runContext.turn,
        maxTurns: runContext.maxTurns,
        messages: runContext.messages,
        context: runContext.context,
        onToolProgress: (progress) => {
          progressQueue.push({
            type: "tool_progress",
            call_id: call.callId,
            name: call.name,
            output: progress,
          });

          wakeProgressWaiter?.();
          wakeProgressWaiter = undefined;
        },
      });

      let response: ToolResponse | undefined;
      let toolCompleted = false;

      const toolPromise = this.callTool(call.name, call.arguments, toolRunContext)
        .then((toolResponse) => {
          response = toolResponse;
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

      if (!response) {
        continue;
      }

      const toolResultMessage = buildToolResultMessage({
        toolCall: call.raw,
        output: response.outputString,
        isError: response.isError,
      });

      this.addMessage(toolResultMessage);
      runContext.messages.push(toolResultMessage);

      const toolResultOutput: ResponseOutputItemLike = {
        type: "function_call_output",
        call_id: call.callId,
        output: response.outputString,
      };

      yield toolResultOutput;

      for (const additionalMessage of response.additionalMessages ?? []) {
        this.addMessage(additionalMessage);
        runContext.messages.push(additionalMessage);
      }
    }

    yield* nextTurn();
  }

  async getRunInput(): Promise<InputItem[]> {
    let selectedMessages = [...this.history];

    if (this.maxInputTokens) {
      const trimmedMessages: InputItem[] = [];
      let currentTokens = 0;

      for (const message of [...this.history].reverse()) {
        const messageTokens = this.countTokens(JSON.stringify(message));
        if (currentTokens + messageTokens > this.maxInputTokens) {
          break;
        }

        trimmedMessages.unshift(message);
        currentTokens += messageTokens;
      }

      selectedMessages = trimmedMessages;
    }

    return selectedMessages;
  }

  async parseStructuredOutput(output: ResponseOutputItemLike): Promise<TOutput> {
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

  async callTool(name: string, args: string, runContext: RunContext<TContext>): Promise<ToolResponse> {
    const tool = this.agent.tools.find((candidate): candidate is Tool => {
      return candidate instanceof Tool && candidate.name === name;
    });

    if (!tool) {
      return ToolResponse.error(`No tool found with name ${name}`);
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      return ToolResponse.error(`Invalid JSON: ${args}`);
    }

    return tool.run(parsedArgs, runContext);
  }

  verifyMaxTurns(): void {
    if (this.turnCount >= this.maxTurns) {
      throw new MaxTurnsReachedError();
    }

    this.turnCount += 1;
  }

  private async buildRuntimeRequest(runMessages: InputItem[]): Promise<LlmRuntimeRequest> {
    const llmContextDump = this.llmContexts?.length ? await gatherContexts([...this.llmContexts]) : undefined;

    return {
      providerName: this.providerName,
      model: this.agent.model,
      temperature: this.agent.temperature,
      reasoningEffort: this.agent.reasoningEffort,
      promptCacheKey: this.promptCacheKey,
      context: buildConversationContext({
        agent: this.agent,
        messages: runMessages,
        llmContextDump,
      }),
    };
  }

  private collectFunctionCalls(response: AssistantMessage): ThreadFunctionCall[] {
    return collectAssistantToolCalls(response).map((call) => ({
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
      callId: call.id,
      raw: call,
    }));
  }

  async *run(): AsyncGenerator<ResponseOutputItemLike> {
    this.verifyMaxTurns();

    if (this.runPipelines?.length) {
      await Promise.all(this.runPipelines.map((pipeline) => pipeline.preflight(this)));
    }

    const runMessages = await this.getRunInput();
    const runContext = this.createRunContext([...runMessages]);

    if (this.hooks?.length) {
      await Promise.all(this.hooks.map((hook) => hook.onStart(runContext)));
    }

    const response = await this.runtime.complete(await this.buildRuntimeRequest(runMessages));

    for (const output of assistantMessageToOutputItems(response)) {
      yield output;
    }

    this.addMessage(response);
    runContext.messages.push(response);

    if (this.hooks?.length) {
      await Promise.all(this.hooks.map((hook) => hook.onEnd(runContext, response)));
    }

    if (this.runPipelines?.length) {
      await Promise.all(this.runPipelines.map((pipeline) => pipeline.postflight(this, response)));
    }

    const functionCalls = this.collectFunctionCalls(response);
    if (functionCalls.length > 0) {
      yield* this.executeToolCalls(functionCalls, runContext, () => this.run());
    }
  }

  async *stream(): AsyncGenerator<ThreadStreamEvent> {
    this.verifyMaxTurns();

    if (this.runPipelines?.length) {
      await Promise.all(this.runPipelines.map((pipeline) => pipeline.preflight(this)));
    }

    const runMessages = await this.getRunInput();
    const runContext = this.createRunContext([...runMessages]);

    if (this.hooks?.length) {
      await Promise.all(this.hooks.map((hook) => hook.onStart(runContext)));
    }

    const stream = this.runtime.stream(await this.buildRuntimeRequest(runMessages));

    for await (const event of stream) {
      yield event;
    }

    const response = await stream.result();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new StreamingFailedError(response.errorMessage ?? "Streaming failed");
    }

    this.addMessage(response);
    runContext.messages.push(response);

    if (this.hooks?.length) {
      await Promise.all(this.hooks.map((hook) => hook.onEnd(runContext, response)));
    }

    if (this.runPipelines?.length) {
      await Promise.all(this.runPipelines.map((pipeline) => pipeline.postflight(this, response)));
    }

    const functionCalls = this.collectFunctionCalls(response);
    if (functionCalls.length > 0) {
      yield* this.executeToolCalls(functionCalls, runContext, () => this.stream());
    }
  }

  async runToCompletion(): Promise<TOutput | ResponseOutputItemLike | null> {
    let finalOutput: ResponseOutputItemLike | null = null;

    for await (const output of this.run()) {
      finalOutput = output;
    }

    if (finalOutput && this.agent.outputSchema) {
      return this.parseStructuredOutput(finalOutput);
    }

    return finalOutput;
  }
}
