import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {getDefaultEnvironment, StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {ErrorCode, McpError} from "@modelcontextprotocol/sdk/types.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation";

import {isJsonObject, normalizeToJsonValue, type JsonObject} from "../../lib/json.js";
import {
  MCP_STDERR_MAX_CHARS,
  type McpOperationDiagnostics,
  type McpServerConfig,
} from "./types.js";

export interface McpClientRunResult<T> {
  value: T;
  diagnostics: McpOperationDiagnostics;
  serverInfo?: JsonObject;
  serverCapabilities?: JsonObject;
}

export class McpClientRunError extends Error {
  readonly exitCode: 3 | 124;
  readonly diagnostics: McpOperationDiagnostics;
  readonly phase: string;

  constructor(input: {
    message: string;
    exitCode: 3 | 124;
    phase: string;
    diagnostics: McpOperationDiagnostics;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : {cause: input.cause});
    this.name = "McpClientRunError";
    this.exitCode = input.exitCode;
    this.phase = input.phase;
    this.diagnostics = input.diagnostics;
  }
}

class PassthroughJsonSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
    return (input: unknown) => ({
      valid: true,
      data: input as T,
      errorMessage: undefined,
    });
  }
}

function normalizeOptionalJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeToJsonValue(value);
  return isJsonObject(normalized) ? normalized : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && /\b(timeout|timed out)\b/i.test(error.message);
}

function createStderrCapture(env: Record<string, string> | undefined): {
  append(chunk: unknown): void;
  diagnostics(pid?: number): McpOperationDiagnostics;
} {
  let stderr = "";
  let stderrTruncated = false;
  const redactionValues = Array.from(new Set(Object.values(env ?? {})
    .filter((value) => value.length >= 3)))
    .sort((left, right) => right.length - left.length);

  function redact(value: string): string {
    let redacted = value;
    for (const secret of redactionValues) {
      redacted = redacted.split(secret).join("[redacted]");
    }
    return redacted;
  }

  return {
    append(chunk) {
      if (stderr.length >= MCP_STDERR_MAX_CHARS) {
        stderrTruncated = true;
        return;
      }
      const next = redact(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      const remaining = MCP_STDERR_MAX_CHARS - stderr.length;
      stderr += next.slice(0, remaining);
      if (next.length > remaining) {
        stderrTruncated = true;
      }
    },
    diagnostics(pid) {
      return {
        transport: "stdio",
        ...(pid ? {pid} : {}),
        stderr,
        stderrTruncated,
      };
    },
  };
}

function buildProcessEnv(config: McpServerConfig): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...(config.env ?? {}),
  };
}

export async function runWithMcpClient<T>(
  config: McpServerConfig,
  operation: (client: Client, requestOptions: {timeout: number; maxTotalTimeout: number}) => Promise<T>,
): Promise<McpClientRunResult<T>> {
  const env = buildProcessEnv(config);
  const stderrCapture = createStderrCapture(config.env);
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
    stderr: "pipe",
    ...(config.cwd ? {cwd: config.cwd} : {}),
  });
  transport.stderr?.on("data", (chunk) => stderrCapture.append(chunk));
  transport.onerror = (error) => stderrCapture.append(`${error.message}\n`);

  const client = new Client({name: "panda-agent", version: "0.1.0"}, {
    capabilities: {},
    jsonSchemaValidator: new PassthroughJsonSchemaValidator(),
  });
  const requestOptions = {
    timeout: config.timeoutMs,
    maxTotalTimeout: config.timeoutMs,
  };
  let value: T | undefined;
  let pid: number | undefined;
  try {
    await client.connect(transport, requestOptions);
    pid = transport.pid ?? undefined;
    value = await operation(client, requestOptions);
  } catch (error) {
    const diagnostics = stderrCapture.diagnostics(pid ?? transport.pid ?? undefined);
    const timeout = isTimeoutError(error);
    throw new McpClientRunError({
      message: `MCP stdio ${timeout ? "timeout" : "transport/protocol failure"}: ${errorMessage(error)}`,
      exitCode: timeout ? 124 : 3,
      phase: timeout ? "timeout" : "transport_protocol",
      diagnostics,
      cause: error,
    });
  } finally {
    await client.close().catch(async () => {
      await transport.close().catch(() => undefined);
    });
  }

  return {
    value,
    diagnostics: stderrCapture.diagnostics(pid),
    ...(normalizeOptionalJsonObject(client.getServerVersion()) ? {serverInfo: normalizeOptionalJsonObject(client.getServerVersion())!} : {}),
    ...(normalizeOptionalJsonObject(client.getServerCapabilities()) ? {serverCapabilities: normalizeOptionalJsonObject(client.getServerCapabilities())!} : {}),
  };
}
