import {mkdtemp, mkdir, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {RuntimeCommandFileResolver} from "../src/app/runtime/command-files.js";
import {
  createEnvironmentCreateCommand,
  createEnvironmentLogsCommand,
  ENVIRONMENT_CREATE_COMMAND_NAME,
  ENVIRONMENT_LOGS_COMMAND_NAME,
} from "../src/domain/execution-environments/commands.js";

function createEnvironmentMetadata(root: string) {
  return {
    filesystem: {
      envDir: "worker-a",
      root: {
        corePath: root,
        parentRunnerPath: "/environments/worker-a",
      },
      workspace: {
        corePath: path.join(root, "workspace"),
        parentRunnerPath: "/environments/worker-a/workspace",
        workerPath: "/workspace",
      },
      inbox: {
        corePath: path.join(root, "inbox"),
        parentRunnerPath: "/environments/worker-a/inbox",
        workerPath: "/inbox",
      },
      artifacts: {
        corePath: path.join(root, "artifacts"),
        parentRunnerPath: "/environments/worker-a/artifacts",
        workerPath: "/artifacts",
      },
    },
  };
}

describe("environment commands", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of directories) {
      await rm(directory, {recursive: true, force: true});
    }
    directories.clear();
  });

  it("resolves workspace setup scripts before creating an environment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "panda-environment-command-"));
    directories.add(root);
    const workspaceNested = path.join(root, "workspace", "nested");
    const setupPath = path.join(workspaceNested, "setup.sh");
    await mkdir(workspaceNested, {recursive: true});
    await writeFile(setupPath, "#!/usr/bin/env bash\necho ready\n", "utf8");
    const resolvedSetupPath = await realpath(setupPath);

    const createStandaloneDisposableEnvironment = vi.fn(async (input) => ({
      id: "environment:session-a:created",
      agentKey: input.agentKey,
      kind: "disposable_container" as const,
      state: "ready" as const,
      runnerUrl: "http://environment:8080",
      runnerCwd: "/workspace",
      rootPath: "/workspace",
      createdBySessionId: input.createdBySessionId,
      metadata: {
        filesystem: createEnvironmentMetadata(root).filesystem,
        setup: {
          status: "succeeded",
          artifacts: {
            script: "/artifacts/setup/setup.sh",
          },
        },
      },
      createdAt: 1,
      updatedAt: 2,
    }));
    const command = createEnvironmentCreateCommand({
      lifecycle: {
        createStandaloneDisposableEnvironment,
      },
    }, new RuntimeCommandFileResolver());

    const result = await command.execute({
      command: ENVIRONMENT_CREATE_COMMAND_NAME,
      input: {
        label: "review",
        setupScript: "setup.sh",
      },
      workingDirectory: "/workspace/nested",
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
        executionEnvironment: {
          id: "worker:session-a",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          source: "binding",
          metadata: createEnvironmentMetadata(root),
        },
      },
    });

    expect(createStandaloneDisposableEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: "panda",
      createdBySessionId: "session-a",
      metadata: {
        label: "review",
        createdByTool: "environment.create",
      },
      setupScript: {
        requestedPath: "setup.sh",
        resolvedPath: resolvedSetupPath,
      },
    }));
    expect(result.output).toMatchObject({
      status: "created",
      environmentId: "environment:session-a:created",
      setup: {
        status: "succeeded",
      },
    });
  });

  it("reads logs only for session-owned disposable environments", async () => {
    const readEnvironmentLogs = vi.fn(async () => ({
      entries: [
        {
          role: "workspace" as const,
          stdout: "workspace booted\n",
          stderr: "",
        },
      ],
    }));
    const command = createEnvironmentLogsCommand({
      environments: {
        getEnvironment: vi.fn(async (environmentId: string) => ({
          id: environmentId,
          agentKey: "panda",
          kind: "disposable_container" as const,
          state: "ready" as const,
          runnerUrl: "http://environment:8080",
          runnerCwd: "/workspace",
          rootPath: "/workspace",
          createdBySessionId: "session-a",
          createdAt: 1,
          updatedAt: 2,
        })),
      },
      lifecycle: {
        readEnvironmentLogs,
      },
    });

    const result = await command.execute({
      command: ENVIRONMENT_LOGS_COMMAND_NAME,
      input: {
        environmentId: "environment:session-a:created",
        role: "workspace",
        tail: 25,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
      },
    });

    expect(readEnvironmentLogs).toHaveBeenCalledWith({
      environmentId: "environment:session-a:created",
      role: "workspace",
      tail: 25,
    });
    expect(result.output).toMatchObject({
      operation: "logs",
      environmentId: "environment:session-a:created",
      role: "workspace",
      tail: 25,
      entries: [
        {
          role: "workspace",
          stdout: "workspace booted\n",
          stderr: "",
        },
      ],
    });

    const blocked = createEnvironmentLogsCommand({
      environments: {
        getEnvironment: vi.fn(async (environmentId: string) => ({
          id: environmentId,
          agentKey: "panda",
          kind: "disposable_container" as const,
          state: "ready" as const,
          createdBySessionId: "session-other",
          createdAt: 1,
          updatedAt: 2,
        })),
      },
      lifecycle: {
        readEnvironmentLogs,
      },
    });

    await expect(blocked.execute({
      command: ENVIRONMENT_LOGS_COMMAND_NAME,
      input: {
        environmentId: "environment:session-other:created",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
      },
    })).rejects.toThrow("is not owned by this session");
  });
});
