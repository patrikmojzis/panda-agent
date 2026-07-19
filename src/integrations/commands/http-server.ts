import {lstat, mkdir, rm} from "node:fs/promises";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import path from "node:path";

import {commandDescriptorToJson, formatCommandHelp} from "../../domain/commands/help.js";
import type {CommandDescriptor, CommandExecutor, CommandName, CommandScope, CommandOutputMode} from "../../domain/commands/types.js";
import {writeJsonResponse} from "../../lib/http.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull} from "../../lib/strings.js";
import {readJsonHttpBody} from "../http-body.js";
import {CommandUploadError, type FileSystemCommandUploadStore} from "./file-uploads.js";

const MAX_COMMAND_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMAND_HTTP_HOST = "127.0.0.1";
const DEFAULT_COMMAND_HTTP_PORT = 0;
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;

export interface CommandLeaseVerifier {
  verify(token: string): Promise<CommandScope | undefined>;
}

export interface CommandHttpServerOptions {
  executor: CommandExecutor;
  leaseVerifier: CommandLeaseVerifier;
  host?: string;
  port?: number;
  socketPath?: string;
  fileUploads?: Pick<FileSystemCommandUploadStore, "stage">;
}

export interface CommandHttpServer {
  server: Server;
  host: string;
  port: number;
  socketPath?: string;
  url: string;
  close(): Promise<void>;
}

class CommandHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "CommandHttpError";
    this.statusCode = statusCode;
  }
}

function readBearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = value?.startsWith("Bearer ") ? trimToNull(value.slice("Bearer ".length)) : null;
  if (!token) {
    throw new CommandHttpError(401, "Missing Panda command bearer token.");
  }

  return token;
}

async function readCommandScope(request: IncomingMessage, verifier: CommandLeaseVerifier): Promise<CommandScope> {
  const scope = await verifier.verify(readBearerToken(request));
  if (!scope) {
    throw new CommandHttpError(403, "Invalid Panda command bearer token.");
  }

  return scope;
}

function parseCommandName(value: unknown): CommandName {
  if (typeof value !== "string" || !COMMAND_NAME_PATTERN.test(value)) {
    throw new CommandHttpError(400, "Command name must use namespace.name form.");
  }

  return value as CommandName;
}

function parseOutputMode(value: unknown): CommandOutputMode | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "json" || value === "text") {
    return value;
  }

  throw new CommandHttpError(400, "Command outputMode must be json or text.");
}

function parseWorkingDirectory(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  throw new CommandHttpError(400, "Command workingDirectory must be a non-empty string.");
}

async function listDescriptors(executor: CommandExecutor, scope: CommandScope): Promise<readonly CommandDescriptor[]> {
  return executor.listCommands ? executor.listCommands(scope) : [];
}

function findDescriptor(descriptors: readonly CommandDescriptor[], name: CommandName): CommandDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.name === name);
}

async function readCommandRequestBody(request: IncomingMessage): Promise<{
  command: CommandName;
  input: JsonObject;
  outputMode?: CommandOutputMode;
  workingDirectory?: string;
}> {
  const body = await readJsonHttpBody(request, {
    maxBytes: MAX_COMMAND_HTTP_BODY_BYTES,
    tooLargeMessage: "Panda command request body is too large.",
    invalidJsonPrefix: "Invalid Panda command JSON",
    createError: (statusCode, message) => new CommandHttpError(statusCode, message),
  });
  if (!isRecord(body)) {
    throw new CommandHttpError(400, "Panda command request body must be a JSON object.");
  }

  const input = body.input === undefined ? {} : body.input;
  if (!isJsonObject(input)) {
    throw new CommandHttpError(400, "Panda command input must be a JSON object.");
  }

  const workingDirectory = parseWorkingDirectory(body.workingDirectory);
  return {
    command: parseCommandName(body.command),
    input,
    outputMode: parseOutputMode(body.outputMode),
    ...(workingDirectory === undefined ? {} : {workingDirectory}),
  };
}

function writeTextResponse(response: ServerResponse, statusCode: number, text: string): void {
  response.writeHead(statusCode, {"content-type": "text/plain; charset=utf-8"});
  response.end(text);
}

