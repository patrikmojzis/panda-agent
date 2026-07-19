import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {PassThrough, Readable} from "node:stream";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import type {
    DisposableEnvironmentCreateRequest,
    DisposableEnvironmentCreateResult,
    DisposableEnvironmentCommandAccessRefreshRequest,
    ExecutionEnvironmentManager,
} from "../src/domain/execution-environments/types.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../src/domain/execution-environments/filesystem.js";
import {isRecord} from "../src/lib/records.js";
import {
    createWorkspaceExecCredential,
    DockerApiError,
    DockerExecutionEnvironmentManager,
    HttpExecutionEnvironmentManagerClient,
    resolveDockerExecutionEnvironmentManagerOptions,
    startExecutionEnvironmentManager,
    validateWorkspaceExecCredential,
    demuxDockerStdCopyStream,
} from "../src/integrations/shell/index.js";
import type {
    DockerClient,
    DockerContainerCreateConfig,
} from "../src/integrations/shell/docker-execution-environment-manager.js";

function stdcopyFrame(streamId: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamId;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

class FakeDockerClient implements DockerClient {
  readonly created: Array<{name: string; config: DockerContainerCreateConfig}> = [];
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly removed: string[] = [];
  readonly execs: Array<{container: string; config: import("../src/integrations/shell/docker-execution-environment-manager.js").DockerExecCreateConfig}> = [];
  readonly logReads: Array<{container: string; tail: number}> = [];
  execExitCode = 0;
  execInspectResults: Array<{ID?: string; Running?: boolean; ExitCode?: number | null}> = [];
  execStreamChunks: Buffer[] = [stdcopyFrame(1, "workspace-out")];
  logStreamChunks: Buffer[] = [stdcopyFrame(1, "runner-out"), stdcopyFrame(2, "runner-err")];
  createError?: Error;
  startError?: Error;
  inspectLabels?: Record<string, string>;
  inspectState?: {
    Running?: boolean;
    Status?: string;
    Health?: {
      Status?: string;
    };
  };
  stopErrors = new Map<string, Error>();
  removeErrors = new Map<string, Error>();
  removeError?: Error;

  async createContainer(name: string, config: DockerContainerCreateConfig): Promise<{Id: string}> {
    if (this.createError) {
      throw this.createError;
    }
    this.created.push({name, config});
    return {Id: `container-${name}`};
  }

  async startContainer(container: string): Promise<void> {
    this.started.push(container);
    if (this.startError) {
      throw this.startError;
    }
  }

  async inspectContainer(container: string) {
    const created = this.created.find((entry) => `container-${entry.name}` === container || entry.name === container);
    const labels = this.inspectLabels ?? created?.config.Labels ?? {};
    const runnerPort = Number(Object.keys(created?.config.ExposedPorts ?? {"8080/tcp": {}})[0]?.split("/")[0] ?? 8080);
    return {
      Id: `container-${created?.name ?? container}`,
      Config: {Labels: labels},
      State: this.inspectState ?? {
        Running: true,
        Health: {
          Status: "healthy",
        },
      },
      NetworkSettings: {
        Ports: {
          [`${runnerPort}/tcp`]: [
            {
              HostIp: "127.0.0.1",
              HostPort: "32780",
            },
          ],
        },
      },
    };
  }

  async stopContainer(container: string): Promise<void> {
    this.stopped.push(container);
    const error = this.stopErrors.get(container);
    if (error) {
      throw error;
    }
  }

  async removeContainer(container: string): Promise<void> {
    this.removed.push(container);
    const error = this.removeErrors.get(container);
    if (error) {
      throw error;
    }
    if (this.removeError) {
      throw this.removeError;
    }
  }

  async logsContainer(container: string, options: {tail: number}): Promise<{stdout: string; stderr: string}> {
    this.logReads.push({container, tail: options.tail});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    await demuxDockerStdCopyStream(
      Readable.from(this.logStreamChunks),
      (chunk) => stdout.push(chunk),
      (chunk) => stderr.push(chunk),
    );
    return {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  }

  async createExec(container: string, config: import("../src/integrations/shell/docker-execution-environment-manager.js").DockerExecCreateConfig): Promise<{Id: string}> {
    this.execs.push({container, config});
    return {Id: `exec-${this.execs.length}`};
  }

  async startExec(): Promise<Readable> {
    return Readable.from(this.execStreamChunks);
  }

  async inspectExec(): Promise<{ID?: string; Running?: boolean; ExitCode?: number | null}> {
    return this.execInspectResults.shift() ?? {ID: "exec", Running: false, ExitCode: this.execExitCode};
  }
}

class FakeManager implements ExecutionEnvironmentManager {
  readonly created: DisposableEnvironmentCreateRequest[] = [];
  readonly commandAccessRefreshes: DisposableEnvironmentCommandAccessRefreshRequest[] = [];
  readonly logReads: Array<{environmentId: string; role?: "control" | "workspace" | "all"; tail?: number}> = [];

  async createDisposableEnvironment(
    input: DisposableEnvironmentCreateRequest,
  ): Promise<DisposableEnvironmentCreateResult> {
    this.created.push(input);
    return {
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
      metadata: {
        containerName: "panda-env-worker",
      },
    };
  }

  async stopEnvironment(): Promise<void> {}

  async refreshCommandAccess(input: DisposableEnvironmentCommandAccessRefreshRequest): Promise<void> {
    this.commandAccessRefreshes.push(input);
  }

  async readEnvironmentLogs(input: {
    environmentId: string;
    role?: "control" | "workspace" | "all";
    tail?: number;
  }) {
    this.logReads.push(input);
    return {
      entries: [
        {
          role: "workspace" as const,
          stdout: "workspace out",
          stderr: "workspace err",
        },
      ],
    };
  }

  validateWorkspaceExecCredential(environmentId: string, credential: string): boolean {
    return validateWorkspaceExecCredential({environmentId, credential, secret: "workspace-secret"});
  }
}

class BadMetadataManager implements ExecutionEnvironmentManager {
  async createDisposableEnvironment(): Promise<DisposableEnvironmentCreateResult> {
    return {
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
      metadata: Number.NaN,
    };
  }

  async stopEnvironment(): Promise<void> {}
}

function requireFilesystemMetadata(metadata: DisposableEnvironmentCreateResult["metadata"]) {
  const filesystem = readExecutionEnvironmentFilesystemMetadata(metadata);
  if (!filesystem) {
    throw new Error("Expected execution environment result metadata to include filesystem paths.");
  }

  return filesystem;
}

function requireContainerName(metadata: DisposableEnvironmentCreateResult["metadata"]): string {
  if (!isRecord(metadata) || typeof metadata.containerName !== "string") {
    throw new Error("Expected execution environment result metadata to include a container name.");
  }

  return metadata.containerName;
}

function findCreatedContainer(
  dockerClient: FakeDockerClient,
  role: "control" | "workspace",
): {name: string; config: DockerContainerCreateConfig} {
  const created = dockerClient.created.find((entry) => entry.config.Labels["panda.environment.role"] === role);
  if (!created) {
    throw new Error(`Expected created ${role} container.`);
  }
  return created;
}

describe("DockerExecutionEnvironmentManager", () => {
  const directories: string[] = [];

  it("rejects deprecated RUNNER_SHARED_SECRET when resolving manager options", () => {
    expect(() => resolveDockerExecutionEnvironmentManagerOptions({
      RUNNER_SHARED_SECRET: "old-secret",
      BASH_SERVER_SHARED_SECRET: "new-secret",
    })).toThrow("RUNNER_SHARED_SECRET was renamed to BASH_SERVER_SHARED_SECRET");
  });

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop() ?? "", {recursive: true, force: true});
    }
  });

  async function makeEnvironmentRoot(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-env-root-"));
    directories.push(directory);
    return directory;
  }

  it("creates disposable runners without mounting the agent home", async () => {
    const dockerClient = new FakeDockerClient();
    const environmentsRoot = await makeEnvironmentRoot();
    const commandSocketHostDir = await makeEnvironmentRoot();
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      controlRunnerImage: "panda-runner:test",
      workspaceImage: "panda-workspace:test",
      workspaceExecSecret: "workspace-secret",
      managerUrl: "http://panda-environment-manager:8095",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      coreEnvironmentsRoot: "/core/environments",
      parentRunnerEnvironmentsRoot: "/environments",
      commandSocketHostDir,
      runnerSharedSecret: "runner-secret",
      createTimeoutMs: 10,
    });

    const commandSocketPath = "/run/panda-command/command.sock";
    const workerCommandSocketPath = "/run/panda-command/command.sock";
    const result = await manager.createDisposableEnvironment({
      agentKey: "panda",
      sessionId: "session-worker",
      environmentId: "env-worker",
      commandAccess: {
        url: "http://panda-core:8096",
        socketPath: commandSocketPath,
        token: "command-token",
      },
    });

    expect(result).toMatchObject({
      runnerUrl: "http://127.0.0.1:32780",
      runnerCwd: "/workspace",
      rootPath: "/workspace",
    });
    const filesystem = requireFilesystemMetadata(result.metadata);
    expect(filesystem).toMatchObject({
      envDir: expect.stringMatching(/^env-worker-[a-f0-9]{10}$/),
      root: {
        hostPath: expect.stringMatching(new RegExp(`^${environmentsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/panda/env-worker-[a-f0-9]{10}$`)),
        corePath: expect.stringMatching(/^\/core\/environments\/panda\/env-worker-[a-f0-9]{10}$/),
        parentRunnerPath: expect.stringMatching(/^\/environments\/env-worker-[a-f0-9]{10}$/),
      },
      workspace: {
        workerPath: "/workspace",
      },
      inbox: {
        workerPath: "/inbox",
      },
      artifacts: {
        workerPath: "/artifacts",
      },
    });
    for (const hostPath of [
      filesystem.workspace.hostPath,
      filesystem.inbox.hostPath,
      filesystem.artifacts.hostPath,
    ]) {
      expect((await stat(hostPath)).isDirectory()).toBe(true);
    }
    expect(dockerClient.created).toHaveLength(2);
    const created = findCreatedContainer(dockerClient, "control");
    const workspace = findCreatedContainer(dockerClient, "workspace");
    expect(created.config.Image).toBe("panda-runner:test");
    expect(workspace.config.Image).toBe("panda-workspace:test");
    expect(workspace.config.Cmd).toEqual(["sleep", "infinity"]);
    expect(workspace.config.ExposedPorts).toBeUndefined();
    expect(workspace.config.Healthcheck).toBeUndefined();
    expect(workspace.config.WorkingDir).toBe("/workspace");
    expect(workspace.config.Labels["panda.environment.role"]).toBe("workspace");
    expect(workspace.config.Env).toEqual(expect.arrayContaining([
      "PANDA_COMMAND_ACCESS_FILE=/workspace/.panda/command-access.env",
      "PANDA_COMMAND_URL=http://panda-core:8096",
      `PANDA_COMMAND_SOCKET=${workerCommandSocketPath}`,
      "PANDA_COMMAND_TOKEN=command-token",
    ]));
    await expect(readFile(path.join(filesystem.workspace.hostPath, ".panda", "command-access.env"), "utf8")).resolves.toBe(
      `PANDA_COMMAND_URL=http://panda-core:8096\nPANDA_COMMAND_SOCKET=${workerCommandSocketPath}\nPANDA_COMMAND_TOKEN=command-token\n`,
    );
    await manager.refreshCommandAccess({
      environmentId: "env-worker",
      commandAccess: {
        url: "http://panda-core:8096",
        socketPath: commandSocketPath,
        token: "fresh-command-token",
      },
    });
    await expect(readFile(path.join(filesystem.workspace.hostPath, ".panda", "command-access.env"), "utf8")).resolves.toBe(
      `PANDA_COMMAND_URL=http://panda-core:8096\nPANDA_COMMAND_SOCKET=${workerCommandSocketPath}\nPANDA_COMMAND_TOKEN=fresh-command-token\n`,
    );
    await manager.refreshCommandAccess({
      environmentId: "env-worker",
      commandAccess: {
        url: "http://panda-core:8097",
        token: "url-only-token",
      },
    });
    await expect(readFile(path.join(filesystem.workspace.hostPath, ".panda", "command-access.env"), "utf8")).resolves.toBe(
      "PANDA_COMMAND_URL=http://panda-core:8097\nPANDA_COMMAND_TOKEN=url-only-token\n",
    );
    await expect(manager.readEnvironmentLogs({
      environmentId: "env-worker",
      role: "all",
      tail: 50,
    })).resolves.toEqual({
      entries: [
        {
          role: "control",
          stdout: "runner-out",
          stderr: "runner-err",
        },
        {
          role: "workspace",
          stdout: "runner-out",
          stderr: "runner-err",
        },
      ],
    });
    expect(dockerClient.logReads).toEqual([
      {
        container: created.name,
        tail: 50,
      },
      {
        container: workspace.name,
        tail: 50,
      },
    ]);
    expect(created.config.Cmd).toEqual(["bash-server"]);
    expect(created.config.WorkingDir).toBe("/workspace");
    expect(created.config.Labels["panda.environment.role"]).toBe("control");
    expect(created.config.Env).toEqual(expect.arrayContaining([
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "SHELL=/bin/bash",
      "HOME=/root",
      "TMPDIR=/tmp",
      "LANG=C.UTF-8",
      "BASH_SERVER_AGENT_KEY=panda",
      "BASH_SERVER_PORT=8080",
      "BASH_SERVER_ALLOWED_ROOTS=/workspace",
      "BASH_SERVER_SHARED_SECRET=runner-secret",
      "PANDA_WORKSPACE_EXEC_MANAGER_URL=http://panda-environment-manager:8095",
      "PANDA_WORKSPACE_EXEC_ENVIRONMENT_ID=env-worker",
      `PANDA_WORKSPACE_CONTAINER_NAME=${workspace.name}`,
    ]));
    expect(created.config.Env).not.toContain("PANDA_COMMAND_TOKEN=command-token");
    const tokenEnv = created.config.Env.find((value) => value.startsWith("PANDA_WORKSPACE_EXEC_TOKEN="));
    expect(tokenEnv).toBeDefined();
    expect(validateWorkspaceExecCredential({
      environmentId: "env-worker",
      credential: tokenEnv!.slice("PANDA_WORKSPACE_EXEC_TOKEN=".length),
      secret: "workspace-secret",
    })).toBe(true);
    expect(created.config.HostConfig.AutoRemove).toBe(true);
    expect(created.config.HostConfig.PortBindings).toEqual({
      "8080/tcp": [
        {
          HostIp: "127.0.0.1",
          HostPort: "",
        },
      ],
    });
    const expectedControlBinds = [
      `${filesystem.workspace.hostPath}:/workspace`,
      `${filesystem.inbox.hostPath}:/inbox`,
      `${filesystem.artifacts.hostPath}:/artifacts`,
    ];
    const expectedWorkspaceBinds = [
      ...expectedControlBinds,
      `${commandSocketHostDir}:/run/panda-command:ro`,
    ];
    expect(created.config.HostConfig.Binds).toEqual(expectedControlBinds);
    expect(workspace.config.HostConfig.Binds).toEqual(expectedWorkspaceBinds);
    expect(workspace.config.HostConfig.Binds).not.toContain("/run/panda-command:/run/panda-command");
    expect(dockerClient.started).toEqual([`container-${workspace.name}`, `container-${created.name}`]);
    expect(JSON.stringify(created.config)).not.toContain("/root/.panda");
    expect(JSON.stringify(created.config)).not.toContain("Mounts");
  });

  it("rejects socket command access without a configured host socket directory", async () => {
    const dockerClient = new FakeDockerClient();
    const environmentsRoot = await makeEnvironmentRoot();
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      controlRunnerImage: "panda-runner:test",
      workspaceImage: "panda-workspace:test",
      workspaceExecSecret: "workspace-secret",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      coreEnvironmentsRoot: "/core/environments",
      parentRunnerEnvironmentsRoot: "/environments",
      createTimeoutMs: 10,
    });

    await expect(manager.createDisposableEnvironment({
      agentKey: "panda",
      sessionId: "session-worker",
      environmentId: "env-worker",
      commandAccess: {
        socketPath: "/run/panda-command/command.sock",
        token: "command-token",
      },
    })).rejects.toThrow("PANDA_COMMAND_SOCKET_HOST_DIR is required when command access uses a Unix socket.");
  });

  it("returns container-network URLs when a Docker network is configured", async () => {
    const dockerClient = new FakeDockerClient();
    const environmentsRoot = await makeEnvironmentRoot();
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      network: "panda_runner_net",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      createTimeoutMs: 10,
    });

    const result = await manager.createDisposableEnvironment({
      agentKey: "panda",
      sessionId: "session-worker",
      environmentId: "env-worker",
    });

    const created = findCreatedContainer(dockerClient, "control");
    const workspace = findCreatedContainer(dockerClient, "workspace");
    expect(created.config.HostConfig.NetworkMode).toBe("panda_runner_net");
    expect(workspace.config.HostConfig.NetworkMode).toBe("panda_runner_net");
    expect(created.config.HostConfig.PortBindings).toBeUndefined();
    expect(workspace.config.HostConfig.PortBindings).toBeUndefined();
    expect(result.runnerUrl).toMatch(/^http:\/\/panda-env-env-worker-control-[a-f0-9]{10}:8080$/);
  });

  it("keeps container-network runner hostnames within Docker DNS label limits", async () => {
    const dockerClient = new FakeDockerClient();
    const environmentsRoot = await makeEnvironmentRoot();
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      network: "panda_runner_net",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      createTimeoutMs: 10,
    });
    const environmentId = "worker:38fd8ac4-06e8-4219-bebc-c98b73944bf6";

    const result = await manager.createDisposableEnvironment({
      agentKey: "panda",
      sessionId: "38fd8ac4-06e8-4219-bebc-c98b73944bf6",
      environmentId,
    });

    const host = new URL(result.runnerUrl).hostname;
    expect(host.length).toBeLessThanOrEqual(63);
    expect(host).toMatch(/^[a-z0-9-]+$/);
    const created = findCreatedContainer(dockerClient, "control");
    expect(host).toBe(created.name);
    expect(requireContainerName(result.metadata)).toBe(host);
    expect(created.config.Labels["panda.environment.id"]).toBe(environmentId);
    expect(findCreatedContainer(dockerClient, "workspace").name.length).toBeLessThanOrEqual(63);
  });

  it("treats Docker AutoRemove in-progress cleanup as stopped", async () => {
    const dockerClient = new FakeDockerClient();
    dockerClient.inspectLabels = {
      "panda.managed": "true",
      "panda.environment.id": "env-worker",
      "panda.agent.key": "panda",
      "panda.session.id": "session-worker",
    };
    dockerClient.removeError = new DockerApiError(
      "removal of container panda-env-env-worker is already in progress",
      409,
    );
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      createTimeoutMs: 10,
    });

    await manager.stopEnvironment("env-worker");
    expect(dockerClient.stopped).toHaveLength(2);
    expect(dockerClient.stopped[0]).toMatch(/^panda-env-env-worker-control-[a-f0-9]{10}$/);
    expect(dockerClient.stopped[1]).toMatch(/^panda-env-env-worker-workspace-[a-f0-9]{10}$/);
    expect(dockerClient.removed).toEqual(dockerClient.stopped);
  });

  it("attempts workspace cleanup when control container cleanup fails", async () => {
    const dockerClient = new FakeDockerClient();
    dockerClient.inspectLabels = {
      "panda.managed": "true",
      "panda.environment.id": "env-worker",
      "panda.agent.key": "panda",
      "panda.session.id": "session-worker",
    };
    dockerClient.removeErrors.set(
      "panda-env-env-worker-control-55e1bc5d35",
      new Error("control remove failed"),
    );
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      createTimeoutMs: 10,
    });

    await expect(manager.stopEnvironment("env-worker")).rejects.toThrow("control remove failed");
    expect(dockerClient.stopped).toEqual([
      "panda-env-env-worker-control-55e1bc5d35",
      "panda-env-env-worker-workspace-55e1bc5d35",
    ]);
    expect(dockerClient.removed).toEqual(dockerClient.stopped);
  });

  it("rejects existing disposable container name collisions across agents", async () => {
    const dockerClient = new FakeDockerClient();
    dockerClient.createError = new DockerApiError("Conflict. The container name is already in use.", 409);
    dockerClient.inspectLabels = {
      "panda.managed": "true",
      "panda.environment.id": "env-worker",
      "panda.agent.key": "luna",
      "panda.session.id": "session-worker",
    };
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      createTimeoutMs: 10,
    });

    await expect(manager.createDisposableEnvironment({
      agentKey: "panda",
      sessionId: "session-worker",
      environmentId: "env-worker",
    })).rejects.toThrow("Conflict");
  });

  it("refuses to stop containers without matching Panda environment labels", async () => {
    const dockerClient = new FakeDockerClient();
    dockerClient.inspectLabels = {
      "panda.managed": "true",
      "panda.environment.id": "other-env",
      "panda.agent.key": "panda",
      "panda.session.id": "session-worker",
    };
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      createTimeoutMs: 10,
    });

    await expect(manager.stopEnvironment("env-worker")).rejects.toThrow("Refusing to stop");
    expect(dockerClient.stopped).toEqual([]);
    expect(dockerClient.removed).toEqual([]);
  });

  it("cleans up a disposable runner when health polling fails", async () => {
    const dockerClient = new FakeDockerClient();
    const environmentsRoot = await makeEnvironmentRoot();
    dockerClient.inspectState = {
      Running: true,
      Health: {
        Status: "unhealthy",
      },
    };
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      createTimeoutMs: 10,
    });

    await expect(manager.createDisposableEnvironment({
      agentKey: "panda",
      sessionId: "session-worker",
      environmentId: "env-worker",
    })).rejects.toThrow("Disposable environment container");

    expect(dockerClient.stopped).toHaveLength(2);
    expect(dockerClient.stopped[0]).toMatch(/^panda-env-env-worker-control-[a-f0-9]{10}$/);
    expect(dockerClient.stopped[1]).toMatch(/^panda-env-env-worker-workspace-[a-f0-9]{10}$/);
    expect(dockerClient.removed).toEqual(dockerClient.stopped);
  });
});

