import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {stripToolArtifactInlineImages} from "../../kernel/agent/tool-artifacts.js";
import {formatToolResultFallback, Tool} from "../../kernel/agent/tool.js";
import type {JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {BrowserRunnerClient, getDefaultBrowserRunnerClient} from "../../integrations/browser/client.js";
import {browserActionSchema} from "./browser-schema.js";
import type {BrowserAction} from "./browser-types.js";

export interface BrowserToolService<TContext = DefaultAgentSessionContext> {
  handle(action: BrowserAction, run: RunContext<TContext>): Promise<ToolResultPayload>;
}

export interface BrowserToolOptions {
  service?: BrowserToolService;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  actionTimeoutMs?: number;
  dataDir?: string;
}

export class BrowserTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof BrowserTool.schema, TContext> {
  static schema = browserActionSchema;

  name = "browser";
  description =
    "Drive a stateful Chromium browser session: navigate, inspect the page, click, type, wait, evaluate, screenshot, print PDF, and close the session. Use deviceProfile for desktop, desktop-wide, mobile, mobile-compact, or tablet responsive QA.";
  schema = BrowserTool.schema;

  private readonly service: BrowserToolService<TContext>;

  constructor(options: BrowserToolOptions = {}) {
    super();
    this.service = options.service as BrowserToolService<TContext> ?? getDefaultBrowserRunnerClient({
      env: options.env,
      fetchImpl: options.fetchImpl,
      actionTimeoutMs: options.actionTimeoutMs,
      dataDir: options.dataDir,
    }) as BrowserRunnerClient as BrowserToolService<TContext>;
  }

  override formatCall(args: Record<string, unknown>): string {
    const action = typeof args.action === "string" ? args.action : null;
    if (!action) {
      return super.formatCall(args);
    }

    if (action === "navigate" && typeof args.url === "string") {
      return `navigate ${args.url}`;
    }

    if (["click", "type", "select", "screenshot"].includes(action)) {
      const target = typeof args.ref === "string" && args.ref.trim()
        ? args.ref.trim()
        : typeof args.selector === "string" && args.selector.trim()
          ? args.selector.trim()
          : null;
      return target ? `${action} ${target}` : action;
    }

    if (action === "press" && typeof args.key === "string") {
      return `press ${args.key}`;
    }

    if (action === "wait") {
      const target = typeof args.loadState === "string"
        ? `loadState=${args.loadState}`
        : typeof args.selector === "string" && args.selector.trim()
          ? `selector=${args.selector.trim()}`
          : typeof args.text === "string" && args.text.trim()
            ? `text=${args.text.trim()}`
            : typeof args.url === "string" && args.url.trim()
              ? `url=${args.url.trim()}`
              : null;
      return target ? `wait ${target}` : "wait";
    }

    return action;
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return formatToolResultFallback(message);
    }

    const action = typeof details.action === "string" ? details.action : "browser";
    const title = typeof details.title === "string" && details.title.trim()
      ? details.title.trim()
      : null;
    const url = typeof details.url === "string" && details.url.trim()
      ? details.url.trim()
      : null;

    if (action === "close") {
      return details.closed === true ? "Closed browser session" : "No browser session to close";
    }
    if (action === "screenshot") {
      return "Captured browser screenshot";
    }
    if (action === "pdf") {
      return "Saved browser PDF";
    }
    if (title) {
      return `${action} · ${title}`;
    }
    if (url) {
      return `${action} · ${url}`;
    }
    return action;
  }

  override redactResultMessage(message: ToolResultMessage<JsonValue>): ToolResultMessage<JsonValue> {
    if (message.toolName !== this.name) {
      return message;
    }

    return stripToolArtifactInlineImages(message);
  }

  async handle(
    args: z.output<typeof BrowserTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    return await this.service.handle(args as BrowserAction, run);
  }
}
