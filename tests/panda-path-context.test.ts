import path from "node:path";
import {mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile} from "node:fs/promises";
import os from "node:os";

import {afterEach, describe, expect, it, vi} from "vitest";

import {materializeReadableContextPath, resolveContextPath, resolveReadableContextPath} from "../src/app/runtime/panda-path-context.js";
import {ToolError} from "../src/index.js";

function createDisposableContext(root: string, artifacts = path.join(root, "artifacts")) {
  return {
    agentKey: "clawd",
    executionEnvironment: {
      id: "env-worker",
      agentKey: "clawd",
      kind: "disposable_container",
      source: "binding",
      metadata: {
        filesystem: {
          envDir: "worker-a",
          root: {
            corePath: root,
            parentRunnerPath: "/environments/worker-a",
          },
          workspace: {
            corePath: path.join(root, "workspace"),
            workerPath: "/workspace",
            parentRunnerPath: "/environments/worker-a/workspace",
          },
          inbox: {
            corePath: path.join(root, "inbox"),
            workerPath: "/inbox",
            parentRunnerPath: "/environments/worker-a/inbox",
          },
          artifacts: {
            corePath: artifacts,
            workerPath: "/artifacts",
            parentRunnerPath: "/environments/worker-a/artifacts",
          },
        },
      },
    },
  };
}

