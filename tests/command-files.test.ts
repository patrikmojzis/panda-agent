import {mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {RuntimeCommandFileResolver} from "../src/app/runtime/command-files.js";
import type {CommandRequest} from "../src/domain/commands/types.js";
import {ToolError} from "../src/kernel/agent/exceptions.js";
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

  it.each([
    ["agent home", "file"], ["agent home", "directory"],
    ["collaboration workspace", "file"], ["collaboration workspace", "directory"],
    ["disposable artifacts", "file"], ["disposable artifacts", "directory"],
  ])("rejects %s escapes through a symlinked %s", async (mount, symlinkKind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "panda-command-files-"));
    directories.push(root);
    const environmentRoot = path.join(root, "environment");
    const mountedRoot = mount === "agent home" ? path.join(root, "agents", "panda")
      : mount === "disposable artifacts" ? path.join(environmentRoot, "artifacts")
        : path.join(root, "shared");
    const outside = path.join(root, "outside");
    await mkdir(mountedRoot, {recursive: true});
    await mkdir(outside);
    await writeFile(path.join(outside, "private.txt"), "private");
    await symlink(symlinkKind === "file" ? path.join(outside, "private.txt") : outside, path.join(mountedRoot, "escape"));
    const runnerRoot = mount === "agent home" ? "/root/.panda/agents/panda"
      : mount === "disposable artifacts" ? "/artifacts" : "/workspace/shared";
    const filePath = `${runnerRoot}/escape${symlinkKind === "file" ? "" : "/private.txt"}`;
    const resolver = new RuntimeCommandFileResolver({
      DATA_DIR: root,
      BASH_EXECUTION_MODE: "remote",
      BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
      PANDA_CORE_SHARED_ROOT: mountedRoot,
      PANDA_SHARED_WORKSPACE_AGENTS: "panda",
    });
    const request: CommandRequest = {
      command: "test.echo",
      input: {},
      scope: {
        agentKey: "panda", sessionId: "session-main",
        ...(mount === "disposable artifacts" ? {executionEnvironment: {
          id: "env-worker", agentKey: "panda", kind: "disposable_container" as const,
          state: "ready" as const, source: "binding" as const, metadata: filesystemMetadata(environmentRoot),
        }} : {}),
      },
    };

    const result = resolver.resolveReadablePath({request, file: {path: filePath}});
    await expect(result).rejects.toBeInstanceOf(ToolError);
    await expect(result).rejects.toThrow(
      symlinkKind === "file" ? `Could not open readable file: ${filePath}`
        : `Resolved path escapes the execution environment root: ${filePath}`,
    );
  });

  it("snapshots authorized collaboration files and rejects another agent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "panda-command-files-"));
    directories.push(root);
    const sharedRoot = path.join(root, "shared");
    const source = path.join(sharedRoot, "report.txt");
    const outside = path.join(root, "outside.txt");
    await mkdir(sharedRoot);
    await writeFile(source, "safe");
    await writeFile(outside, "private");
    const resolver = new RuntimeCommandFileResolver({
      DATA_DIR: root, PANDA_CORE_SHARED_ROOT: sharedRoot, PANDA_SHARED_WORKSPACE_AGENTS: "panda",
    });
    const request: CommandRequest = {
      command: "test.echo", input: {}, scope: {agentKey: "panda", sessionId: "session-main"},
    };
    const file = {path: "/workspace/shared/report.txt"};

    await expect(resolver.resolveReadablePath({
      request: {...request, scope: {...request.scope, agentKey: "luna"}}, file,
    })).rejects.toThrow("not authorised for the shared collaboration workspace");
    const resolved = await resolver.resolveReadablePath({request, file});
    await rename(source, `${source}.old`);
    await symlink(outside, source);

    expect(resolved.displayPath).toBe(file.path);
    expect(resolved.path).toContain(path.join(root, "outbound-file-spool"));
    await expect(readFile(resolved.path, "utf8")).resolves.toBe("safe");
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

    const dataDir = path.join(root, "core-data");
    const resolved = await new RuntimeCommandFileResolver({...process.env, DATA_DIR: dataDir}).resolveReadablePath({
      request,
      file: {
        path: "../note.txt",
      },
    });
    expect(resolved.displayPath).toBe("../note.txt");
    expect(resolved.path).toContain(path.join(dataDir, "outbound-file-spool"));
    await expect(readFile(resolved.path, "utf8")).resolves.toBe("hello");
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
