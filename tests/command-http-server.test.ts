import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import http from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import type {RegisteredCommand} from "../src/domain/commands/types.js";
import {
  startCommandHttpServer,
  type CommandHttpServer,
} from "../src/integrations/commands/http-server.js";
import {FileSystemCommandUploadStore} from "../src/integrations/commands/file-uploads.js";
import {createTestCommandLeaseVerifier} from "./helpers/command-lease-verifier.js";

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
      error: "Missing Panda command bearer token.",
    });
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
    const server = await startCommandHttpServer({
      socketPath: path.join(directory, "command.sock"),
      executor: new RuntimeCommandDispatcher({
        commands: [createEchoCommand(), createA2ASendCommand()],
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