describe("resolveContextPath", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop() ?? "", {recursive: true, force: true});
    }
  });

  async function makeTempDir(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-path-context-"));
    directories.push(directory);
    return directory;
  }

  it("maps remote runner agent-home paths back to the local agent home", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("BASH_SERVER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/tester/.panda");

    expect(resolveContextPath("/root/.panda/agents/jozef/media/browser/shot.png", {
      agentKey: "jozef",
    })).toBe(path.join("/Users/tester/.panda", "agents", "jozef", "media", "browser", "shot.png"));
  });

  it("maps relative paths resolved from the remote runner cwd", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("BASH_SERVER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/tester/.panda");

    expect(resolveContextPath("media/telegram/photo.jpg", {
      agentKey: "jozef",
      shell: {
        cwd: "/root/.panda/agents/jozef",
        env: {},
      },
    })).toBe(path.join("/Users/tester/.panda", "agents", "jozef", "media", "telegram", "photo.jpg"));
  });

  it("rejects arbitrary Core paths from remote agent file commands", () => {
    const env = {
      ...process.env,
      BASH_EXECUTION_MODE: "remote",
      BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
      DATA_DIR: "/Users/tester/.panda",
    };

    expect(() => resolveContextPath(
      "/run/secrets/panda-core/runner-token-master-key",
      {agentKey: "jozef"},
      env,
    )).toThrow("outside this agent's mounted filesystem roots");
  });

  it("rejects symlink escapes from a mapped remote agent home", async () => {
    const dataDir = await makeTempDir();
    const agentRoot = path.join(dataDir, "agents", "jozef");
    const outside = path.join(dataDir, "core-secret");
    await mkdir(agentRoot, {recursive: true});
    await writeFile(outside, "private");
    await symlink(outside, path.join(agentRoot, "escape"));
    const env = {
      ...process.env,
      BASH_EXECUTION_MODE: "remote",
      BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
      DATA_DIR: dataDir,
    };

    await expect(resolveReadableContextPath(
      "/root/.panda/agents/jozef/escape",
      {agentKey: "jozef"},
      env,
    )).rejects.toThrow("escapes the execution environment root");
  });

  it("leaves non-agent-home paths alone in remote mode", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("BASH_SERVER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/tester/.panda");

    expect(resolveContextPath("/workspace/shared/report.png", {
      agentKey: "jozef",
    })).toBe("/workspace/shared/report.png");
  });

  it("maps and contains authorised collaboration workspace paths", async () => {
    const sharedRoot = await makeTempDir();
    await writeFile(path.join(sharedRoot, "report.txt"), "safe");
    const env = {
      ...process.env,
      PANDA_CORE_SHARED_ROOT: sharedRoot,
      PANDA_SHARED_WORKSPACE_AGENTS: "panda",
    };

    await expect(resolveReadableContextPath("/workspace/shared/report.txt", {agentKey: "panda"}, env))
      .resolves.toBe(await realpath(path.join(sharedRoot, "report.txt")));
    expect(() => resolveContextPath("/workspace/shared/report.txt", {agentKey: "luna"}, env))
      .toThrow("not authorised for the shared collaboration workspace");
  });

  it("materializes a private immutable snapshot before an untrusted source can be swapped", async () => {
    const root = await makeTempDir();
    const sharedRoot = path.join(root, "shared");
    const dataDir = path.join(root, "core-data");
    const source = path.join(sharedRoot, "report.txt");
    const outside = path.join(root, "outside.txt");
    await mkdir(sharedRoot);
    await writeFile(source, "safe");
    await writeFile(outside, "private");
    const env = {
      ...process.env,
      DATA_DIR: dataDir,
      PANDA_CORE_SHARED_ROOT: sharedRoot,
      PANDA_SHARED_WORKSPACE_AGENTS: "panda",
    };

    const snapshot = await materializeReadableContextPath(
      "/workspace/shared/report.txt",
      {agentKey: "panda"},
      env,
    );
    await rename(source, `${source}.old`);
    await symlink(outside, source);

    await expect(readFile(snapshot, "utf8")).resolves.toBe("safe");
    expect(snapshot).toContain(path.join(dataDir, "outbound-file-spool"));
  });

  it("rejects symlink escapes from the collaboration workspace", async () => {
    const root = await makeTempDir();
    const sharedRoot = path.join(root, "shared");
    const outside = path.join(root, "outside.txt");
    await mkdir(sharedRoot);
    await writeFile(outside, "private");
    await symlink(outside, path.join(sharedRoot, "escape.txt"));
    const env = {
      ...process.env,
      PANDA_CORE_SHARED_ROOT: sharedRoot,
      PANDA_SHARED_WORKSPACE_AGENTS: "panda",
    };

    await expect(resolveReadableContextPath("/workspace/shared/escape.txt", {agentKey: "panda"}, env))
      .rejects.toThrow("escapes the execution environment root");
  });

  it("does not grant isolated environments the host collaboration mount implicitly", () => {
    const env = {
      ...process.env,
      PANDA_CORE_SHARED_ROOT: "/host/company",
      PANDA_SHARED_WORKSPACE_AGENTS: "panda",
    };
    expect(() => resolveContextPath("/workspace/shared/repo", {
      agentKey: "panda",
      executionEnvironment: {
        id: "env-isolated",
        agentKey: "panda",
        kind: "disposable_container",
        source: "binding",
      },
    }, env)).toThrow("not attached to the shared collaboration workspace");
  });

  it("fails closed when a disposable environment lacks filesystem metadata", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("BASH_SERVER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/tester/.panda");

    expect(() => resolveContextPath("/root/.panda/agents/jozef/media/browser/shot.png", {
      agentKey: "jozef",
      executionEnvironment: {
        id: "env-worker",
        agentKey: "jozef",
        kind: "disposable_container",
        source: "binding",
      },
    })).toThrow("no verified Core filesystem mapping");
  });

  it("maps disposable worker paths through filesystem metadata", () => {
    expect(resolveContextPath("/artifacts/report.txt", {
      agentKey: "clawd",
      executionEnvironment: {
        id: "env-worker",
        agentKey: "clawd",
        kind: "disposable_container",
        source: "binding",
        metadata: {
          filesystem: {
            envDir: "worker-a",
            root: {
              corePath: "/root/.panda/environments/clawd/worker-a",
              parentRunnerPath: "/environments/worker-a",
            },
            workspace: {
              corePath: "/root/.panda/environments/clawd/worker-a/workspace",
              workerPath: "/workspace",
              parentRunnerPath: "/environments/worker-a/workspace",
            },
            inbox: {
              corePath: "/root/.panda/environments/clawd/worker-a/inbox",
              workerPath: "/inbox",
              parentRunnerPath: "/environments/worker-a/inbox",
            },
            artifacts: {
              corePath: "/root/.panda/environments/clawd/worker-a/artifacts",
              workerPath: "/artifacts",
              parentRunnerPath: "/environments/worker-a/artifacts",
            },
          },
        },
      },
    })).toBe("/root/.panda/environments/clawd/worker-a/artifacts/report.txt");
  });

  it("maps bound disposable environment roots through filesystem metadata", () => {
    expect(resolveContextPath("/environments/worker-a", createDisposableContext(
      "/root/.panda/environments/clawd/worker-a",
      "/root/.panda/environments/clawd/worker-a/artifacts",
    ))).toBe("/root/.panda/environments/clawd/worker-a");
  });

  it("maps parent runner environment paths inside the current agent namespace", () => {
    const env = {
      ...process.env,
      PANDA_ENVIRONMENTS_ROOT: "/root/.panda/environments",
      PANDA_RUNNER_ENVIRONMENTS_ROOT: "/environments",
    };

    expect(resolveContextPath("/environments/worker-a/artifacts/report.txt", {
      agentKey: "clawd",
    }, env)).toBe("/root/.panda/environments/clawd/worker-a/artifacts/report.txt");
    expect(resolveContextPath("/environments/worker-a/artifacts/report.txt", {
      agentKey: "luna",
    }, env)).toBe("/root/.panda/environments/luna/worker-a/artifacts/report.txt");
  });

  it("rejects symlink escapes from mapped worker roots", async () => {
    const root = await makeTempDir();
    const artifacts = path.join(root, "artifacts");
    const outside = path.join(root, "outside.txt");
    const escape = path.join(artifacts, "escape.txt");
    await writeFile(outside, "nope");
    await mkdir(artifacts, {recursive: true});
    await symlink(outside, escape);

    const context = createDisposableContext(root, artifacts);
    const promise = resolveReadableContextPath("/artifacts/escape.txt", context);
    await expect(promise).rejects.toBeInstanceOf(ToolError);
    await expect(resolveReadableContextPath("/artifacts/escape.txt", context))
      .rejects.toThrow("escapes the execution environment root");
  });

  it("rejects symlink escapes from sync mapped worker paths", async () => {
    const root = await makeTempDir();
    const artifacts = path.join(root, "artifacts");
    const outside = path.join(root, "outside.txt");
    const escape = path.join(artifacts, "escape.txt");
    await writeFile(outside, "nope");
    await mkdir(artifacts, {recursive: true});
    await symlink(outside, escape);

    expect(() => resolveContextPath("/artifacts/escape.txt", createDisposableContext(root, artifacts)))
      .toThrow(ToolError);
    expect(() => resolveContextPath("/artifacts/escape.txt", createDisposableContext(root, artifacts)))
      .toThrow("escapes the execution environment root");
  });

  it("rejects disposable worker paths outside the shared roots", () => {
    const resolve = () => resolveContextPath("/etc/passwd", {
      agentKey: "clawd",
      executionEnvironment: {
        id: "env-worker",
        agentKey: "clawd",
        kind: "disposable_container",
        source: "binding",
        metadata: {
          filesystem: {
            envDir: "worker-a",
            root: {
              corePath: "/root/.panda/environments/clawd/worker-a",
              parentRunnerPath: "/environments/worker-a",
            },
            workspace: {
              corePath: "/root/.panda/environments/clawd/worker-a/workspace",
              workerPath: "/workspace",
              parentRunnerPath: "/environments/worker-a/workspace",
            },
            inbox: {
              corePath: "/root/.panda/environments/clawd/worker-a/inbox",
              workerPath: "/inbox",
              parentRunnerPath: "/environments/worker-a/inbox",
            },
            artifacts: {
              corePath: "/root/.panda/environments/clawd/worker-a/artifacts",
              workerPath: "/artifacts",
              parentRunnerPath: "/environments/worker-a/artifacts",
            },
          },
        },
      },
    });
    expect(resolve).toThrow(ToolError);
    expect(resolve).toThrow("outside this execution environment");
  });
});
