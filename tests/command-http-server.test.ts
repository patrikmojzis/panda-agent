import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import http from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {commandStaleVersionConflict, commandUnauthorized} from "../src/domain/commands/errors.js";
import type {RegisteredCommand} from "../src/domain/commands/types.js";
import {
  startCommandHttpServer,
  type CommandHttpServer,
} from "../src/integrations/commands/http-server.js";
import {FileSystemCommandUploadStore} from "../src/integrations/commands/file-uploads.js";
import {createTestCommandLeaseVerifier} from "./helpers/command-lease-verifier.js";

function staleWikiConflict() {
  return commandStaleVersionConflict({
    message: "The Wiki page changed after the supplied baseUpdatedAt.",
    resource: {
      kind: "wiki_page",
      path: "agents/panda/profile",
      locale: "en",
      latestUpdatedAt: "2026-07-18T20:00:00.000Z",
    },
    nextAction: {
      kind: "refresh_merge_write",
      command: "panda wiki read agents/panda/profile",
    },
  });
}

function createEchoCommand(): RegisteredCommand {
  return {
    descriptor: {
      name: "test.echo",
      summary: "Echo input.",
      description: "Returns the input payload.",
      usage: "panda test echo --json @payload.json",
      inputModes: ["json"],
      outputModes: ["json"],
      arguments: [],
      examples: [],
      schemaCatalog: {
        example: {
          kind: "test",
        },
      },
    },
    async execute(request) {
      return {
        ok: true,
        command: "test.echo",
        output: {
          ...request.input,
          ...(request.workingDirectory ? {workingDirectory: request.workingDirectory} : {}),
        },
        ...(request.input.artifact === true
          ? {
            artifact: {
              kind: "image" as const,
              source: "view_media" as const,
              path: "/tmp/result.png",
              mimeType: "image/png",
              bytes: 3,
            },
          }
          : {}),
      };
    },
  };
}

function createHyphenNamespaceCommand(): RegisteredCommand {
  return {
    descriptor: {
      name: "micro-app.echo",
      summary: "Echo micro-app input.",
      description: "Returns the input payload from a hyphenated command namespace.",
      usage: "panda micro-app echo --json @payload.json",
      inputModes: ["json"],
      outputModes: ["json"],
      arguments: [],
      examples: [],
    },
    async execute(request) {
      return {
        ok: true,
        command: "micro-app.echo",
        output: request.input,
      };
    },
  };
}

