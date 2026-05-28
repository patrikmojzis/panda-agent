import {execFile as execFileCallback} from "node:child_process";
import {mkdtemp, rm, writeFile, access, readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {RemoteExecutionEnvironmentSetupRunner} from "../../src/app/runtime/execution-environment-setup-runner.js";
import {buildRunnerEndpoint, buildRunnerRequestHeaders} from "../../src/integrations/shell/bash-executor.js";
import type {BashExecutionResult, BashJobSnapshot} from "../../src/integrations/shell/bash-protocol.js";
import {
  DockerExecutionEnvironmentManager,
  startExecutionEnvironmentManager,
  type ExecutionEnvironmentManagerServer,
} from "../../src/integrations/shell/docker-execution-environment-manager.js";
import type {DisposableEnvironmentCreateResult} from "../../src/domain/execution-environments/types.js";

const execFile = promisify(execFileCallback);
const RUN_LIVE = process.env.PANDA_B2B_DOCKER_SMOKE === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;
const agentKey = "clawd";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type CreatedEnvironment = DisposableEnvironmentCreateResult & {environmentId: string};

interface Harness {
  suffix: string;
  runnerImage: string;
  workspaceImage: string;
  tempRoot: string;
  manager: DockerExecutionEnvironmentManager;
  server: ExecutionEnvironmentManagerServer;
  managerUrlForHost: string;
  managerUrlForContainers: string;
  lifecycleSecret: string;
  workspaceExecSecret: string;
  runnerSecret: string;
  environments: CreatedEnvironment[];
}

async function docker(args: string[], options: {cwd?: string; allowFailure?: boolean} = {}): Promise<{stdout: string; stderr: string}> {
  try {
    const result = await execFile("docker", args, {
      cwd: options.cwd ?? process.cwd(),
      maxBuffer: 25 * 1024 * 1024,
      timeout: 600_000,
    });
    return {stdout: result.stdout, stderr: result.stderr};
  } catch (error) {
    if (options.allowFailure && typeof error === "object" && error !== null && "stdout" in error && "stderr" in error) {
      return {stdout: String((error as {stdout?: unknown}).stdout ?? ""), stderr: String((error as {stderr?: unknown}).stderr ?? "")};
    }
    throw error;
  }
}

async function dockerOutput(args: string[]): Promise<string> {
  return (await docker(args)).stdout.trim();
}

async function dockerStatus(args: string[]): Promise<number> {
  try {
    await docker(args);
    return 0;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && typeof (error as {code?: unknown}).code === "number"
      ? (error as {code: number}).code
      : 1;
  }
}

async function dockerExec(container: string, script: string): Promise<string> {
  return dockerOutput(["exec", container, "bash", "-lc", script]);
}

async function dockerExecStatus(container: string, script: string): Promise<number> {
  return dockerStatus(["exec", container, "bash", "-lc", script]);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{status: number; body: any; text: string}> {
  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json", ...headers},
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return {status: response.status, body: parsed, text};
}

function runnerHeaders(env: Harness, runnerUrl: string): Record<string, string> {
  return buildRunnerRequestHeaders(agentKey, runnerUrl, runnerUrl, env.runnerSecret);
}

async function runnerPost<T>(env: Harness, runnerUrl: string, endpoint: string, body: unknown): Promise<T> {
  const url = buildRunnerEndpoint(runnerUrl, endpoint);
  const response = await postJson(url, body, runnerHeaders(env, runnerUrl));
  expect(response.status, `${endpoint} response: ${response.text}`).toBe(200);
  expect(response.body?.ok, `${endpoint} body: ${response.text}`).toBe(true);
  return response.body as T;
}

async function createEnvironment(env: Harness, environmentId: string): Promise<CreatedEnvironment> {
  const created = await env.manager.createDisposableEnvironment({
    agentKey,
    environmentId,
    sessionId: `session-${env.suffix}`,
    ttlMs: 20 * 60 * 1000,
  });
  const withId = {...created, environmentId};
  env.environments.push(withId);
  return withId;
}


async function relaxEnvironmentFilesystemPermissions(created: CreatedEnvironment): Promise<void> {
  const chmodMounts = "chmod -R a+rwX /workspace /inbox /artifacts 2>/dev/null || true";
  await dockerExecStatus(created.metadata.workspaceContainer.name, chmodMounts).catch(() => 1);
  await dockerExecStatus(created.metadata.controlContainer.name, chmodMounts).catch(() => 1);
}

async function stopEnvironment(env: Harness, created: CreatedEnvironment): Promise<void> {
  const response = await postJson(`${env.managerUrlForHost}/environments/stop`, {environmentId: created.environmentId}, {authorization: `Bearer ${env.lifecycleSecret}`}).catch(() => null);
  if (!response || response.status !== 200) {
    await env.manager.stopEnvironment(created.environmentId).catch(() => undefined);
  }
  env.environments = env.environments.filter((entry) => entry.environmentId !== created.environmentId);
}

async function readControlEnv(created: CreatedEnvironment): Promise<Record<string, string>> {
  const raw = await dockerExec(created.metadata.controlContainer.name, "env");
  return Object.fromEntries(raw.split(/\n/).filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    return index >= 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, ""];
  }));
}

