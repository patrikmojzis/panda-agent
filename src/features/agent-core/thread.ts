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
import { buildToolResultMessage, buildConversationContext, collectAssistantToolCalls, assistantMessageToOutputItems } from "./pi/messages.js";
import { PiAiRuntime } from "./pi/runtime.js";
import { RunContext } from "./run-context.js";
import type { LlmRuntime, LlmRuntimeRequest } from "./runtime.js";
import type { RunPipeline } from "./run-pipeline.js";
import { Tool } from "./tool.js";
import { ToolResponse } from "./tool-response.js";
import type { InputItem, NativeToolDefinition, ResponseLike, ResponseOutputItemLike } from "./types.js";
import type { ToolCall } from "@mariozechner/pi-ai";

export interface ThreadOptions<TContext = unknown, TOutput = unknown> {
  agent: Agent<TOutput>;
  input?: InputItem[];
  maxTurns?: number;
  context?: TContext;
  llmContexts?: LlmContext[];
  hooks?: Hook<TContext>[];
  maxInputTokens?: number;
  promptCacheKey?: string;
  runPipelines?: RunPipeline<TContext>[];
  storeResponses?: boolean;
  openaiStoreResponses?: boolean;
  provider?: string;
  providerName?: string;
  runtime?: LlmRuntime;
  countTokens?: TokenCounter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!isRecord(output) || output.type !== "message") {
    throw new InvalidJSONResponseError("No textual content found in output item");
  }

  const content = Array.isArray(output.content) ? output.content : [];
  let text = "";

  for (const part of content) {
    if (!isRecord(part) || typeof part.text !== "string") {
      continue;
    }

    text += part.text;
  }

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
  agent: Agent<TOutput>;
  maxTurns: number;
  input: InputItem[];
  context?: TContext;
  llmContexts?: LlmContext[];
  hooks?: Hook<TContext>[];
  turnCount = 0;
  maxInputTokens?: number;
  promptCacheKey?: string;
  runPipelines?: RunPipeline<TContext>[];
  openaiStoreResponses: boolean;

  private readonly providerName: string;
  private readonly runtime: LlmRuntime;
  private readonly countTokens: TokenCounter;

  constructor(options: ThreadOptions<TContext, TOutput>) {
    this.agent = options.agent;
    this.maxTurns = options.maxTurns ?? 20;
    this.input = [...(options.input ?? [])];
    this.context = options.context;
    this.llmContexts = options.llmContexts;
    this.hooks = options.hooks;
    this.maxInputTokens = options.maxInputTokens;
    this.promptCacheKey = options.promptCacheKey;
    this.runPipelines = options.runPipelines;
    this.openaiStoreResponses = options.storeResponses ?? options.openaiStoreResponses ?? true;
    this.providerName =
      options.providerName ??
      (typeof options.provider === "string" ? options.provider : "openai");
    this.runtime = options.runtime ?? new PiAiRuntime();
    this.countTokens = options.countTokens ?? estimateTokensFromString;
  }

  createRunContext(runInput: InputItem[]): RunContext<TContext> {
    return new RunContext({
      agent: this.agent,
      turn: this.turnCount,
      maxTurns: this.maxTurns,
      input: runInput,
      context: this.context,
    });
  }

  async *executeToolCalls(
    functionCalls: ThreadFunctionCall[],
    runContext: RunContext<TContext>,
    nextTurn: () => AsyncGenerator<ResponseOutputItemLike>,
  ): AsyncGenerator<ResponseOutputItemLike> {
    const toolResponses = await Promise.all(
      functionCalls.map((call) => this.callTool(call.name, call.arguments, runContext)),
    );

    for (const [index, call] of functionCalls.entries()) {
      const response = toolResponses[index];
      if (!response) {
        continue;
      }

      const toolResultMessage = buildToolResultMessage({
        toolCall: call.raw,
        output: response.outputString,
        isError: response.isError,
      });

      this.input.push(toolResultMessage);
      runContext.input.push(toolResultMessage);

      const functionOutput = {
        type: "function_call_output",
        call_id: call.callId,
        output: response.outputString,
      };

      yield functionOutput;

      for (const additionalInput of response.additionalInputs ?? []) {
        this.input.push(additionalInput);
        runContext.input.push(additionalInput);
        yield additionalInput as ResponseOutputItemLike;
      }
    }

    yield* nextTurn();
  }

  async getRunInput(): Promise<InputItem[]> {
    let selectedInputs = [...this.input];

    if (this.maxInputTokens) {
      const trimmedInputs: InputItem[] = [];
      let currentTokens = 0;

      for (const message of [...this.input].reverse()) {
        const messageTokens = this.countTokens(JSON.stringify(message));
        if (currentTokens + messageTokens > this.maxInputTokens) {
          break;
        }

        trimmedInputs.unshift(message);
        currentTokens += messageTokens;
      }

      selectedInputs = trimmedInputs;
    }

    return selectedInputs;
  }

  toolDefinitions(): Array<Record<string, unknown>> {
    return this.agent.tools.map((tool) => {
      return tool instanceof Tool ? tool.toolDefinition : (tool as NativeToolDefinition);
    });
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

  private async buildRuntimeRequest(runInput: InputItem[]): Promise<LlmRuntimeRequest> {
    const llmContextDump = this.llmContexts?.length ? await gatherContexts(this.llmContexts) : undefined;

    return {
      providerName: this.providerName,
      model: this.agent.model,
      temperature: this.agent.temperature,
      reasoningEffort: this.agent.reasoningEffort,
      promptCacheKey: this.promptCacheKey,
      context: buildConversationContext({
        agent: this.agent,
        input: runInput,
        llmContextDump,
      }),
    };
  }

  private collectFunctionCalls(response: ResponseLike): ThreadFunctionCall[] {
    if (!isRecord(response) || response.role !== "assistant" || !Array.isArray(response.content)) {
      return [];
    }

    return collectAssistantToolCalls(response as never).map((call) => ({
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

    const runInput = await this.getRunInput();
    const runContext = this.createRunContext([...runInput]);

    if (this.hooks?.length) {
      await Promise.all(this.hooks.map((hook) => hook.onStart(runContext)));
    }

    const response = await this.runtime.complete(await this.buildRuntimeRequest(runInput));

    for (const output of assistantMessageToOutputItems(response)) {
      yield output;
    }

    this.input.push(response);
    runContext.input.push(response);

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

  async *stream(): AsyncGenerator<ResponseOutputItemLike> {
    this.verifyMaxTurns();

    if (this.runPipelines?.length) {
      await Promise.all(this.runPipelines.map((pipeline) => pipeline.preflight(this)));
    }

    const runInput = await this.getRunInput();
    const runContext = this.createRunContext([...runInput]);

    if (this.hooks?.length) {
      await Promise.all(this.hooks.map((hook) => hook.onStart(runContext)));
    }

    const stream = this.runtime.stream(await this.buildRuntimeRequest(runInput));

    for await (const event of stream) {
      yield event as ResponseOutputItemLike;
    }

    const response = await stream.result();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new StreamingFailedError(response.errorMessage ?? "Streaming failed");
    }

    this.input.push(response);
    runContext.input.push(response);

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