async function removeSocketPath(socketPath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(socketPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (!stats.isSocket()) {
    throw new Error(`Refusing to remove non-socket Panda command path: ${socketPath}`);
  }

  await rm(socketPath);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CommandHttpServerOptions,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (method === "GET" && url.pathname === "/health") {
    writeJsonResponse(response, 200, {ok: true});
    return;
  }

  const scope = await readCommandScope(request, options.leaseVerifier);

  if (method === "POST" && url.pathname === "/commands/files") {
    if (url.searchParams.get("for") !== "a2a.send") {
      throw new CommandHttpError(400, "Command file upload requires for=a2a.send.");
    }
    if (!options.fileUploads) {
      throw new CommandHttpError(404, "Command file upload is unavailable.");
    }
    const descriptor = findDescriptor(await listDescriptors(options.executor, scope), "a2a.send");
    if (!descriptor) {
      throw new CommandHttpError(403, "Command lease does not permit a2a.send uploads.");
    }
    const filenameHeader = request.headers["x-panda-filename"];
    const filename = Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader;
    try {
      const uploaded = await options.fileUploads.stage({
        scope: {agentKey: scope.agentKey, sessionId: scope.sessionId},
        filename,
        mimeType: request.headers["content-type"],
        chunks: request,
      });
      writeJsonResponse(response, 201, uploaded);
      return;
    } catch (error) {
      if (error instanceof CommandUploadError) {
        throw new CommandHttpError(error.statusCode, error.message);
      }
      throw error;
    }
  }

  if (method === "GET" && url.pathname === "/commands") {
    const descriptors = await listDescriptors(options.executor, scope);
    writeJsonResponse(response, 200, {
      commands: descriptors.map((descriptor) => commandDescriptorToJson(descriptor)),
    });
    return;
  }

  const helpMatch = /^\/commands\/([^/]+)\/help$/.exec(url.pathname);
  if (method === "GET" && helpMatch) {
    const commandName = parseCommandName(decodeURIComponent(helpMatch[1]!));
    const descriptor = findDescriptor(await listDescriptors(options.executor, scope), commandName);
    if (!descriptor) {
      writeJsonResponse(response, 404, {error: "unknown_command"});
      return;
    }

    if (url.searchParams.get("format") === "json") {
      writeJsonResponse(response, 200, commandDescriptorToJson(descriptor, {
        includeSchemaCatalog: true,
      }));
      return;
    }

    writeTextResponse(response, 200, formatCommandHelp(descriptor));
    return;
  }

  if (method === "POST" && url.pathname === "/commands/execute") {
    const body = await readCommandRequestBody(request);
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    const abortOnResponseClose = () => {
      if (!response.writableFinished) {
        abort();
      }
    };
    request.once("aborted", abort);
    response.once("close", abortOnResponseClose);
    const result = await options.executor.execute({
      command: body.command,
      input: body.input,
      scope,
      signal: abortController.signal,
      ...(body.outputMode === undefined ? {} : {outputMode: body.outputMode}),
      ...(body.workingDirectory === undefined ? {} : {workingDirectory: body.workingDirectory}),
    }).finally(() => {
      request.removeListener("aborted", abort);
      response.removeListener("close", abortOnResponseClose);
    });
    writeJsonResponse(response, result.ok ? 200 : 400, result);
    return;
  }

  writeJsonResponse(response, 404, {error: "not_found"});
}

export async function startCommandHttpServer(options: CommandHttpServerOptions): Promise<CommandHttpServer> {
  const host = options.host ?? DEFAULT_COMMAND_HTTP_HOST;
  const requestedPort = options.port ?? DEFAULT_COMMAND_HTTP_PORT;
  const socketPath = trimToNull(options.socketPath);
  const server = createServer((request, response) => {
    void handleRequest(request, response, options).catch((error) => {
      if (error instanceof CommandHttpError) {
        writeJsonResponse(response, error.statusCode, {error: error.message});
        return;
      }

      writeJsonResponse(response, 500, {error: "internal_error"});
    });
  });

  if (socketPath) {
    await mkdir(path.dirname(socketPath), {recursive: true});
    await removeSocketPath(socketPath);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const listen = socketPath
      ? () => server.listen(socketPath, onListening)
      : () => server.listen(requestedPort, host, onListening);
    const onListening = () => {
      server.off("error", reject);
      resolve();
    };
    listen();
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  return {
    server,
    host,
    port,
    ...(socketPath ? {socketPath} : {}),
    url: socketPath ? "http://panda-command" : `http://${host}:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }).then(async () => {
      if (socketPath) {
        await removeSocketPath(socketPath);
      }
    }),
  };
}