async function waitForNoProcess(container: string, grepPattern: string): Promise<string> {
  let last = "";
  for (let index = 0; index < 25; index += 1) {
    last = await dockerExec(container, `pgrep -af ${JSON.stringify(grepPattern)} || true`);
    if (!last.trim()) return "";
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return last;
}

async function findBridgeGateway(): Promise<string> {
  const gateway = await dockerOutput(["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]);
  return gateway || "host.docker.internal";
}

describeLive("B2b real Docker paired workspace exec smoke", () => {
  let harness: Harness;

  beforeAll(async () => {
    await docker(["info"]);

    const suffix = `b2b-${process.pid}-${Date.now()}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), `panda-${suffix}-`));
    const runnerImage = process.env.PANDA_B2B_RUNNER_IMAGE ?? `panda-runner:${suffix}`;
    const workspaceImage = process.env.PANDA_B2B_WORKSPACE_IMAGE ?? `panda-workspace:${suffix}`;
    const reuseImages = process.env.PANDA_B2B_REUSE_IMAGES === "1" && process.env.PANDA_B2B_RUNNER_IMAGE && process.env.PANDA_B2B_WORKSPACE_IMAGE;

    if (!reuseImages) {
      await docker(["build", "--target", "bash-runner", "-t", runnerImage, "."], {cwd: repoRoot});
      await docker(["build", "--target", "workspace-runner", "-t", workspaceImage, "."], {cwd: repoRoot});
    }

    const lifecycleSecret = `lifecycle-${suffix}`;
    const workspaceExecSecret = `workspace-${suffix}`;
    const runnerSecret = `runner-${suffix}`;
    const gateway = await findBridgeGateway();
    const realServer = await startExecutionEnvironmentManager({
      host: "0.0.0.0",
      port: 0,
      sharedSecret: lifecycleSecret,
      controlRunnerImage: runnerImage,
      workspaceImage,
      workspaceExecSecret,
      runnerSharedSecret: runnerSecret,
      hostEnvironmentsRoot: path.join(tempRoot, "environments"),
      managerEnvironmentsRoot: path.join(tempRoot, "environments"),
      coreEnvironmentsRoot: path.join(tempRoot, "environments-core"),
      containerNamePrefix: `panda-${suffix}`,
      // This internal server manager is used for /workspaces/exec auth/action handling; disposable environment
      // creation below uses a sibling manager configured with the final host-reachable URL.
      managerUrl: `http://${gateway}:0`,
      hostBindIp: "127.0.0.1",
      hostRunnerHost: "127.0.0.1",
    });
    // startExecutionEnvironmentManager does not expose the manager instance, so use a sibling instance with identical options for direct lifecycle calls.
    // The live smoke still exercises the real manager HTTP server for /workspaces/exec and auth boundary checks.
    const directManager = new DockerExecutionEnvironmentManager({
      controlRunnerImage: runnerImage,
      workspaceImage,
      workspaceExecSecret,
      runnerSharedSecret: runnerSecret,
      hostEnvironmentsRoot: path.join(tempRoot, "environments"),
      managerEnvironmentsRoot: path.join(tempRoot, "environments"),
      coreEnvironmentsRoot: path.join(tempRoot, "environments-core"),
      containerNamePrefix: `panda-${suffix}`,
      managerUrl: `http://${gateway}:${realServer.port}`,
      hostBindIp: "127.0.0.1",
      hostRunnerHost: "127.0.0.1",
    });

    harness = {
      suffix,
      runnerImage,
      workspaceImage,
      tempRoot,
      manager: directManager,
      server: realServer,
      managerUrlForHost: `http://127.0.0.1:${realServer.port}`,
      managerUrlForContainers: `http://${gateway}:${realServer.port}`,
      lifecycleSecret,
      workspaceExecSecret,
      runnerSecret,
      environments: [],
    };
  }, 600_000);

  afterAll(async () => {
    if (!harness) return;
    for (const created of [...harness.environments].reverse()) {
      await relaxEnvironmentFilesystemPermissions(created);
      await stopEnvironment(harness, created);
    }
    await harness.server.close();
    if (!process.env.PANDA_B2B_RUNNER_IMAGE) await docker(["rmi", "-f", harness.runnerImage], {allowFailure: true});
    if (!process.env.PANDA_B2B_WORKSPACE_IMAGE) await docker(["rmi", "-f", harness.workspaceImage], {allowFailure: true});
    await execFile("chmod", ["-R", "u+rwX", harness.tempRoot]).catch(() => undefined);
    await rm(harness.tempRoot, {recursive: true, force: true});
  }, 180_000);

  it("proves workspace locality, public runner ownership, token scope, setup, process cleanup, and image cleanliness", async () => {
    const directResolution = await dockerOutput(["run", "--rm", harness.workspaceImage, "bash", "-lc", "for t in node pnpm corepack panda; do command -v \"$t\" || true; done"]);
    expect(directResolution).toBe("");
    const absoluteProbe = await dockerOutput(["run", "--rm", harness.workspaceImage, "bash", "-lc", "for p in /usr/bin/node /usr/local/bin/node /usr/bin/pnpm /usr/local/bin/pnpm /usr/bin/corepack /usr/local/bin/corepack /usr/local/bin/panda /app/dist/app/cli.js; do [ ! -e \"$p\" ] || echo \"$p\"; done"]);
    expect(absoluteProbe).toBe("");

    const envA = await createEnvironment(harness, `env-a-${harness.suffix}`);
    const envB = await createEnvironment(harness, `env-b-${harness.suffix}`);
    const runnerUrl = envA.runnerUrl;
    const controlName = envA.metadata.controlContainer.name;
    const workspaceName = envA.metadata.workspaceContainer.name;
    expect(runnerUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);

    for (const endpoint of ["exec", "abort", "jobs/start", "jobs/status", "jobs/wait", "jobs/cancel"] as const) {
      const response = await postJson(`${harness.managerUrlForHost}/${endpoint}`, {}, {authorization: `Bearer ${harness.lifecycleSecret}`});
      expect(response.status).toBe(404);
    }

    const workspaceHostname = await dockerExec(workspaceName, "hostname");
    const controlHostname = await dockerExec(controlName, "hostname");
    const execResult = await runnerPost<BashExecutionResult>(harness, runnerUrl, "exec", {
      requestId: `exec-${harness.suffix}`,
      command: "hostname; touch /tmp/panda-b2b-workspace-exec-marker; touch /workspace/panda-b2b-workspace-marker; touch /artifacts/panda-b2b-artifacts-marker; for t in node pnpm corepack panda; do command -v \"$t\" && echo \"found:$t\" || echo \"missing:$t\"; done",
      cwd: "/workspace",
      timeoutMs: 30_000,
      trackedEnvKeys: [],
      maxOutputChars: 20_000,
    });
    expect(execResult.success, `first foreground workspace exec failed: ${JSON.stringify({exitCode: execResult.exitCode, stdout: execResult.stdout, stderr: execResult.stderr, timedOut: execResult.timedOut, aborted: execResult.aborted})}`).toBe(true);
    expect(execResult.stdout).toContain(workspaceHostname);
    expect(execResult.stdout).not.toContain(controlHostname);
    expect(execResult.stdout).toContain("missing:node");
    expect(execResult.stdout).toContain("missing:pnpm");
    expect(execResult.stdout).toContain("missing:corepack");
    expect(execResult.stdout).toContain("missing:panda");
    expect(await dockerExecStatus(workspaceName, "test -f /tmp/panda-b2b-workspace-exec-marker && test -f /workspace/panda-b2b-workspace-marker && test -f /artifacts/panda-b2b-artifacts-marker")).toBe(0);
    expect(await dockerExecStatus(controlName, "test -f /tmp/panda-b2b-workspace-exec-marker")).not.toBe(0);

    const setupScript = path.join(harness.tempRoot, "setup.sh");
    await writeFile(setupScript, "#!/usr/bin/env bash\nset -euo pipefail\nsetup_hostname=$(hostname)\nprintf '%s\\n' \"$setup_hostname\"\nprintf '%s\\n' \"$setup_hostname\" > /artifacts/setup-hostname.txt\ntouch /workspace/setup-ran-from-workspace\n", "utf8");
    const setupRunner = new RemoteExecutionEnvironmentSetupRunner({env: {BASH_SERVER_SHARED_SECRET: harness.runnerSecret}});
    await setupRunner.runSetup({
      agentKey,
      environmentId: envA.environmentId,
      runnerUrl,
      runnerCwd: envA.runnerCwd,
      filesystem: envA.metadata.filesystem,
      setupScript: {requestedPath: setupScript, resolvedPath: setupScript},
    });
    const setupDir = path.join(envA.metadata.filesystem.artifacts.corePath, "setup");
    expect(await fileExists(path.join(setupDir, "setup.sh"))).toBe(true);
    expect(await fileExists(path.join(setupDir, "stdout.log"))).toBe(true);
    expect(await fileExists(path.join(setupDir, "stderr.log"))).toBe(true);
    expect(await fileExists(path.join(setupDir, "setup-result.json"))).toBe(true);
    const toolchain = JSON.parse(await readFile(path.join(setupDir, "toolchain.json"), "utf8"));
    expect(toolchain.tools.node.status).toBe("missing");
    expect(toolchain.tools.pnpm.status).toBe("missing");
    expect(toolchain.tools.corepack.status).toBe("missing");
    expect(await dockerExecStatus(workspaceName, "test -f /workspace/setup-ran-from-workspace && test -s /artifacts/setup-hostname.txt")).toBe(0);
    const setupHostname = await dockerExec(workspaceName, "cat /artifacts/setup-hostname.txt");
    expect(setupHostname).toBe(workspaceHostname);
    expect(setupHostname).not.toBe(controlHostname);
    const setupStdout = await readFile(path.join(setupDir, "stdout.log"), "utf8");
    expect(setupStdout.trim()).toBe(workspaceHostname);
    expect(setupStdout).not.toContain(controlHostname);
    expect(await fileExists(path.join(envB.metadata.filesystem.artifacts.corePath, "setup", "setup.sh"))).toBe(false);

    const persist = await runnerPost<BashExecutionResult>(harness, runnerUrl, "exec", {
      requestId: `persist-${harness.suffix}`,
      command: "mkdir -p nested && cd nested && export B2B_PERSIST=ok && printf persisted",
      cwd: "/workspace",
      timeoutMs: 30_000,
      trackedEnvKeys: ["B2B_PERSIST"],
      maxOutputChars: 20_000,
    });
    expect(persist.success).toBe(true);
    expect(persist.finalCwd).toBe("/workspace/nested");
    expect(persist.persistedEnvEntries).toContainEqual({key: "B2B_PERSIST", present: true, value: "ok"});
    const followup = await runnerPost<BashExecutionResult>(harness, runnerUrl, "exec", {
      requestId: `persist-followup-${harness.suffix}`,
      command: "printf '%s:%s' \"$(pwd -P)\" \"$B2B_PERSIST\"",
      cwd: persist.finalCwd,
      env: {B2B_PERSIST: "ok"},
      timeoutMs: 30_000,
      trackedEnvKeys: [],
      maxOutputChars: 20_000,
    });
    expect(followup.stdout).toBe("/workspace/nested:ok");
    const failedPersist = await runnerPost<BashExecutionResult>(harness, runnerUrl, "exec", {
      requestId: `persist-fail-${harness.suffix}`,
      command: "mkdir -p failed && cd failed && export B2B_PERSIST=bad && exit 7",
      cwd: "/workspace",
      timeoutMs: 30_000,
      trackedEnvKeys: ["B2B_PERSIST"],
      maxOutputChars: 20_000,
    });
    expect(failedPersist.success).toBe(false);
    expect(failedPersist.exitCode).toBe(7);
    expect(failedPersist.finalCwd).toBe("/workspace");
    expect(failedPersist.persistedEnvEntries).toEqual([]);
    const badCwd = await postJson(buildRunnerEndpoint(runnerUrl, "exec"), {
      requestId: `bad-cwd-${harness.suffix}`,
      command: "touch /tmp/should-not-run",
      cwd: "/",
      timeoutMs: 30_000,
      trackedEnvKeys: [],
      maxOutputChars: 20_000,
    }, runnerHeaders(harness, runnerUrl));
    expect(badCwd.status).toBe(400);
    expect(await dockerExecStatus(workspaceName, "test -f /tmp/should-not-run")).not.toBe(0);

    const bgDir = `/workspace/bg-${harness.suffix}`;
    const job = await runnerPost<BashJobSnapshot>(harness, runnerUrl, "jobs/start", {
      jobId: `job-ok-${harness.suffix}`,
      command: `mkdir -p ${bgDir} && cd ${bgDir} && echo bg-out && echo bg-err >&2 && while [ ! -f ${bgDir}/release ]; do sleep 0.1; done`,
      cwd: "/workspace",
      timeoutMs: 60_000,
      trackedEnvKeys: [],
      maxOutputChars: 20_000,
      persistOutputThresholdChars: 1,
      persistOutputFiles: true,
    });
    expect(job.jobId).toBe(`job-ok-${harness.suffix}`);
    expect(job.status).toBe("running");
    expect(JSON.stringify(job)).not.toContain("runner-job:");
    const status = await runnerPost<BashJobSnapshot>(harness, runnerUrl, "jobs/status", {jobId: job.jobId});
    expect(status.jobId).toBe(job.jobId);
    expect(await dockerExecStatus(workspaceName, `touch ${JSON.stringify(`${bgDir}/release`)}`)).toBe(0);
    const waited = await runnerPost<BashJobSnapshot>(harness, runnerUrl, "jobs/wait", {jobId: job.jobId, timeoutMs: 10_000});
    expect(waited.status).toBe("completed");
    expect(waited.exitCode).toBe(0);
    expect(waited.stdout).toContain("bg-out");
    expect(waited.stderr).toContain("bg-err");
    expect(waited.stdoutPersisted).toBe(false);
    expect(waited.stderrPersisted).toBe(false);
    const evicted = await postJson(buildRunnerEndpoint(runnerUrl, "jobs/status"), {jobId: job.jobId}, runnerHeaders(harness, runnerUrl));
    expect(evicted.status).toBe(404);
    const badJob = await runnerPost<BashJobSnapshot>(harness, runnerUrl, "jobs/start", {
      jobId: `job-bad-${harness.suffix}`,
      command: "echo bad-out; echo bad-err >&2; exit 9",
      cwd: "/workspace",
      timeoutMs: 60_000,
      trackedEnvKeys: [],
      maxOutputChars: 20_000,
      persistOutputThresholdChars: 1,
    });
    const badWait = badJob.status === "running" ? await runnerPost<BashJobSnapshot>(harness, runnerUrl, "jobs/wait", {jobId: badJob.jobId, timeoutMs: 10_000}) : badJob;
    expect(badWait.status).toBe("failed");
    expect(badWait.exitCode).toBe(9);

    const cancelMarker = `panda_b2b_cancel_${harness.suffix}`;
    const cancelJob = await runnerPost<BashJobSnapshot>(harness, runnerUrl, "jobs/start", {
      jobId: `job-cancel-${harness.suffix}`,
      command: `B2B_MARKER=${cancelMarker} bash -c 'bash -c "exec -a \"$B2B_MARKER-grandchild\" sleep 100000" & exec -a "$B2B_MARKER-child" sleep 100000'`,
      cwd: "/workspace",
      timeoutMs: 120_000,
      trackedEnvKeys: [],
      maxOutputChars: 20_000,
      persistOutputThresholdChars: 1,
    });
    expect(cancelJob.status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cancelPattern = `[p]anda_b2b_cancel_${harness.suffix}`;
    const cancelProcessesBefore = await dockerExec(workspaceName, `pgrep -af ${JSON.stringify(cancelPattern)} || true`);
    expect(cancelProcessesBefore).toContain(`${cancelMarker}-child`);
    expect(cancelProcessesBefore).toContain(`${cancelMarker}-grandchild`);
    const cancelled = await runnerPost<BashJobSnapshot>(harness, runnerUrl, "jobs/cancel", {jobId: cancelJob.jobId, timeoutMs: 1_000});
    expect(cancelled.status).toBe("cancelled");
    expect(await waitForNoProcess(workspaceName, cancelPattern)).toBe("");
    expect(await dockerExec(controlName, `pgrep -af ${JSON.stringify(cancelPattern)} || true`)).toBe("");

    const abortMarker = `panda_b2b_abort_${harness.suffix}`;
    const abortRequestId = `abort-${harness.suffix}`;
    const abortPromise = postJson(buildRunnerEndpoint(runnerUrl, "exec"), {
      requestId: abortRequestId,
      command: `B2B_MARKER=${abortMarker} bash -c 'bash -c "exec -a \"$B2B_MARKER-grandchild\" sleep 100000" & exec -a "$B2B_MARKER-child" sleep 100000'`,
      cwd: "/workspace",
      timeoutMs: 120_000,
      trackedEnvKeys: [],
      maxOutputChars: 20_000,
    }, runnerHeaders(harness, runnerUrl));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const abortPattern = `[p]anda_b2b_abort_${harness.suffix}`;
    const abortProcessesBefore = await dockerExec(workspaceName, `pgrep -af ${JSON.stringify(abortPattern)} || true`);
    expect(abortProcessesBefore).toContain(`${abortMarker}-child`);
    expect(abortProcessesBefore).toContain(`${abortMarker}-grandchild`);
    const abortResponse = await runnerPost<{ok: true; aborted: boolean}>(harness, runnerUrl, "abort", {requestId: abortRequestId});
    expect(abortResponse.aborted).toBe(true);
    const abortedExec = await abortPromise;
    expect(abortedExec.status).toBe(200);
    expect(abortedExec.body.aborted || abortedExec.body.interrupted).toBe(true);
    expect(await waitForNoProcess(workspaceName, abortPattern)).toBe("");

    const controlEnv = await readControlEnv(envA);
    const workspaceToken = controlEnv.PANDA_WORKSPACE_EXEC_TOKEN;
    expect(workspaceToken).toBeTruthy();
    expect(controlEnv.PANDA_WORKSPACE_EXEC_ENVIRONMENT_ID).toBe(envA.environmentId);
    expect(controlEnv.PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN).toBeUndefined();
    expect(Object.values(controlEnv).join("\n")).not.toContain(harness.lifecycleSecret);
    const environ = await dockerExec(controlName, "tr '\\0' '\\n' < /proc/1/environ");
    expect(environ).toContain("PANDA_WORKSPACE_EXEC_TOKEN=");
    expect(environ).not.toContain("PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN=");
    expect(environ).not.toContain(harness.lifecycleSecret);
    expect((await postJson(`${harness.managerUrlForHost}/environments/disposable`, {environmentId: `nope-${harness.suffix}`}, {authorization: `Bearer ${workspaceToken}`})).status).toBe(403);
    expect((await postJson(`${harness.managerUrlForHost}/environments/stop`, {environmentId: envA.environmentId}, {authorization: `Bearer ${workspaceToken}`})).status).toBe(403);
    const controlLifecycleAttempt = await dockerExec(controlName, `token="$PANDA_WORKSPACE_EXEC_TOKEN"; curl -sS -o /tmp/lifecycle-code -w '%{http_code}' -H "authorization: Bearer $token" -H 'content-type: application/json' --data '${JSON.stringify({environmentId: envA.environmentId})}' ${harness.managerUrlForContainers}/environments/stop`);
    expect(controlLifecycleAttempt).toBe("403");

    const crossEnv = await postJson(`${harness.managerUrlForHost}/workspaces/exec`, {
      action: "start",
      environmentId: envB.environmentId,
      request: {mode: "foreground", processId: `cross-${harness.suffix}`, command: "touch /workspace/cross-env-should-not-run", cwd: "/workspace", timeoutMs: 30_000, maxOutputChars: 20_000, trackedEnvKeys: []},
    }, {authorization: `Bearer ${workspaceToken}`});
    expect(crossEnv.status).toBe(403);
    expect(await dockerExecStatus(envB.metadata.workspaceContainer.name, "test -f /workspace/cross-env-should-not-run")).not.toBe(0);
    const sameEnv = await postJson(`${harness.managerUrlForHost}/workspaces/exec`, {
      action: "start",
      environmentId: envA.environmentId,
      request: {mode: "foreground", processId: `same-${harness.suffix}`, command: "touch /workspace/same-env-ran", cwd: "/workspace", timeoutMs: 30_000, maxOutputChars: 20_000, trackedEnvKeys: []},
    }, {authorization: `Bearer ${workspaceToken}`});
    expect(sameEnv.status).toBe(200);
    expect(await dockerExecStatus(workspaceName, "test -f /workspace/same-env-ran")).toBe(0);

    const envBControl = envB.metadata.controlContainer.name;
    const envBWorkspace = envB.metadata.workspaceContainer.name;
    await stopEnvironment(harness, envB);
    expect(await dockerStatus(["inspect", envBControl])).not.toBe(0);
    expect(await dockerStatus(["inspect", envBWorkspace])).not.toBe(0);

    const envAControl = controlName;
    const envAWorkspace = workspaceName;
    await stopEnvironment(harness, envA);
    expect(await dockerStatus(["inspect", envAControl])).not.toBe(0);
    expect(await dockerStatus(["inspect", envAWorkspace])).not.toBe(0);
  }, 600_000);
});