function createA2ASendCommand(): RegisteredCommand {
  return {
    descriptor: {
      name: "a2a.send",
      summary: "Send an A2A message.",
      description: "Consumes staged A2A uploads.",
      usage: "panda a2a send --json @payload.json",
      inputModes: ["json"],
      outputModes: ["json"],
      arguments: [],
      examples: [],
    },
    async execute() {
      return {ok: true, command: "a2a.send", output: {ok: true}};
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

describe("command HTTP server", () => {
  const servers: CommandHttpServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
    while (directories.length > 0) {
      await rm(directories.pop()!, {recursive: true, force: true});
    }
  });

  async function startServer() {
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({
        commands: [createEchoCommand(), createHyphenNamespaceCommand()],
      }),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-a", {
          agentKey: "panda",
          sessionId: "session-main",
          allowedCommands: ["test.*", "micro-app.*"],
        }],
      ]),
    });
    servers.push(server);
    return server;
  }

  it("lists allowed commands for a valid lease", async () => {
    const server = await startServer();

    const response = await fetch(`${server.url}/commands`, {
      headers: {
        authorization: "Bearer token-a",
      },
    });

    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({name: "test.echo"}),
        expect.objectContaining({name: "micro-app.echo"}),
      ]),
    });
    const commands = (body as {commands: {name: string; schemaCatalog?: unknown}[]}).commands;
    expect(commands.find((command) => command.name === "test.echo")).not.toHaveProperty("schemaCatalog");
  });

  it("returns descriptor-backed help", async () => {
    const server = await startServer();

    const response = await fetch(`${server.url}/commands/test.echo/help?format=json`, {
      headers: {
        authorization: "Bearer token-a",
      },
    });

    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toMatchObject({
      name: "test.echo",
      usage: "panda test echo --json @payload.json",
      schemaCatalog: {
        example: {
          kind: "test",
        },
      },
    });
  });

  it("accepts hyphenated command namespaces", async () => {
    const server = await startServer();

    const help = await fetch(`${server.url}/commands/micro-app.echo/help?format=json`, {
      headers: {
        authorization: "Bearer token-a",
      },
    });
    const execute = await fetch(`${server.url}/commands/execute`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "micro-app.echo",
        input: {
          message: "hello",
        },
      }),
    });

    expect(help.status).toBe(200);
    await expect(readJson(help)).resolves.toMatchObject({
      name: "micro-app.echo",
    });
    expect(execute.status).toBe(200);
    await expect(readJson(execute)).resolves.toMatchObject({
      ok: true,
      command: "micro-app.echo",
      output: {
        message: "hello",
      },
    });
  });

  it("executes commands with bearer-scoped authority", async () => {
    const server = await startServer();

    const response = await fetch(`${server.url}/commands/execute`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "test.echo",
        workingDirectory: "/workspace/nested",
        input: {
          message: "hello",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toMatchObject({
      ok: true,
      output: {
        message: "hello",
        workingDirectory: "/workspace/nested",
      },
    });
  });

  it("ignores client-supplied parent lineage and uses only the verified lease scope", async () => {
    const execute = vi.fn(async (request) => ({
      ok: true as const,
      command: request.command,
      output: {},
    }));
    const server = await startCommandHttpServer({
      executor: {execute},
      leaseVerifier: createTestCommandLeaseVerifier([
        ["lineage-token", {
          agentKey: "panda",
          sessionId: "session-main",
          threadId: "thread-trusted",
          runId: "run-trusted",
          parentToolCallId: "bash-call-trusted",
          allowedCommands: ["test.echo"],
        }],
      ]),
    });
    servers.push(server);

    const response = await fetch(`${server.url}/commands/execute`, {
      method: "POST",
      headers: {
        authorization: "Bearer lineage-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "test.echo",
        input: {message: "hello"},
        scope: {
          threadId: "thread-forged",
          runId: "run-forged",
          parentToolCallId: "bash-call-forged",
        },
        runId: "run-forged",
        parentToolCallId: "bash-call-forged",
      }),
    });

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].scope).toMatchObject({
      threadId: "thread-trusted",
      runId: "run-trusted",
      parentToolCallId: "bash-call-trusted",
    });
    expect(execute.mock.calls[0]?.[0].scope).not.toMatchObject({
      runId: "run-forged",
      parentToolCallId: "bash-call-forged",
    });
  });

  it("preserves command artifact metadata in execute responses", async () => {
    const server = await startServer();

    const response = await fetch(`${server.url}/commands/execute`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "test.echo",
        input: {
          artifact: true,
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toMatchObject({
      ok: true,
      artifact: {
        kind: "image",
        source: "view_media",
        path: "/tmp/result.png",
      },
    });
  });

  it("rejects malformed command working directories", async () => {
    const server = await startServer();

    const response = await fetch(`${server.url}/commands/execute`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "test.echo",
        workingDirectory: 42,
        input: {},
      }),
    });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toEqual({
      error: "Command workingDirectory must be a non-empty string.",
    });
  });

  it("rejects missing bearer tokens", async () => {
    const server = await startServer();

    const response = await fetch(`${server.url}/commands`);

    expect(response.status).toBe(401);
    await expect(readJson(response)).resolves.toEqual({
      ok: false,
      error: {
        code: "unauthorized",
        message: "Missing Panda command bearer token.",
        details: {
          failureCode: "bearer_missing",
          retryable: false,
          nextAction: {
            kind: "stop",
            reason: "Command access must be supplied by the runtime or operator.",
          },
          exitCode: 3,
        },
      },
    });
  });

  it("returns structured terminal failures for invalid and expired bearer tokens", async () => {
    const server = await startServer();
    const invalid = await fetch(`${server.url}/commands`, {
      headers: {authorization: "Bearer private-invalid-token"},
    });
    expect(invalid.status).toBe(401);
    const invalidBody = await readJson(invalid);
    expect(invalidBody).toMatchObject({
      ok: false,
      error: {
        code: "unauthorized",
        details: {failureCode: "bearer_invalid", retryable: false, exitCode: 3},
      },
    });
    expect(JSON.stringify(invalidBody)).not.toContain("private-invalid-token");
    expect(JSON.stringify(invalidBody)).not.toContain("requiredCapability");

    const expiredServer = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({commands: [createEchoCommand()]}),
      leaseVerifier: {
        async verify() {
          throw commandUnauthorized(
            "Panda command lease expired.",
            "lease_expired",
            "Command access must be refreshed by the runtime or operator.",
          );
        },
      },
    });
    servers.push(expiredServer);
    const expired = await fetch(`${expiredServer.url}/commands`, {
      headers: {authorization: "Bearer expired-token"},
    });
    expect(expired.status).toBe(401);
    await expect(readJson(expired)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unauthorized",
        details: {failureCode: "lease_expired", retryable: false, exitCode: 3},
      },
    });
  });

  it("returns structured forbidden capability failures without retrying the handler", async () => {
    const execute = vi.fn(createEchoCommand().execute);
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({
        commands: [{...createEchoCommand(), execute}],
      }),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-limited", {
          agentKey: "panda",
          sessionId: "session-main",
          allowedCommands: ["watch.create"],
        }],
      ]),
    });
    servers.push(server);

    const response = await fetch(`${server.url}/commands/execute`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-limited",
        "content-type": "application/json",
      },
      body: JSON.stringify({command: "test.echo", input: {secret: "private-input"}}),
    });
    expect(response.status).toBe(403);
    const body = await readJson(response);
    expect(body).toMatchObject({
      ok: false,
      command: "test.echo",
      error: {
        code: "forbidden",
        details: {
          failureCode: "capability_missing",
          retryable: false,
          requiredCapability: "test.echo",
          nextAction: {kind: "discover_capabilities", command: "panda commands --output json"},
          exitCode: 3,
        },
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("private-input");
  });

  it("returns stale conflicts as HTTP 409 with the refresh contract intact", async () => {
    const execute = vi.fn(async () => {
      throw staleWikiConflict();
    });
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({
        commands: [{...createEchoCommand(), execute}],
      }),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-a", {
          agentKey: "panda",
          sessionId: "session-main",
          allowedCommands: ["test.echo"],
        }],
      ]),
    });
    servers.push(server);

    const response = await fetch(`${server.url}/commands/execute`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({command: "test.echo", input: {content: "private stale content"}}),
    });

    expect(response.status).toBe(409);
    const body = await readJson(response);
    expect(body).toMatchObject({
      ok: false,
      command: "test.echo",
      error: {
        code: "conflict",
        details: {
          failureCode: "stale_version",
          retryable: false,
          requiresRefresh: true,
          nextAction: {
            kind: "refresh_merge_write",
            command: "panda wiki read agents/panda/profile",
          },
          exitCode: 4,
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain("private stale content");
  });

  it("aborts command execution when the HTTP caller disconnects", async () => {
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const command: RegisteredCommand = {
      descriptor: {
        name: "test.wait",
        summary: "Wait for cancellation.",
        description: "Waits until its caller disconnects.",
        usage: "panda test wait --json '{}'",
        inputModes: ["json"],
        outputModes: ["json"],
        arguments: [],
        examples: [],
      },
      async execute(request) {
        markStarted();
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => {
            markAborted();
            resolve();
          }, {once: true});
        });
        return {ok: true, command: "test.wait", output: {aborted: true}};
      },
    };
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({commands: [command]}),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-a", {
          agentKey: "panda",
          sessionId: "session-main",
          allowedCommands: ["test.wait"],
        }],
      ]),
    });
    servers.push(server);

    const request = http.request(`${server.url}/commands/execute`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-a",
        "content-type": "application/json",
      },
    });
    request.on("error", () => undefined);
    request.end(JSON.stringify({command: "test.wait", input: {}}));
    await started;
    request.destroy();

    await expect(Promise.race([
      aborted.then(() => "aborted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ])).resolves.toBe("aborted");
  });

  it("streams sender-scoped A2A uploads over HTTP", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "panda-command-upload-http-"));
    directories.push(dataDir);
    const fileUploads = new FileSystemCommandUploadStore({env: {DATA_DIR: dataDir}});
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({commands: [createA2ASendCommand()]}),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-a", {
          agentKey: "panda",
          sessionId: "session-main",
          allowedCommands: ["a2a.send"],
        }],
      ]),
      fileUploads,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/commands/files?for=a2a.send`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-a",
        "content-type": "text/plain; charset=utf-8",
        "x-panda-filename": "../../report.txt",
      },
      body: "report",
    });

    expect(response.status).toBe(201);
    const upload = await readJson(response) as {uploadRef: string};
    await expect(fileUploads.inspect({agentKey: "panda", sessionId: "session-main"}, upload.uploadRef))
      .resolves.toMatchObject({filename: "report.txt", mimeType: "text/plain", sizeBytes: 6});
  });

  it("rejects uploads when the lease cannot execute a2a.send", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "panda-command-upload-http-"));
    directories.push(dataDir);
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({commands: [createA2ASendCommand()]}),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-a", {
          agentKey: "panda",
          sessionId: "session-main",
          allowedCommands: ["test.*"],
        }],
      ]),
      fileUploads: new FileSystemCommandUploadStore({env: {DATA_DIR: dataDir}}),
    });
    servers.push(server);

    const response = await fetch(`${server.url}/commands/files?for=a2a.send`, {
      method: "POST",
      headers: {authorization: "Bearer token-a"},
      body: "report",
    });

    expect(response.status).toBe(403);
  });

  it("serves the same command contract over a Unix socket", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "panda-command-socket-"));
    directories.push(directory);
    const execute = vi.fn(async () => {
      throw staleWikiConflict();
    });
    const server = await startCommandHttpServer({
      socketPath: path.join(directory, "command.sock"),
      executor: new RuntimeCommandDispatcher({
        commands: [{...createEchoCommand(), execute}, createA2ASendCommand()],
      }),
      leaseVerifier: createTestCommandLeaseVerifier([
        ["token-a", {
          agentKey: "panda",
          sessionId: "session-main",
          allowedCommands: ["test.*", "a2a.send"],
        }],
      ]),
      fileUploads: new FileSystemCommandUploadStore({env: {DATA_DIR: directory}}),
    });
    servers.push(server);

    const response = await new Promise<{statusCode: number; body: string}>((resolve, reject) => {
      const request = http.request({
        socketPath: server.socketPath,
        method: "GET",
        path: "/commands",
        headers: {
          authorization: "Bearer token-a",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.on("error", reject);
      request.end();
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      commands: expect.arrayContaining([expect.objectContaining({
        name: "test.echo",
      })]),
    });

    const upload = await new Promise<{statusCode: number; body: string}>((resolve, reject) => {
      const request = http.request({
        socketPath: server.socketPath,
        method: "POST",
        path: "/commands/files?for=a2a.send",
        headers: {
          authorization: "Bearer token-a",
          "content-type": "text/plain",
          "x-panda-filename": "socket.txt",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.on("error", reject);
      request.end("socket upload");
    });

    expect(upload.statusCode).toBe(201);
    expect(JSON.parse(upload.body)).toMatchObject({
      uploadRef: expect.stringMatching(/^upl_[a-f0-9]{32}$/),
      filename: "socket.txt",
      sizeBytes: 13,
    });

    const denied = await new Promise<{statusCode: number; body: string}>((resolve, reject) => {
      const request = http.request({
        socketPath: server.socketPath,
        method: "GET",
        path: "/commands",
        headers: {authorization: "Bearer invalid-socket-token"},
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.on("error", reject);
      request.end();
    });
    expect(denied.statusCode).toBe(401);
    expect(JSON.parse(denied.body)).toMatchObject({
      ok: false,
      error: {
        code: "unauthorized",
        details: {failureCode: "bearer_invalid", retryable: false, exitCode: 3},
      },
    });

    const conflict = await new Promise<{statusCode: number; body: string}>((resolve, reject) => {
      const request = http.request({
        socketPath: server.socketPath,
        method: "POST",
        path: "/commands/execute",
        headers: {
          authorization: "Bearer token-a",
          "content-type": "application/json",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({command: "test.echo", input: {}}));
    });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body)).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        details: {failureCode: "stale_version", retryable: false, exitCode: 4},
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses to replace a non-socket Unix socket path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "panda-command-socket-"));
    directories.push(directory);
    const socketPath = path.join(directory, "command.sock");
    await writeFile(socketPath, "keep me");

    await expect(startCommandHttpServer({
      socketPath,
      executor: new RuntimeCommandDispatcher({
        commands: [createEchoCommand()],
      }),
      leaseVerifier: createTestCommandLeaseVerifier(),
    })).rejects.toThrow(`Refusing to remove non-socket Panda command path: ${socketPath}`);

    await expect(readFile(socketPath, "utf8")).resolves.toBe("keep me");
  });
});
