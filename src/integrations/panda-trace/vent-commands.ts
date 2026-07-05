import {buildEndpointUrl} from "../../lib/http.js";
import type {JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {stripInvisibleUnicode, trimToNull} from "../../lib/strings.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../../domain/commands/types.js";

export const VENT_SEND_COMMAND_NAME = "vent.send";
export const MAX_VENT_MESSAGE_CHARS = 2_000;
export const DEFAULT_TRACE_TIMEOUT_MS = 5_000;

export type VentTraceFetch = (input: URL, init?: RequestInit) => Promise<Response>;

interface VentTraceConfig {
  baseUrl: string;
  key: string;
  sourceId: string;
  environment: string;
}

export interface AgentVentContext {
  agentKey?: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  inputSource?: string;
  inputMessageId?: string;
}

export interface SendAgentVentOptions {
  message: string;
  context?: AgentVentContext;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: VentTraceFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
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

function buildTraceAttributes(message: string, context: AgentVentContext | undefined): JsonObject {
  return {
    event: "agent_vent",
    message,
    messageLength: message.length,
    ...(context?.agentKey ? {agentKey: context.agentKey} : {}),
    ...(context?.sessionId ? {sessionId: context.sessionId} : {}),
    ...(context?.threadId ? {threadId: context.threadId} : {}),
    ...(context?.runId ? {runId: context.runId} : {}),
    ...(context?.inputSource ? {inputSource: context.inputSource} : {}),
    ...(context?.inputMessageId ? {inputMessageId: context.inputMessageId} : {}),
  };
}

function dropped(reason: string, messageLength: number, extra: JsonObject = {}): JsonObject {
  return {
    ok: true,
    status: "dropped",
    reason,
    messageLength,
    ...extra,
  };
}

function readVentMessage(input: unknown, commandName: string): string {
  if (!isRecord(input) || typeof input.message !== "string") {
    throw new Error(`${commandName} message must be a string.`);
  }
  if (input.message.length > MAX_VENT_MESSAGE_CHARS) {
    throw new Error(`${commandName} message must be at most ${MAX_VENT_MESSAGE_CHARS} characters.`);
  }

  return input.message;
}

export async function sendAgentVent(options: SendAgentVentOptions): Promise<JsonObject> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRACE_TIMEOUT_MS;
  const sanitizedMessage = sanitizeVentMessage(options.message);
  const messageLength = sanitizedMessage.length;
  if (!sanitizedMessage) {
    return dropped("empty_after_sanitization", messageLength);
  }

  const config = readTraceConfig(env);
  if (!config) {
    return dropped("trace_not_configured", messageLength, {traceConfigured: false});
  }

  let url: URL;
  try {
    url = buildEndpointUrl(config.baseUrl, "v1/logs");
  } catch {
    return dropped("trace_invalid_config", messageLength, {traceConfigured: true});
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const body = {
    source_id: config.sourceId,
    severity: "info",
    message: "Agent vent",
    service: "panda-agent",
    environment: config.environment,
    attributes: buildTraceAttributes(sanitizedMessage, options.context),
  } satisfies JsonObject;

  try {
    const response = await fetchImpl(url, {
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

    return {
      ok: true,
      status: "sent",
      traceConfigured: true,
      messageLength,
    };
  } catch {
    return dropped("trace_unavailable", messageLength, {traceConfigured: true});
  }
}

export const ventSendCommandDescriptor: CommandDescriptor = {
  name: VENT_SEND_COMMAND_NAME,
  summary: "Send a short private vent note to Panda Trace.",
  description: "Sends a redacted-from-output agent vent note to Panda Trace when PANDA_TRACE_VENT_* is configured. When trace venting is not configured, the command returns status dropped with reason trace_not_configured and does not store the note elsewhere.",
  usage: "panda vent (--message <text|@file|@->|--stdin)",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "message",
      description: "Vent note text. Use @file or @- for longer text.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "stdin",
      description: "Read the vent note from stdin instead of --message.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "Structured JSON object containing message.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Record a private vent note",
      command: "panda vent --message \"I need to reset and continue calmly.\"",
    },
    {
      description: "Record from stdin",
      command: "cat note.txt | panda vent --stdin",
    },
  ],
  requiredCapabilities: [VENT_SEND_COMMAND_NAME],
  resultShape: {
    ok: true,
    status: "sent|dropped",
    messageLength: "number",
    traceConfigured: "boolean",
    reason: "string",
  },
};

function summarizeVentOutput(output: JsonObject): string {
  if (output.status === "sent") {
    return "Vent sent to Panda Trace.";
  }
  const reason = typeof output.reason === "string" ? output.reason : "unknown";
  if (reason === "trace_not_configured") {
    return "Vent dropped because Panda Trace vent is not configured.";
  }

  return `Vent dropped: ${reason}.`;
}

function createVentCommand(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: VentTraceFetch;
  timeoutMs?: number;
} = {}): RegisteredCommand {
  return {
    descriptor: ventSendCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await sendAgentVent({
        message: readVentMessage(request.input, VENT_SEND_COMMAND_NAME),
        context: {
          agentKey: request.scope.agentKey,
          sessionId: request.scope.sessionId,
          threadId: request.scope.threadId,
          runId: request.scope.runId,
          inputMessageId: request.scope.inputMessageId,
        },
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });

      return {
        ok: true,
        command: VENT_SEND_COMMAND_NAME,
        output,
        summary: summarizeVentOutput(output),
      };
    },
  };
}

export function createVentSendCommand(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: VentTraceFetch;
  timeoutMs?: number;
} = {}): RegisteredCommand {
  return createVentCommand(options);
}
