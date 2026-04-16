import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {formatToolResultFallback, Tool} from "../../kernel/agent/tool.js";
import type {JsonObject, JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {
    DEFAULT_WEB_FETCH_MAX_CONTENT_CHARS,
    DEFAULT_WEB_FETCH_MAX_REDIRECTS,
    DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES,
    DEFAULT_WEB_FETCH_TIMEOUT_MS,
    DEFAULT_WEB_FETCH_USER_AGENT,
    type FetchImpl,
    fetchReadableWebPage,
    type LookupHostname,
} from "./web-fetch.js";

export interface WebFetchToolOptions {
  fetchImpl?: FetchImpl;
  lookupHostname?: LookupHostname;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  maxContentChars?: number;
  userAgent?: string;
}

function resolveHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function buildContentText(details: {
  title: string | null;
  finalUrl: string;
  content: string;
}): string {
  const lines = [];
  if (details.title) {
    lines.push(`# ${details.title}`);
  }
  lines.push(`Source: ${details.finalUrl}`);
  lines.push("");
  lines.push(details.content);
  return lines.join("\n").trim();
}

export class WebFetchTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof WebFetchTool.schema, TContext> {
  static schema = z.object({
    url: z.string().trim().url().superRefine((value, ctx) => {
      try {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "url must use http:// or https://.",
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "url must be a valid URL.",
        });
      }
    }),
  });

  name = "web_fetch";
  description =
    "Fetch a public HTML page and return readable markdown-ish content plus follow-up links. No browser, no JavaScript, no PDFs.";
  schema = WebFetchTool.schema;

  private readonly fetchImpl?: FetchImpl;
  private readonly lookupHostname?: LookupHostname;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly maxContentChars: number;
  private readonly userAgent: string;

  constructor(options: WebFetchToolOptions = {}) {
    super();
    this.fetchImpl = options.fetchImpl;
    this.lookupHostname = options.lookupHostname;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_WEB_FETCH_MAX_REDIRECTS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES;
    this.maxContentChars = options.maxContentChars ?? DEFAULT_WEB_FETCH_MAX_CONTENT_CHARS;
    this.userAgent = options.userAgent ?? DEFAULT_WEB_FETCH_USER_AGENT;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.url === "string" ? args.url : super.formatCall(args);
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return formatToolResultFallback(message);
    }

    const finalUrl = typeof details.finalUrl === "string" ? details.finalUrl : undefined;
    const title = typeof details.title === "string" && details.title.trim()
      ? details.title.trim()
      : undefined;
    const host = finalUrl ? resolveHost(finalUrl) : undefined;
    const links = Array.isArray(details.links) ? details.links.length : 0;
    const truncated = details.truncated === true;

    const parts = [];
    if (title && host) {
      parts.push(`Fetched "${title}" from ${host}`);
    } else if (title) {
      parts.push(`Fetched "${title}"`);
    } else if (host) {
      parts.push(`Fetched ${host}`);
    } else {
      parts.push("Fetched page");
    }

    if (links > 0) {
      parts.push(`${links} link${links === 1 ? "" : "s"}`);
    }
    if (truncated) {
      parts.push("truncated");
    }

    return parts.join(" · ");
  }

  async handle(
    args: z.output<typeof WebFetchTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const result = await fetchReadableWebPage(args.url, {
      fetchImpl: this.fetchImpl,
      lookupHostname: this.lookupHostname,
      timeoutMs: this.timeoutMs,
      maxRedirects: this.maxRedirects,
      maxResponseBytes: this.maxResponseBytes,
      maxContentChars: this.maxContentChars,
      userAgent: this.userAgent,
      signal: run.signal,
      onProgress: (progress) => run.emitToolProgress(progress as JsonObject),
    });

    const links = result.links.map((link) => ({
        text: link.text,
        url: link.url,
      }) satisfies JsonObject);
    const details = {
      url: result.url,
      finalUrl: result.finalUrl,
      status: result.status,
      contentType: result.contentType,
      title: result.title,
      description: result.description,
      siteName: result.siteName,
      truncated: result.truncated,
      links,
    } satisfies JsonObject;

    return {
      content: [{
        type: "text",
        text: buildContentText({
          title: result.title,
          finalUrl: result.finalUrl,
          content: result.content,
        }),
      }],
      details,
    };
  }
}
