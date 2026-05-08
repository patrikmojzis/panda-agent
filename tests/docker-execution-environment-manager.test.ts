import {mkdtemp, rm, stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import type {
    DisposableEnvironmentCreateRequest,
    DisposableEnvironmentCreateResult,
    ExecutionEnvironmentManager,
} from "../src/domain/execution-environments/index.js";
import {
    DockerApiError,
    DockerExecutionEnvironmentManager,
    HttpExecutionEnvironmentManagerClient,
    startExecutionEnvironmentManager,
} from "../src/integrations/shell/index.js";
import type {
    DockerClient,
    DockerContainerCreateConfig,
} from "../src/integrations/shell/docker-execution-environment-manager.js";

class FakeDockerClient implements DockerClient {
  readonly created: Array<{name: string; config: DockerContainerCreateConfig}> = [];
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly removed: string[] = [];
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
  }

  async removeContainer(container: string): Promise<void> {
    this.removed.push(container);
    if (this.removeError) {
      throw this.removeError;
    }
  }
}

class FakeManager implements ExecutionEnvironmentManager {
  readonly created: DisposableEnvironmentCreateRequest[] = [];

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
}

describe("DockerExecutionEnvironmentManager", () => {
  const directories: string[] = [];

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
    const manager = new DockerExecutionEnvironmentManager({
      dockerClient,
      image: "panda-runner:test",
      hostEnvironmentsRoot: environmentsRoot,
      managerEnvironmentsRoot: environmentsRoot,
      coreEnvironmentsRoot: "/core/environments",
      parentRunnerEnvironmentsRoot: "/environments",
      createTimeoutMs: 10,
    });

    const result = await manager.createDisposableEnvironment({
      agentKey: "panda",
      sessionId: "session-worker",
      environmentId: "env-worker",
    });

    expect(result).toMatchObject({
      runnerUrl: "http://127.0.0.1:32780",
      runnerCwd: "/workspace",
      rootPath: "/workspace",
    });
    const filesystem = (result.metadata as any).filesystem;
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
    await expect(stat(filesystem.workspace.hostPath)).resolves.toBeTruthy();
    await expect(stat(filesystem.inbox.hostPath)).resolves.toBeTruthy();
    await expect(stat(filesystem.artifacts.hostPath)).resolves.toBeTruthy();
    expect(dockerClient.created).toHaveLength(1);
    const created = dockerClient.created[0]!;
    expect(created.config.Image).toBe("panda-runner:test");
    expect(created.config.Cmd).toEqual(["runner"]);
    expect(created.config.WorkingDir).toBe("/workspace");
    expect(created.config.Env).toContain("RUNNER_AGENT_KEY=panda");
    expect(created.config.HostConfig.AutoRemove).toBe(true);
    expect(created.config.HostConfig.PortBindings).toEqual({
      "8080/tcp": [
        {
          HostIp: "127.0.0.1",
          HostPort: "",
        },
      ],
    });
    expect(created.config.HostConfig.Binds).toEqual([
      `${filesystem.workspace.hostPath}:/workspace`,
      `${filesystem.inbox.hostPath}:/inbox`,
      `${filesystem.artifacts.hostPath}:/artifacts`,
    ]);
    expect(JSON.stringify(created.config)).not.toContain("/root/.panda");
    expect(JSON.stringify(created.config)).not.toContain("Mounts");
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

    const created = dockerClient.created[0]!;
    expect(created.config.HostConfig.NetworkMode).toBe("panda_runner_net");
    expect(created.config.HostConfig.PortBindings).toBeUndefined();
    expect(result.runnerUrl).toMatch(/^http:\/\/panda-env-env-worker-[a-f0-9]{10}:8080$/);
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
    expect(host).toBe(dockerClient.created[0]!.name);
    expect((result.metadata as any).containerName).toBe(host);
    expect(dockerClient.created[0]!.config.Labels["panda.environment.id"]).toBe(environmentId);
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

    await expect(manager.stopEnvironment("env-worker")).resolves.toBeUndefined();
    expect(dockerClient.stopped[0]).toMatch(/^panda-env-env-worker-[a-f0-9]{10}$/);
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

    expect(dockerClient.stopped[0]).toMatch(/^panda-env-env-worker-[a-f0-9]{10}$/);
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

  it("requires a token when the manager binds outside loopback", async () => {
    await expect(startExecutionEnvironmentManager({
      host: "192.0.2.10",
      port: 0,
      manager: new FakeManager(),
    })).rejects.toThrow("binds outside loopback");
  });
});