describe("execution environment manager HTTP boundary", () => {
  it("lets panda-core create disposable environments through the manager client", async () => {
    const fakeManager = new FakeManager();
    const server = await startExecutionEnvironmentManager({
      host: "127.0.0.1",
      port: 0,
      sharedSecret: "secret",
      manager: fakeManager,
    });
    try {
      const client = new HttpExecutionEnvironmentManagerClient({
        managerUrl: `http://127.0.0.1:${server.port}`,
        sharedSecret: "secret",
      });

      await expect(client.createDisposableEnvironment({
        agentKey: "panda",
        sessionId: "session-worker",
        environmentId: "env-worker",
      })).resolves.toMatchObject({
        runnerUrl: "http://worker:8080",
        runnerCwd: "/workspace",
      });
      expect(fakeManager.created).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("lets panda-core refresh command access through the manager client", async () => {
    const fakeManager = new FakeManager();
    const server = await startExecutionEnvironmentManager({
      host: "127.0.0.1",
      port: 0,
      sharedSecret: "secret",
      manager: fakeManager,
    });
    try {
      const client = new HttpExecutionEnvironmentManagerClient({
        managerUrl: `http://127.0.0.1:${server.port}`,
        sharedSecret: "secret",
      });

      await expect(client.refreshCommandAccess({
        environmentId: "env-worker",
        commandAccess: {
          url: "http://panda-core:8096",
          token: "fresh-command-token",
        },
      })).resolves.toBeUndefined();

      expect(fakeManager.commandAccessRefreshes).toEqual([{
        environmentId: "env-worker",
        commandAccess: {
          url: "http://panda-core:8096",
          token: "fresh-command-token",
        },
      }]);
    } finally {
      await server.close();
    }
  });

  it("lets panda-core read disposable environment logs through the manager client", async () => {
    const fakeManager = new FakeManager();
    const server = await startExecutionEnvironmentManager({
      host: "127.0.0.1",
      port: 0,
      sharedSecret: "secret",
      manager: fakeManager,
    });
    try {
      const client = new HttpExecutionEnvironmentManagerClient({
        managerUrl: `http://127.0.0.1:${server.port}`,
        sharedSecret: "secret",
      });

      await expect(client.readEnvironmentLogs({
        environmentId: "env-worker",
        role: "workspace",
        tail: 25,
      })).resolves.toEqual({
        entries: [
          {
            role: "workspace",
            stdout: "workspace out",
            stderr: "workspace err",
          },
        ],
      });

      expect(fakeManager.logReads).toEqual([{
        environmentId: "env-worker",
        role: "workspace",
        tail: 25,
      }]);
    } finally {
      await server.close();
    }
  });

  it("rejects non-json manager request and response metadata", async () => {
    const client = new HttpExecutionEnvironmentManagerClient({
      managerUrl: "http://manager.local",
      fetchImpl: async () => {
        throw new Error("fetch should not run");
      },
    });

    await expect(client.createDisposableEnvironment({
      agentKey: "panda",
      sessionId: "session-worker",
      environmentId: "env-worker",
      metadata: Number.NaN,
    })).rejects.toThrow("Execution environment manager request metadata must be JSON-serializable.");

    const responseClient = new HttpExecutionEnvironmentManagerClient({
      managerUrl: "http://manager.local",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          runnerUrl: "http://worker:8080",
          runnerCwd: "/workspace",
          metadata: Number.NaN,
        }),
      } as Response),
    });

    await expect(responseClient.createDisposableEnvironment({
      agentKey: "panda",
      sessionId: "session-worker",
      environmentId: "env-worker",
    })).rejects.toThrow("Execution environment manager response metadata must be JSON-serializable.");
  });

  it("rejects non-json metadata returned by the manager server adapter", async () => {
    const server = await startExecutionEnvironmentManager({
      host: "127.0.0.1",
      port: 0,
      sharedSecret: "secret",
      manager: new BadMetadataManager(),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/environments/disposable`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentKey: "panda",
          sessionId: "session-worker",
          environmentId: "env-worker",
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: "Execution environment manager metadata must be JSON-serializable.",
      });
    } finally {
      await server.close();
    }
  });


  it("does not allow workspace exec credentials to call lifecycle endpoints or cross exec environments", async () => {
    const fakeManager = new FakeManager();
    const server = await startExecutionEnvironmentManager({
      host: "127.0.0.1",
      port: 0,
      sharedSecret: "lifecycle-secret",
      manager: fakeManager,
    });
    const execToken = createWorkspaceExecCredential({environmentId: "env-a", secret: "workspace-secret"});
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const createResponse = await fetch(`${baseUrl}/environments/disposable`, {
        method: "POST",
        headers: {authorization: `Bearer ${execToken}`, "content-type": "application/json"},
        body: JSON.stringify({agentKey: "panda", sessionId: "session-worker", environmentId: "env-a"}),
      });
      expect(createResponse.status).toBe(403);

      const stopResponse = await fetch(`${baseUrl}/environments/stop`, {
        method: "POST",
        headers: {authorization: `Bearer ${execToken}`, "content-type": "application/json"},
        body: JSON.stringify({environmentId: "env-a"}),
      });
      expect(stopResponse.status).toBe(403);

      const crossExecResponse = await fetch(`${baseUrl}/workspaces/exec`, {
        method: "POST",
        headers: {authorization: `Bearer ${execToken}`, "content-type": "application/json"},
        body: JSON.stringify({environmentId: "env-b", request: {command: "pwd"}}),
      });
      expect(crossExecResponse.status).toBe(403);

      const sameEnvResponse = await fetch(`${baseUrl}/workspaces/exec`, {
        method: "POST",
        headers: {authorization: `Bearer ${execToken}`, "content-type": "application/json"},
        body: JSON.stringify({action: "start", environmentId: "env-a", request: {mode: "foreground", command: "pwd", cwd: "/workspace", timeoutMs: 1000, trackedEnvKeys: [], maxOutputChars: 1000}}),
      });
      expect(sameEnvResponse.status).toBe(501);

    } finally {
      await server.close();
    }
  });


  it("demuxes Docker stdcopy frames split across chunks", async () => {
    const frame = Buffer.concat([stdcopyFrame(1, "out"), stdcopyFrame(2, "err")]);
    const chunks = [frame.subarray(0, 3), frame.subarray(3, 10), frame.subarray(10, 15), frame.subarray(15)];
    const stdout: string[] = [];
    const stderr: string[] = [];

    await demuxDockerStdCopyStream(Readable.from(chunks),
      (chunk) => stdout.push(chunk.toString("utf8")),
      (chunk) => stderr.push(chunk.toString("utf8")),
    );

    expect(stdout.join("")).toBe("out");
    expect(stderr.join("")).toBe("err");
  });

  it("executes same-env workspace action against the workspace container", async () => {
    const dockerClient = new FakeDockerClient();
    dockerClient.execStreamChunks = [stdcopyFrame(1, "out"), stdcopyFrame(2, "err")];
    const environmentsRoot = await mkdtemp(path.join(os.tmpdir(), "panda-env-root-"));
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      workspaceExecSecret: "workspace-secret",
      managerUrl: "http://manager:8095",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      coreEnvironmentsRoot: "/core/environments",
      parentRunnerEnvironmentsRoot: "/environments",
      createTimeoutMs: 10,
    });
    await manager.createDisposableEnvironment({agentKey: "panda", sessionId: "session-worker", environmentId: "env-a"});
    const server = await startExecutionEnvironmentManager({host: "127.0.0.1", port: 0, sharedSecret: "lifecycle-secret", manager});
    const execToken = createWorkspaceExecCredential({environmentId: "env-a", secret: "workspace-secret"});
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/workspaces/exec`, {
        method: "POST",
        headers: {authorization: `Bearer ${execToken}`, "content-type": "application/json"},
        body: JSON.stringify({action: "start", environmentId: "env-a", request: {mode: "foreground", processId: "proc-1", command: "pwd", cwd: "/workspace", timeoutMs: 1000, trackedEnvKeys: [], maxOutputChars: 1000}}),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ok: true, process: {status: "completed", stdout: "out", stderr: "err", exitCode: 0, stdoutPersisted: false, stderrPersisted: false}});
      const workspace = findCreatedContainer(dockerClient, "workspace");
      expect(dockerClient.execs[0]?.container).toBe(workspace.name);
      expect(dockerClient.execs[0]?.config.Tty).toBe(false);
      expect(dockerClient.execs[0]?.config.Cmd.join(" ")).toContain("setsid bash");
      expect(dockerClient.execs[0]?.config.Cmd.join(" ")).not.toContain("&;");

      const legacyBackgroundTimeout = await fetch(`http://127.0.0.1:${server.port}/workspaces/exec`, {
        method: "POST",
        headers: {authorization: `Bearer ${execToken}`, "content-type": "application/json"},
        body: JSON.stringify({action: "start", environmentId: "env-a", request: {mode: "background", command: "sleep 1", cwd: "/workspace", timeoutMs: 1000, trackedEnvKeys: [], maxOutputChars: 1000}}),
      });
      expect(legacyBackgroundTimeout.status).toBe(400);
      await expect(legacyBackgroundTimeout.json()).resolves.toMatchObject({
        error: "Workspace exec background mode does not accept timeoutMs. Use maxRuntimeMs.",
      });
    } finally {
      await server.close();
      await rm(environmentsRoot, {recursive: true, force: true});
    }
  });




  it("rejects workspace exec starts outside /workspace before creating a Docker exec", async () => {
    const dockerClient = new FakeDockerClient();
    const environmentsRoot = await mkdtemp(path.join(os.tmpdir(), "panda-env-root-"));
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      workspaceExecSecret: "workspace-secret",
      managerUrl: "http://manager:8095",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      coreEnvironmentsRoot: "/core/environments",
      parentRunnerEnvironmentsRoot: "/environments",
      createTimeoutMs: 10,
    });
    try {
      await manager.createDisposableEnvironment({agentKey: "panda", sessionId: "session-worker", environmentId: "env-a"});

      await expect(manager.handleWorkspaceExecAction({
        action: "start",
        environmentId: "env-a",
        request: {mode: "foreground", processId: "proc-bad-cwd", command: "pwd", cwd: "/workspace/..", timeoutMs: 1000, trackedEnvKeys: [], maxOutputChars: 1000},
      })).rejects.toMatchObject({details: {statusCode: 400}});

      await expect(manager.handleWorkspaceExecAction({
        action: "start",
        environmentId: "env-a",
        request: {mode: "background", processId: "proc-tmp-cwd", command: "pwd", cwd: "/tmp", maxRuntimeMs: 1000, trackedEnvKeys: [], maxOutputChars: 1000},
      })).rejects.toMatchObject({details: {statusCode: 400}});

      expect(dockerClient.execs).toHaveLength(0);
    } finally {
      await rm(environmentsRoot, {recursive: true, force: true});
    }
  });

  it("normalizes accepted workspace exec cwd before passing it to Docker", async () => {
    const dockerClient = new FakeDockerClient();
    dockerClient.execStreamChunks = [stdcopyFrame(1, "out")];
    const environmentsRoot = await mkdtemp(path.join(os.tmpdir(), "panda-env-root-"));
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      workspaceExecSecret: "workspace-secret",
      managerUrl: "http://manager:8095",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      coreEnvironmentsRoot: "/core/environments",
      parentRunnerEnvironmentsRoot: "/environments",
      createTimeoutMs: 10,
    });
    try {
      await manager.createDisposableEnvironment({agentKey: "panda", sessionId: "session-worker", environmentId: "env-a"});

      await expect(manager.handleWorkspaceExecAction({
        action: "start",
        environmentId: "env-a",
        request: {mode: "foreground", processId: "proc-good-cwd", command: "pwd", cwd: "/workspace/child/..", timeoutMs: 1000, trackedEnvKeys: [], maxOutputChars: 1000},
      })).resolves.toMatchObject({status: "completed", initialCwd: "/workspace"});

      expect(dockerClient.execs.at(-1)?.config.WorkingDir).toBe("/workspace");
    } finally {
      await rm(environmentsRoot, {recursive: true, force: true});
    }
  });

  it("waits for Docker exec inspect to report terminal completion before finishing foreground workspace exec", async () => {
    const dockerClient = new FakeDockerClient();
    dockerClient.execStreamChunks = [stdcopyFrame(1, "out")];
    dockerClient.execInspectResults = [
      {ID: "exec", Running: true, ExitCode: null},
      {ID: "exec", Running: false, ExitCode: null},
      {ID: "exec", Running: false, ExitCode: 0},
    ];
    const environmentsRoot = await mkdtemp(path.join(os.tmpdir(), "panda-env-root-"));
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      workspaceExecSecret: "workspace-secret",
      managerUrl: "http://manager:8095",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      coreEnvironmentsRoot: "/core/environments",
      parentRunnerEnvironmentsRoot: "/environments",
      createTimeoutMs: 10,
    });
    try {
      await manager.createDisposableEnvironment({agentKey: "panda", sessionId: "session-worker", environmentId: "env-a"});

      const snapshot = await manager.handleWorkspaceExecAction({
        action: "start",
        environmentId: "env-a",
        request: {mode: "foreground", processId: "proc-race", command: "pwd", cwd: "/workspace", timeoutMs: 1000, trackedEnvKeys: [], maxOutputChars: 1000},
      });

      expect(snapshot).toMatchObject({status: "completed", exitCode: 0, stdout: "out"});
      expect(dockerClient.execInspectResults).toHaveLength(0);
    } finally {
      await rm(environmentsRoot, {recursive: true, force: true});
    }
  });

  it("fails new workspace starts instead of evicting live process records when the table is full", async () => {
    const manager = new DockerExecutionEnvironmentManager({dockerClient: new FakeDockerClient(), workspaceExecSecret: "workspace-secret"});
    const processTable = (manager as unknown as {
      workspaceProcesses: Map<string, {snapshot: {status: string}; startedAt: number}>;
    }).workspaceProcesses;
    for (let index = 0; index < 128; index += 1) {
      processTable.set(`env-a\0proc-${index}`, {snapshot: {status: "running"}, startedAt: Date.now()});
    }

    await expect(manager.handleWorkspaceExecAction({
      action: "start",
      environmentId: "env-a",
      request: {mode: "background", processId: "proc-new", command: "sleep 60", cwd: "/workspace", maxRuntimeMs: 1000, trackedEnvKeys: [], maxOutputChars: 1000},
    })).rejects.toThrow("Workspace process table is full");

    expect(processTable).toHaveLength(128);
    expect([...processTable.values()].every((record) => record.snapshot.status === "running")).toBe(true);
  });

  it("returns a cancelled workspace snapshot promptly even when the original process is still running", async () => {
    const dockerClient = new FakeDockerClient();
    dockerClient.execStreamChunks = [];
    dockerClient.startExec = async () => new PassThrough();
    const environmentsRoot = await mkdtemp(path.join(os.tmpdir(), "panda-env-root-"));
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      workspaceExecSecret: "workspace-secret",
      managerUrl: "http://manager:8095",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      coreEnvironmentsRoot: "/core/environments",
      parentRunnerEnvironmentsRoot: "/environments",
      createTimeoutMs: 10,
    });
    try {
      await manager.createDisposableEnvironment({agentKey: "panda", sessionId: "session-worker", environmentId: "env-a"});
      await manager.handleWorkspaceExecAction({
        action: "start",
        environmentId: "env-a",
        request: {mode: "background", processId: "proc-cancel", command: "sleep 60", cwd: "/workspace", maxRuntimeMs: 300000, trackedEnvKeys: [], maxOutputChars: 1000},
      });

      const started = Date.now();
      const cancelled = await manager.handleWorkspaceExecAction({action: "cancel", environmentId: "env-a", processId: "proc-cancel", timeoutMs: 0});

      expect(Date.now() - started).toBeLessThan(500);
      expect(cancelled).toMatchObject({status: "cancelled", aborted: true, abortReason: "Command aborted."});
    } finally {
      await rm(environmentsRoot, {recursive: true, force: true});
    }
  });

  it("marks disposable background maximum-runtime expiry as a failed timeout", async () => {
    const dockerClient = new FakeDockerClient();
    dockerClient.execStreamChunks = [];
    dockerClient.startExec = async () => new PassThrough();
    const environmentsRoot = await mkdtemp(path.join(os.tmpdir(), "panda-env-root-"));
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      workspaceExecSecret: "workspace-secret",
      managerUrl: "http://manager:8095",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      coreEnvironmentsRoot: "/core/environments",
      parentRunnerEnvironmentsRoot: "/environments",
      createTimeoutMs: 10,
    });
    try {
      await manager.createDisposableEnvironment({agentKey: "panda", sessionId: "session-worker", environmentId: "env-a"});
      const started = await manager.handleWorkspaceExecAction({
        action: "start",
        environmentId: "env-a",
        request: {mode: "background", processId: "proc-expiry", command: "sleep 60", cwd: "/workspace", maxRuntimeMs: 100, trackedEnvKeys: [], maxOutputChars: 1000},
      });
      expect(started).toMatchObject({
        status: "running",
        maxRuntimeMs: 100,
        expiresAt: started.startedAt + 100,
      });

      await vi.waitFor(async () => {
        await expect(manager.handleWorkspaceExecAction({
          action: "status",
          environmentId: "env-a",
          processId: "proc-expiry",
        })).resolves.toMatchObject({status: "failed", timedOut: true, aborted: false});
      });
    } finally {
      await rm(environmentsRoot, {recursive: true, force: true});
    }
  });

  it("requires a token when the manager binds outside loopback", async () => {
    await expect(startExecutionEnvironmentManager({
      host: "192.0.2.10",
      port: 0,
      manager: new FakeManager(),
    })).rejects.toThrow("binds outside loopback");
  });
});
