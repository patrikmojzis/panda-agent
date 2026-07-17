import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {SSEClientTransport, SseError} from "@modelcontextprotocol/sdk/client/sse.js";
import {StreamableHTTPClientTransport, StreamableHTTPError} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {CompatibilityCallToolResultSchema, ErrorCode, McpError} from "@modelcontextprotocol/sdk/types.js";
import type {JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator} from "@modelcontextprotocol/sdk/validation";

import {isJsonObject, type JsonObject, type JsonValue} from "../../lib/json.js";
import {
  MCP_HTTP_RESPONSE_MAX_BYTES,
  MCP_MAX_TOOL_PAGES,
  MCP_MAX_TOOLS,
  MCP_OUTPUT_MAX_BYTES,
  MCP_STDERR_MAX_BYTES,
  MCP_STDIO_LINE_MAX_BYTES,
  type McpOperationDiagnostics,
  type McpResolvedHttpServerConfig,
  type McpResolvedInvocation,
  type McpRunner,
  type McpRunnerResult,
} from "../../domain/mcp/types.js";
import {BoundedStdioClientTransport, McpStdioIngressLimitError} from "./stdio-transport.js";
import {McpRedactionCollisionError, redactExactJson, StreamingSecretRedactor} from "./redaction.js";

export type McpRunnerPhase =
  | "connect"
  | "http_status"
  | "invalid_content"
  | "protocol"
  | "session_expired"
  | "authentication"
  | "timeout"
  | "output_limit";

export class McpRunnerError extends Error {
  readonly exitCode: 3 | 124;
  readonly phase: McpRunnerPhase;
  readonly diagnostics: McpOperationDiagnostics;
  readonly httpStatus?: number;

  constructor(input: {
    message: string;
    exitCode: 3 | 124;
    phase: McpRunnerPhase;
    diagnostics: McpOperationDiagnostics;
    httpStatus?: number;
  }) {
    super(input.message);
    this.name = "McpRunnerError";
    this.exitCode = input.exitCode;
    this.phase = input.phase;
    this.diagnostics = input.diagnostics;
    this.httpStatus = input.httpStatus;
  }
}

class McpHttpBoundaryError extends Error {
  constructor(
    readonly phase: Extract<McpRunnerPhase, "connect" | "http_status" | "invalid_content" | "session_expired" | "authentication" | "output_limit">,
    readonly status?: number,
  ) {
    super("MCP HTTP boundary rejected the request.");
    this.name = "McpHttpBoundaryError";
  }
}

class McpOutputLimitError extends Error {
  constructor() {
    super("MCP normalized output exceeded the configured byte limit.");
    this.name = "McpOutputLimitError";
  }
}

class PassthroughJsonSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
    return (input: unknown) => ({valid: true, data: input as T, errorMessage: undefined});
  }
}

function createClient(): Client {
  return new Client({name: "panda-agent", version: "0.1.0"}, {
    capabilities: {},
    jsonSchemaValidator: new PassthroughJsonSchemaValidator(),
  });
}

function boundedJsonObject(value: unknown, secrets: readonly string[]): JsonObject {
  const redacted = redactExactJson(value, secrets);
  if (!isJsonObject(redacted)) throw new Error("MCP result must be a JSON object.");
  if (Buffer.byteLength(JSON.stringify(redacted), "utf8") > MCP_OUTPUT_MAX_BYTES) {
    throw new McpOutputLimitError();
  }
  return redacted;
}

function abortSignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 1) return present[0]!;
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {once: true});
  }
  return controller.signal;
}

function cappedResponseBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  let bytes = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MCP_HTTP_RESPONSE_MAX_BYTES) {
        controller.error(new McpHttpBoundaryError("output_limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  }), {signal});
}

function requestContentTypeIsValid(method: string, response: Response): boolean {
  if (response.status === 202 || response.status === 204 || method === "DELETE") return true;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (method === "GET") return contentType === "text/event-stream";
  return contentType === "application/json" || contentType === "text/event-stream";
}

function phaseForHttpStatus(status: number, sessionRequest: boolean): Extract<McpRunnerPhase, "http_status" | "session_expired" | "authentication"> {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404 && sessionRequest) return "session_expired";
  return "http_status";
}

function createBoundedFetch(
  config: McpResolvedHttpServerConfig,
  deadlineSignal: AbortSignal,
  onResponse: () => void,
): typeof fetch {
  const configured = new URL(config.url);
  return async (input, init = {}) => {
    const request = new Request(input, init);
    const requestUrl = new URL(request.url);
    if ((requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") || requestUrl.origin !== configured.origin) {
      throw new McpHttpBoundaryError("connect");
    }
    const signal = abortSignals(deadlineSignal, request.signal);
    let response: Response;
    try {
      response = await fetch(request, {redirect: "manual", signal});
      onResponse();
    } catch (error) {
      if (deadlineSignal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      throw new McpHttpBoundaryError("connect");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpHttpBoundaryError("http_status", response.status);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpHttpBoundaryError(
        phaseForHttpStatus(response.status, request.headers.has("mcp-session-id")),
        response.status,
      );
    }
    if (!requestContentTypeIsValid(request.method, response)) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpHttpBoundaryError("invalid_content");
    }
    return new Response(cappedResponseBody(response.body, signal), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function httpStatus(error: unknown): number | undefined {
  if (error instanceof McpHttpBoundaryError) return error.status;
  if (error instanceof StreamableHTTPError || error instanceof SseError) return error.code;
  return undefined;
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return true;
  return error instanceof DOMException && error.name === "AbortError";
}

function stdioDiagnostics(
  pid: number | null,
  text: string,
  truncated: boolean,
): McpOperationDiagnostics {
  return {
    transport: "stdio",
    ...(pid ? {pid} : {}),
    stderr: text,
    stderrTruncated: truncated,
  };
}

function httpDiagnostics(transport: "streamable-http" | "sse"): McpOperationDiagnostics {
  return {transport};
}

function remaining(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

async function terminateSession(
  transport: StreamableHTTPClientTransport,
  deadlineAt: number,
): Promise<void> {
  if (!transport.sessionId || remaining(deadlineAt) <= 0) return;
  const timeout = Math.min(2_000, remaining(deadlineAt));
  await Promise.race([
    transport.terminateSession().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeout).unref()),
  ]);
}

function retainedToolsEnvelopeBytes(envelope: JsonObject, tools: readonly JsonValue[]): number {
  return Buffer.byteLength(JSON.stringify({...envelope, tools}), "utf8");
}

function appendBoundedTools(
  retained: JsonValue[],
  pageTools: readonly JsonValue[],
  retainedBytes: number,
): number {
  let bytes = retainedBytes;
  for (const tool of pageTools) {
    if (retained.length + 1 > MCP_MAX_TOOLS) throw new McpOutputLimitError();
    const addition = Buffer.byteLength(JSON.stringify(tool), "utf8") + (retained.length === 0 ? 0 : 1);
    if (bytes + addition > MCP_OUTPUT_MAX_BYTES) throw new McpOutputLimitError();
    retained.push(tool);
    bytes += addition;
  }
  return bytes;
}

function runnerErrorMessage(transport: McpResolvedInvocation["config"]["transport"], phase: McpRunnerPhase): string {
  const messages: Record<McpRunnerPhase, string> = {
    connect: `MCP ${transport} connection failed.`,
    http_status: "MCP HTTP request returned an error status.",
    invalid_content: "MCP response content was invalid.",
    protocol: `MCP ${transport} protocol operation failed.`,
    session_expired: "MCP HTTP session expired.",
    authentication: "MCP HTTP authentication failed.",
    timeout: `MCP ${transport} command timed out.`,
    output_limit: `MCP ${transport} response exceeded a configured limit.`,
  };
  return messages[phase];
}

export class SdkMcpRunner implements McpRunner {
  async listTools(invocation: McpResolvedInvocation): Promise<McpRunnerResult<JsonObject>> {
    return this.run(invocation, async (client, requestOptions) => {
      const tools: JsonValue[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let firstEnvelope: JsonObject | undefined;
      let retainedBytes = 0;
      for (let page = 0; page < MCP_MAX_TOOL_PAGES; page += 1) {
        const value = await client.listTools(cursor ? {cursor} : undefined, requestOptions);
        const envelope = boundedJsonObject(value, invocation.knownSecrets);
        if (!Array.isArray(envelope.tools)) throw new Error("MCP tools result.tools must be an array.");
        if (!firstEnvelope) {
          firstEnvelope = {...envelope};
          delete firstEnvelope.tools;
          delete firstEnvelope.nextCursor;
          retainedBytes = retainedToolsEnvelopeBytes(firstEnvelope, []);
          if (retainedBytes > MCP_OUTPUT_MAX_BYTES) throw new McpOutputLimitError();
        }
        retainedBytes = appendBoundedTools(tools, envelope.tools, retainedBytes);
        const nextCursor = envelope.nextCursor;
        if (nextCursor === undefined || nextCursor === null || nextCursor === "") {
          return boundedJsonObject({...firstEnvelope, tools}, invocation.knownSecrets);
        }
        if (typeof nextCursor !== "string") throw new Error("MCP tools nextCursor must be a string.");
        if (cursors.has(nextCursor)) throw new Error("MCP tools pagination cursor cycle detected.");
        cursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw new McpOutputLimitError();
    });
  }

  async callTool(
    invocation: McpResolvedInvocation,
    input: {name: string; arguments: JsonObject},
  ): Promise<McpRunnerResult<JsonObject>> {
    return this.run(invocation, async (client, requestOptions) => boundedJsonObject(
      await client.callTool(input, CompatibilityCallToolResultSchema, requestOptions),
      invocation.knownSecrets,
    ));
  }

  private async run(
    invocation: McpResolvedInvocation,
    operation: (
      client: Client,
      requestOptions: {signal: AbortSignal; timeout: number; maxTotalTimeout: number},
    ) => Promise<JsonObject>,
  ): Promise<McpRunnerResult<JsonObject>> {
    const {config, knownSecrets} = invocation;
    const deadlineAt = Date.now() + config.timeoutMs;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("MCP deadline exceeded", "AbortError")), config.timeoutMs);
    timer.unref();
    const requestOptions = {signal: deadline.signal, timeout: config.timeoutMs, maxTotalTimeout: config.timeoutMs};
    const client = createClient();
    let transport: BoundedStdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
    let stage: "connect" | "operation" = "connect";
    let httpResponseReceived = false;
    let stderr = "";
    let stderrTruncated = false;
    let stderrFinished = false;
    let redactor: StreamingSecretRedactor | undefined;

    if (config.transport === "stdio") {
      transport = new BoundedStdioClientTransport({
        command: config.command,
        args: config.args,
        ...(config.cwd ? {cwd: config.cwd} : {}),
        ...(config.env ? {env: config.env} : {}),
        maxLineBytes: MCP_STDIO_LINE_MAX_BYTES,
        deadlineAt,
        signal: deadline.signal,
      });
      redactor = new StreamingSecretRedactor(knownSecrets, (text) => {
        const remainingBytes = MCP_STDERR_MAX_BYTES - Buffer.byteLength(stderr, "utf8");
        if (remainingBytes <= 0) {
          stderrTruncated = true;
          return;
        }
        const chunk = Buffer.from(text, "utf8");
        if (chunk.byteLength > remainingBytes) {
          stderr += chunk.subarray(0, remainingBytes).toString("utf8");
          stderrTruncated = true;
        } else {
          stderr += text;
        }
      });
      transport.stderr.on("data", (chunk) => redactor?.append(Buffer.isBuffer(chunk) ? chunk : String(chunk)));
    } else {
      const fetch = createBoundedFetch(config, deadline.signal, () => {
        httpResponseReceived = true;
      });
      const requestInit = {headers: config.headers};
      transport = config.transport === "streamable-http"
        ? new StreamableHTTPClientTransport(new URL(config.url), {fetch, requestInit})
        : new SSEClientTransport(new URL(config.url), {fetch, eventSourceInit: {fetch}, requestInit});
    }

    const diagnostics = (): McpOperationDiagnostics => config.transport === "stdio"
      ? stdioDiagnostics(transport instanceof BoundedStdioClientTransport ? transport.pid : null, stderr, stderrTruncated)
      : httpDiagnostics(config.transport);

    try {
      await client.connect(transport, requestOptions);
      stage = "operation";
      const value = await operation(client, requestOptions);
      if (redactor && remaining(deadlineAt) > 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (redactor && !stderrFinished) {
        redactor.finish();
        stderrFinished = true;
      }
      return {
        value,
        diagnostics: diagnostics(),
        ...(isJsonObject(redactExactJson(client.getServerVersion(), knownSecrets))
          ? {serverInfo: redactExactJson(client.getServerVersion(), knownSecrets) as JsonObject}
          : {}),
        ...(isJsonObject(redactExactJson(client.getServerCapabilities(), knownSecrets))
          ? {serverCapabilities: redactExactJson(client.getServerCapabilities(), knownSecrets) as JsonObject}
          : {}),
      };
    } catch (error) {
      if (redactor && !stderrFinished) {
        redactor.finish();
        stderrFinished = true;
      }
      const timeout = isTimeout(error, deadline.signal);
      const initializationProtocolDataReceived = httpResponseReceived
        || (transport instanceof BoundedStdioClientTransport && transport.protocolMessageReceived);
      const phase: McpRunnerPhase = timeout
        ? "timeout"
        : error instanceof McpOutputLimitError
            || error instanceof McpStdioIngressLimitError
            || (transport instanceof BoundedStdioClientTransport && transport.ingressLimitExceeded)
          ? "output_limit"
          : error instanceof McpHttpBoundaryError
            ? error.phase
            : error instanceof McpRedactionCollisionError || error instanceof SyntaxError
              ? "invalid_content"
              : stage === "connect"
                ? initializationProtocolDataReceived ? "invalid_content" : "connect"
                : "protocol";
      const status = httpStatus(error);
      throw new McpRunnerError({
        message: runnerErrorMessage(config.transport, phase),
        exitCode: timeout ? 124 : 3,
        phase,
        diagnostics: diagnostics(),
        ...(status === undefined ? {} : {httpStatus: status}),
      });
    } finally {
      if (transport instanceof StreamableHTTPClientTransport) {
        await terminateSession(transport, deadlineAt);
      }
      await client.close().catch(() => transport.close().catch(() => undefined));
      clearTimeout(timer);
    }
  }
}
