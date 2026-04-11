import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../../kernel/agent/run-context.js";
import {formatToolResultFallback, Tool} from "../../../kernel/agent/tool.js";
import type {JsonValue, ToolResultPayload} from "../../../kernel/agent/types.js";
import type {PandaSessionContext} from "../types.js";
import {BrowserSessionService, getDefaultBrowserSessionService} from "./browser-service.js";
import type {BrowserAction, BrowserLoadState} from "./browser-types.js";

function httpUrlSchema(fieldName = "url"): z.ZodString {
  return z.string().trim().url().superRefine((value, ctx) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldName} must use http:// or https://.`,
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${fieldName} must be a valid URL.`,
      });
    }
  });
}

function optionalTimeoutSchema(): z.ZodOptional<z.ZodNumber> {
  return z.number().int().min(1).max(300_000).optional();
}

function requireRefOrSelector(
  value: {ref?: string; selector?: string},
  ctx: z.RefinementCtx,
): void {
  if (value.ref?.trim() || value.selector?.trim()) {
    return;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "ref or selector is required.",
  });
}

const browserLoadStateSchema = z.enum(["load", "domcontentloaded", "networkidle"]) satisfies z.ZodType<BrowserLoadState>;

export interface BrowserToolService<TContext = PandaSessionContext> {
  handle(action: BrowserAction, run: RunContext<TContext>): Promise<ToolResultPayload>;
}

type BrowserExecFileImpl = (
  file: string,
  args: readonly string[],
  options?: {
    encoding?: BufferEncoding;
    signal?: AbortSignal;
  },
) => Promise<{stdout: string; stderr: string}>;

export interface BrowserToolOptions {
  service?: BrowserToolService;
  env?: NodeJS.ProcessEnv;
  execFileImpl?: BrowserExecFileImpl;
  image?: string;
  actionTimeoutMs?: number;
  sessionIdleTtlMs?: number;
  sessionMaxAgeMs?: number;
  maxSnapshotChars?: number;
  maxEvaluateResultChars?: number;
  dataDir?: string;
}

export class BrowserTool<TContext = PandaSessionContext>
  extends Tool<typeof BrowserTool.schema, TContext> {
  static schema = z.object({
    action: z.enum([
      "navigate",
      "snapshot",
      "click",
      "type",
      "press",
      "select",
      "wait",
      "evaluate",
      "screenshot",
      "pdf",
      "close",
    ]),
    url: httpUrlSchema().optional(),
    ref: z.string().trim().min(1).optional(),
    selector: z.string().trim().min(1).optional(),
    text: z.string().optional(),
    submit: z.boolean().optional(),
    key: z.string().trim().min(1).optional(),
    value: z.string().trim().min(1).optional(),
    values: z.array(z.string().trim().min(1)).min(1).optional(),
    loadState: browserLoadStateSchema.optional(),
    script: z.string().trim().min(1).optional(),
    arg: z.unknown().optional(),
    fullPage: z.boolean().optional(),
    timeoutMs: optionalTimeoutSchema(),
  }).superRefine((value, ctx) => {
    switch (value.action) {
      case "navigate":
        if (!value.url) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "url is required for navigate.",
          });
        }
        return;
      case "snapshot":
      case "pdf":
      case "close":
        return;
      case "click":
        requireRefOrSelector(value, ctx);
        return;
      case "type":
        requireRefOrSelector(value, ctx);
        if (typeof value.text !== "string") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "text is required for type.",
          });
        }
        return;
      case "press":
        if (!value.key) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "key is required for press.",
          });
        }
        return;
      case "select":
        requireRefOrSelector(value, ctx);
        if (value.value || value.values?.length) {
          return;
        }
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "value or values is required.",
        });
        return;
      case "wait": {
        const count = [
          Boolean(value.loadState),
          Boolean(value.selector?.trim()),
          Boolean(value.text?.trim()),
          Boolean(value.url?.trim()),
        ].filter(Boolean).length;
        if (count !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "wait requires exactly one of loadState, selector, text, or url.",
          });
        }
        return;
      }
      case "evaluate":
        if (!value.script) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "script is required for evaluate.",
          });
        }
        return;
      case "screenshot":
        return;
    }
  });

  name = "browser";
  description =
    "Drive a stateful Chromium browser session: navigate, inspect the page, click, type, wait, evaluate, screenshot, print PDF, and close the session.";
  schema = BrowserTool.schema;

  private readonly service: BrowserToolService<TContext>;

  constructor(options: BrowserToolOptions = {}) {
    super();
    this.service = options.service as BrowserToolService<TContext> ?? getDefaultBrowserSessionService({
      env: options.env,
      execFileImpl: options.execFileImpl,
      image: options.image,
      actionTimeoutMs: options.actionTimeoutMs,
      sessionIdleTtlMs: options.sessionIdleTtlMs,
      sessionMaxAgeMs: options.sessionMaxAgeMs,
      maxSnapshotChars: options.maxSnapshotChars,
      maxEvaluateResultChars: options.maxEvaluateResultChars,
      dataDir: options.dataDir,
    }) as BrowserSessionService as BrowserToolService<TContext>;
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

  async handle(
    args: z.output<typeof BrowserTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    return await this.service.handle(args as BrowserAction, run);
  }
}
