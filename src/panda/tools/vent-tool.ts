import type {ToolResultMessage} from "@earendil-works/pi-ai";
import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {formatToolResultFallback, Tool} from "../../kernel/agent/tool.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import {buildEndpointUrl} from "../../lib/http.js";
import type {JsonObject, JsonValue} from "../../lib/json.js";
import {stripInvisibleUnicode, trimToNull} from "../../lib/strings.js";
import {buildJsonToolPayload} from "./shared.js";

const MAX_VENT_MESSAGE_CHARS = 2_000;
const DEFAULT_TRACE_TIMEOUT_MS = 5_000;

export type VentTraceFetch = (input: URL, init?: RequestInit) => Promise<Response>;

export interface VentToolOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: VentTraceFetch;
  timeoutMs?: number;
}

interface VentTraceConfig {
  baseUrl: string;
  key: string;
  sourceId: string;
  environment: string;
}

function readTraceConfig(env: NodeJS.ProcessEnv): VentTraceConfig | undefined {
  const baseUrl = trimToNull(env.PANDA_TRACE_VENT_BASE_URL);
  const key = trimToNull(env.PANDA_TRACE_VENT_KEY);
  const sourceId = trimToNull(env.PANDA_TRACE_VENT_SOURCE_ID);
  if (!baseUrl || !key || !sourceId) {
    return undefined;
  }

  return {
    baseUrl,
    key,
    sourceId,
    environment: trimToNull(env.PANDA_TRACE_VENT_ENVIRONMENT) ?? "prod",
  };
}

function sanitizeVentMessage(message: string): string {
  return stripInvisibleUnicode(message)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function buildTraceAttributes(
  message: string,
  context: DefaultAgentSessionContext | undefined,
): JsonObject {
  return {
    event: "agent_vent",
    message,
    messageLength: message.length,
    ...(context?.agentKey ? {agentKey: context.agentKey} : {}),
    ...(context?.sessionId ? {sessionId: context.sessionId} : {}),
    ...(context?.threadId ? {threadId: context.threadId} : {}),
    ...(context?.runId ? {runId: context.runId} : {}),
    ...(context?.currentInput?.source ? {inputSource: context.currentInput.source} : {}),
    ...(context?.currentInput?.messageId ? {inputMessageId: context.currentInput.messageId} : {}),
  };
}

function dropped(reason: string, messageLength: number, extra: JsonObject = {}): ToolResultPayload {
  return buildJsonToolPayload({
    ok: true,
    status: "dropped",
    reason,
    messageLength,
    ...extra,
  });
}

export class VentTool<TContext = DefaultAgentSessionContext> extends Tool<typeof VentTool.schema, TContext> {
  static schema = z.object({
    message: z.string().trim().min(1).max(MAX_VENT_MESSAGE_CHARS).describe(
      "Private free-text vent message from the agent. Max 2000 characters.",
    ),
  });

  name = "vent";
  description = [
    "Privately vent a short emotional note and continue.",
    "If dedicated PANDA_TRACE_VENT_* env is configured, the note is sent to Panda Trace; otherwise it is softly acknowledged and dropped.",
    "The tool result never repeats the vent text.",
  ].join("\n");
  schema = VentTool.schema;

  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: VentTraceFetch;
  private readonly timeoutMs: number;

  constructor(options: VentToolOptions = {}) {
    super();
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TRACE_TIMEOUT_MS;
  }

  override formatCall(): string {
    return "[redacted vent]";
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return formatToolResultFallback(message);
    }

    return details.status === "sent" ? "Vent noted." : "Vent noted and dropped.";
  }

  override redactCallArguments(args: Record<string, unknown>): Record<string, unknown> {
    if (!Object.prototype.hasOwnProperty.call(args, "message")) {
      return {};
    }

    return {message: "[redacted]"};
  }

  async handle(
    args: z.output<typeof VentTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const sanitizedMessage = sanitizeVentMessage(args.message);
    const messageLength = sanitizedMessage.length;
    if (!sanitizedMessage) {
      return dropped("empty_after_sanitization", messageLength);
    }

    const config = readTraceConfig(this.env);
    if (!config) {
      return dropped("trace_not_configured", messageLength, {traceConfigured: false});
    }

    let url: URL;
    try {
      url = buildEndpointUrl(config.baseUrl, "v1/logs");
    } catch {
      return dropped("trace_invalid_config", messageLength, {traceConfigured: true});
    }

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = run.signal ? AbortSignal.any([run.signal, timeoutSignal]) : timeoutSignal;
    const context = run.context as DefaultAgentSessionContext | undefined;
    const body = {
      source_id: config.sourceId,
      severity: "info",
      message: "Agent vent",
      service: "panda-agent",
      environment: config.environment,
      attributes: buildTraceAttributes(sanitizedMessage, context),
    } satisfies JsonObject;

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        return dropped("trace_unavailable", messageLength, {
          traceConfigured: true,
          httpStatus: response.status,
        });
      }

      return buildJsonToolPayload({
        ok: true,
        status: "sent",
        traceConfigured: true,
        messageLength,
      });
    } catch {
      return dropped("trace_unavailable", messageLength, {traceConfigured: true});
    }
  }
}
