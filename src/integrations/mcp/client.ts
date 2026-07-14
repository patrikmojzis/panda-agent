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
import {redactExactJson, StreamingSecretRedactor} from "./redaction.js";

export class McpRunnerError extends Error {
  readonly exitCode: 3 | 124;
  readonly phase: "transport_protocol" | "timeout" | "output_limit";
  readonly diagnostics: McpOperationDiagnostics;
  readonly httpStatus?: number;

  constructor(input: {
    message: string;
    exitCode: 3 | 124;
    phase: "transport_protocol" | "timeout" | "output_limit";
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
  constructor(readonly status?: number) {
    super(status ? `MCP HTTP status ${status}.` : "MCP HTTP boundary rejected the request.");
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
        controller.error(new McpHttpBoundaryError());
        return;
      }
      controller.enqueue(chunk);
    },
  }), {signal});
}

function createBoundedFetch(config: McpResolvedHttpServerConfig, deadlineSignal: AbortSignal): typeof fetch {
  const configured = new URL(config.url);
  return async (input, init = {}) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    if ((requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") || requestUrl.origin !== configured.origin) {
      throw new McpHttpBoundaryError();
    }
    const signal = abortSignals(deadlineSignal, init.signal);
    const response = await fetch(input, {...init, redirect: "manual", signal});
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpHttpBoundaryError(response.status);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return new Response(null, {status: response.status, statusText: "MCP transport error"});
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

export class SdkMcpRunner implements McpRunner {
  async listTools(invocation: McpResolvedInvocation): Promise<McpRunnerResult<JsonObject>> {
    return this.run(invocation, async (client, requestOptions) => {
      const tools: JsonValue[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let firstEnvelope: JsonObject | undefined;
      for (let page = 0; page < MCP_MAX_TOOL_PAGES; page += 1) {
        const value = await client.listTools(cursor ? {cursor} : undefined, requestOptions);
        const envelope = boundedJsonObject(value, invocation.knownSecrets);
        firstEnvelope ??= envelope;
        if (!Array.isArray(envelope.tools)) throw new Error("MCP tools result.tools must be an array.");
        tools.push(...envelope.tools);
        if (tools.length > MCP_MAX_TOOLS) throw new McpOutputLimitError();
        const nextCursor = envelope.nextCursor;
        if (nextCursor === undefined || nextCursor === null || nextCursor === "") {
          const complete: JsonObject = {...firstEnvelope, tools};
          delete complete.nextCursor;
          return boundedJsonObject(complete, invocation.knownSecrets);
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
      const fetch = createBoundedFetch(config, deadline.signal);
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
      const outputLimit = error instanceof McpOutputLimitError;
      const phase = timeout ? "timeout" : outputLimit ? "output_limit" : "transport_protocol";
      const status = httpStatus(error);
      throw new McpRunnerError({
        message: timeout
          ? `MCP ${config.transport} command timed out.`
          : outputLimit || error instanceof McpStdioIngressLimitError
            ? `MCP ${config.transport} response exceeded a configured limit.`
            : `MCP ${config.transport} transport/protocol failure.`,
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
