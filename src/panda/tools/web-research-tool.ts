import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {formatToolResultFallback, Tool} from "../../kernel/agent/tool.js";
import type {JsonObject, JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {readThreadId} from "../../integrations/shell/runtime-context.js";
import {
  DEFAULT_WEB_RESEARCH_MODEL,
  DEFAULT_WEB_RESEARCH_REASONING_EFFORT,
  DEFAULT_WEB_RESEARCH_TIMEOUT_MS,
  performWebResearch,
  renderWebResearchText,
  type WebResearchReasoningEffort,
} from "./web-research.js";
import {buildBackgroundJobPayload, formatBackgroundJobResult} from "./background-job-tools.js";

export interface WebResearchToolOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: WebResearchReasoningEffort;
  jobService?: BackgroundToolJobService;
}

async function runWebResearch(params: {
  query: string;
  apiKey?: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  model: string;
  reasoningEffort: WebResearchReasoningEffort;
  signal?: AbortSignal;
  emitProgress(progress: JsonObject): void;
}): Promise<ToolResultPayload> {
  const result = await performWebResearch(params.query, {
    apiKey: params.apiKey,
    env: params.env,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
    signal: params.signal,
    onProgress: (progress) => params.emitProgress(progress as JsonObject),
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

function serializeWebResearchResult(payload: ToolResultPayload): JsonObject {
  return {
    contentText: payload.content
      .flatMap((part) => part.type === "text" && part.text.trim() ? [part.text.trim()] : [])
      .join("\n\n"),
    ...(payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)
      ? {details: payload.details as JsonObject}
      : {}),
  };
}

export class WebResearchTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof WebResearchTool.schema, TContext> {
  static schema = z.object({
    query: z.string().trim().min(1),
  });

  name = "web_research";
  description =
    "Start a background public web research job with OpenAI hosted web search and return its job id. Use background_job_wait only when the current response needs the cited answer now.";
  schema = WebResearchTool.schema;

  private readonly apiKey?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly reasoningEffort: WebResearchReasoningEffort;
  private readonly jobService?: BackgroundToolJobService;

  constructor(options: WebResearchToolOptions = {}) {
    super();
    this.apiKey = options.apiKey;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WEB_RESEARCH_TIMEOUT_MS;
    this.model = options.model ?? DEFAULT_WEB_RESEARCH_MODEL;
    this.reasoningEffort = options.reasoningEffort ?? DEFAULT_WEB_RESEARCH_REASONING_EFFORT;
    this.jobService = options.jobService;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.query === "string" ? args.query : super.formatCall(args);
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return formatToolResultFallback(message);
    }

    if (details.kind === "web_research" && typeof details.status === "string") {
      return formatBackgroundJobResult(message);
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
  ): Promise<JsonValue> {
    if (!this.jobService) {
      throw new ToolError("web_research requires background jobs in this runtime.");
    }

    const context = run.context as DefaultAgentSessionContext | undefined;
    const job = await this.jobService.start({
      threadId: readThreadId(context),
      runId: context?.runId,
      kind: "web_research",
      summary: args.query,
      start: ({signal, emitProgress}) => ({
        progress: {
          status: "queued",
          query: args.query,
          model: this.model,
        },
        done: runWebResearch({
          query: args.query,
          apiKey: this.apiKey,
          env: this.env,
          fetchImpl: this.fetchImpl,
          timeoutMs: this.timeoutMs,
          model: this.model,
          reasoningEffort: this.reasoningEffort,
          signal,
          emitProgress,
        }).then((payload) => ({
          status: "completed" as const,
          result: serializeWebResearchResult(payload),
        })),
      }),
    });

    return buildBackgroundJobPayload(job);
  }
}
