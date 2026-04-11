import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../../kernel/agent/run-context.js";
import {formatToolResultFallback, Tool} from "../../../kernel/agent/tool.js";
import type {JsonObject, JsonValue, ToolResultPayload} from "../../../kernel/agent/types.js";
import type {PandaSessionContext} from "../types.js";
import {
    DEFAULT_WEB_RESEARCH_MODEL,
    DEFAULT_WEB_RESEARCH_REASONING_EFFORT,
    DEFAULT_WEB_RESEARCH_TIMEOUT_MS,
    performWebResearch,
    renderWebResearchText,
    type WebResearchReasoningEffort,
} from "./web-research.js";

export interface WebResearchToolOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: WebResearchReasoningEffort;
}

export class WebResearchTool<TContext = PandaSessionContext>
  extends Tool<typeof WebResearchTool.schema, TContext> {
  static schema = z.object({
    query: z.string().trim().min(1),
  });

  name = "web_research";
  description =
    "Research a current topic on the public web with OpenAI hosted web search and return a concise cited answer.";
  schema = WebResearchTool.schema;

  private readonly apiKey?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly reasoningEffort: WebResearchReasoningEffort;

  constructor(options: WebResearchToolOptions = {}) {
    super();
    this.apiKey = options.apiKey;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WEB_RESEARCH_TIMEOUT_MS;
    this.model = options.model ?? DEFAULT_WEB_RESEARCH_MODEL;
    this.reasoningEffort = options.reasoningEffort ?? DEFAULT_WEB_RESEARCH_REASONING_EFFORT;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.query === "string" ? args.query : super.formatCall(args);
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return formatToolResultFallback(message);
    }

    const query = typeof details.query === "string" && details.query.trim()
      ? details.query.trim()
      : "query";
    const sources = Array.isArray(details.sources) ? details.sources.length : 0;
    return `Researched "${query}" · ${sources} source${sources === 1 ? "" : "s"}`;
  }

  async handle(
    args: z.output<typeof WebResearchTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const result = await performWebResearch(args.query, {
      apiKey: this.apiKey,
      env: this.env,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      signal: run.signal,
      onProgress: (progress) => run.emitToolProgress(progress as JsonObject),
    });

    const details = {
      query: result.query,
      provider: result.provider,
      model: result.model,
      responseId: result.responseId,
      status: result.status,
      elapsedMs: result.elapsedMs,
      citations: result.citations.map((citation) => ({
        index: citation.index,
        title: citation.title,
        url: citation.url,
      }) satisfies JsonObject),
      sources: result.sources.map((source) => ({
        title: source.title,
        url: source.url,
      }) satisfies JsonObject),
    } satisfies JsonObject;

    return {
      content: [{
        type: "text",
        text: renderWebResearchText(result),
      }],
      details,
    };
  }
}
