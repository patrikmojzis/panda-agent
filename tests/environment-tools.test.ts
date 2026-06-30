import {chmod, mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {describe, expect, it, vi} from "vitest";

import {
  Agent,
  type DefaultAgentSessionContext,
  EnvironmentCreateTool,
  RunContext,
  SpawnSubagentTool,
} from "../src/index.js";
import type {ExecutionEnvironmentRecord} from "../src/domain/execution-environments/types.js";

function createRunContext(context: Partial<DefaultAgentSessionContext> = {}): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "panda",
      instructions: "Test",
    }),
    turn: 0,
    maxTurns: 5,
    messages: [],
    context: {
      cwd: "/workspace",
      agentKey: "panda",
      sessionId: "parent-session",
      threadId: "parent-thread",
      ...context,
    },
  });
}

function createFilesystemMetadata(envDir = "environment-session") {
  return {
    filesystem: {
      envDir,
      root: {
        corePath: `/root/.panda/environments/panda/${envDir}`,
        parentRunnerPath: `/environments/${envDir}`,
      },
      workspace: {
        corePath: `/root/.panda/environments/panda/${envDir}/workspace`,
        parentRunnerPath: `/environments/${envDir}/workspace`,
        workerPath: "/workspace",
      },
      inbox: {
        corePath: `/root/.panda/environments/panda/${envDir}/inbox`,
        parentRunnerPath: `/environments/${envDir}/inbox`,
        workerPath: "/inbox",
      },
      artifacts: {
        corePath: `/root/.panda/environments/panda/${envDir}/artifacts`,
        parentRunnerPath: `/environments/${envDir}/artifacts`,
        workerPath: "/artifacts",
      },
    },
  };
}

function createEnvironment(overrides: Partial<ExecutionEnvironmentRecord> = {}): ExecutionEnvironmentRecord {
  return {
    id: "environment:parent-session:abc",
    agentKey: "panda",
    kind: "disposable_container",
    state: "ready",
    runnerUrl: "http://environment:8080",
    runnerCwd: "/workspace",
    rootPath: "/workspace",
    createdBySessionId: "parent-session",
    metadata: createFilesystemMetadata(),
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe("environment control tools", () => {
  it("exposes setupScript only on environment_create, not spawn_subagent", () => {
    expect(EnvironmentCreateTool.schema.shape).toHaveProperty("setupScript");
    expect(SpawnSubagentTool.schema.shape).not.toHaveProperty("setupScript");
  });

  it("does not auto-discover environment-setup.sh when setupScript is omitted", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-explicit-"));
    try {
      await writeFile(path.join(tmp, "environment-setup.sh"), "#!/usr/bin/env bash\necho ignored\n", "utf8");
      const createStandaloneDisposableEnvironment = vi.fn(async () => createEnvironment());
      const tool = new EnvironmentCreateTool({
        lifecycle: {
          createStandaloneDisposableEnvironment,
        },
      });

      await tool.run({}, createRunContext({cwd: tmp}));

      expect(createStandaloneDisposableEnvironment).toHaveBeenCalledWith(expect.not.objectContaining({
        setupScript: expect.anything(),
      }));
    } finally {
      await rm(tmp, {recursive: true, force: true});
    }
  });

  it("passes a validated setupScript path to standalone environment creation", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-tool-"));
    try {
      await writeFile(path.join(tmp, "setup.sh"), "#!/usr/bin/env bash\necho ready\n", "utf8");
      const environment = createEnvironment({
        metadata: {
          ...createFilesystemMetadata("environment-session"),
          setup: {
            status: "succeeded",
            artifacts: {
              script: "/artifacts/setup/setup.sh",
            },
          },
        },
      });
      const createStandaloneDisposableEnvironment = vi.fn(async () => environment);
      const tool = new EnvironmentCreateTool({
        lifecycle: {
          createStandaloneDisposableEnvironment,
        },
      });

      const result = await tool.run({
        label: "review env",
        setupScript: "setup.sh",
      }, createRunContext({
        cwd: tmp,
      }));

      expect(createStandaloneDisposableEnvironment).toHaveBeenCalledWith(expect.objectContaining({
        agentKey: "panda",
        createdBySessionId: "parent-session",
        setupScript: {
          requestedPath: "setup.sh",
          resolvedPath: path.join(tmp, "setup.sh"),
        },
      }));
      expect(result).toMatchObject({
        status: "created",
        environmentId: "environment:parent-session:abc",
        setup: {
          status: "succeeded",
          artifacts: {
            script: "/artifacts/setup/setup.sh",
          },
        },
      });
    } finally {
      await rm(tmp, {recursive: true, force: true});
    }
  });

  it("rejects invalid setupScript paths before lifecycle creation", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-invalid-"));
    try {
      await mkdir(path.join(tmp, "setup-dir"));
      await writeFile(path.join(tmp, "setup.txt"), "echo no\n", "utf8");
      await writeFile(path.join(tmp, "unreadable.sh"), "echo no\n", "utf8");
      await chmod(path.join(tmp, "unreadable.sh"), 0o000);
      const createStandaloneDisposableEnvironment = vi.fn();
      const tool = new EnvironmentCreateTool({
        lifecycle: {
          createStandaloneDisposableEnvironment,
        },
      });
      const context = createRunContext({cwd: tmp});

      await expect(tool.run({setupScript: "missing.sh"}, context)).rejects.toThrow("No readable setup script");
      await expect(tool.run({setupScript: "setup-dir"}, context)).rejects.toThrow("regular .sh file");
      await expect(tool.run({setupScript: "setup.txt"}, context)).rejects.toThrow(".sh file");
      await expect(tool.run({setupScript: "unreadable.sh"}, context)).rejects.toThrow("not readable");
      expect(createStandaloneDisposableEnvironment).not.toHaveBeenCalled();
    } finally {
      await chmod(path.join(tmp, "unreadable.sh"), 0o644).catch(() => undefined);
      await rm(tmp, {recursive: true, force: true});
    }
  });
});
