import {mkdir, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {RuntimeCommandFileResolver} from "../src/app/runtime/command-files.js";
import type {CommandRequest} from "../src/domain/commands/types.js";
import type {JsonObject} from "../src/lib/json.js";

function filesystemMetadata(root: string): JsonObject {
  return {
    filesystem: {
      envDir: "env-worker",
      root: {
        corePath: root,
      },
      workspace: {
        corePath: path.join(root, "workspace"),
        workerPath: "/workspace",
      },
      inbox: {
        corePath: path.join(root, "inbox"),
        workerPath: "/inbox",
      },
      artifacts: {
        corePath: path.join(root, "artifacts"),
        workerPath: "/artifacts",
      },
    },
  };
}

describe("RuntimeCommandFileResolver", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop()!, {recursive: true, force: true});
    }
  });

  it("maps workspace-relative command paths to core-readable files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "panda-command-files-"));
    directories.push(root);
    await mkdir(path.join(root, "workspace", "nested"), {recursive: true});
    await mkdir(path.join(root, "inbox"), {recursive: true});
    await mkdir(path.join(root, "artifacts"), {recursive: true});
    await writeFile(path.join(root, "workspace", "note.txt"), "hello");
    const request: CommandRequest = {
      command: "test.echo",
      input: {},
      workingDirectory: "/workspace/nested",
      scope: {
        agentKey: "panda",
        sessionId: "session-main",
        executionEnvironment: {
          id: "env-worker",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          source: "binding",
          metadata: filesystemMetadata(root),
        },
      },
    };

    const expectedPath = await realpath(path.join(root, "workspace", "note.txt"));
    await expect(new RuntimeCommandFileResolver().resolveReadablePath({
      request,
      file: {
        path: "../note.txt",
      },
    })).resolves.toEqual({
      displayPath: "../note.txt",
      path: expectedPath,
    });
  });

  it("maps workspace-relative command paths to core-writable files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "panda-command-files-"));
    directories.push(root);
    await mkdir(path.join(root, "workspace", "nested"), {recursive: true});
    await mkdir(path.join(root, "inbox"), {recursive: true});
    await mkdir(path.join(root, "artifacts"), {recursive: true});
    const request: CommandRequest = {
      command: "test.echo",
      input: {},
      workingDirectory: "/workspace/nested",
      scope: {
        agentKey: "panda",
        sessionId: "session-main",
        executionEnvironment: {
          id: "env-worker",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          source: "binding",
          metadata: filesystemMetadata(root),
        },
      },
    };

    const resolved = await new RuntimeCommandFileResolver().resolveWritablePath({
      request,
      file: {
        path: "../fetched/page.md",
      },
    });

    const realRoot = await realpath(root);
    expect(resolved).toEqual({
      displayPath: "../fetched/page.md",
      path: path.join(realRoot, "workspace", "fetched", "page.md"),
    });
  });

  it("rejects bound environment command paths outside shared roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "panda-command-files-"));
    directories.push(root);
    await mkdir(path.join(root, "workspace"), {recursive: true});
    await mkdir(path.join(root, "inbox"), {recursive: true});
    await mkdir(path.join(root, "artifacts"), {recursive: true});
    const request: CommandRequest = {
      command: "test.echo",
      input: {},
      scope: {
        agentKey: "panda",
        sessionId: "session-main",
        executionEnvironment: {
          id: "env-worker",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          source: "binding",
          metadata: filesystemMetadata(root),
        },
      },
    };

    await expect(new RuntimeCommandFileResolver().resolveReadablePath({
      request,
      file: {
        path: "/etc/passwd",
      },
    })).rejects.toThrow("outside this execution environment's shared filesystem roots");
  });
});
