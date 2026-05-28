import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import os from "node:os";
import path from "node:path";

import {describe, expect, it} from "vitest";

import type {ExecutionEnvironmentFilesystemMetadata} from "../src/domain/execution-environments/filesystem.js";
import type {BashExecutionResult, BashRunnerExecRequest} from "../src/integrations/shell/bash-protocol.js";
import {
  ExecutionEnvironmentSetupError,
  RemoteExecutionEnvironmentSetupRunner,
  TOOLCHAIN_PROBE_COMMAND,
} from "../src/app/runtime/execution-environment-setup-runner.js";

function createFilesystem(root: string): ExecutionEnvironmentFilesystemMetadata {
  return {
    envDir: "env-setup-test",
    root: {
      corePath: root,
      parentRunnerPath: "/environments/env-setup-test",
    },
    workspace: {
      corePath: path.join(root, "workspace"),
      parentRunnerPath: "/environments/env-setup-test/workspace",
      workerPath: "/workspace",
    },
    inbox: {
      corePath: path.join(root, "inbox"),
      parentRunnerPath: "/environments/env-setup-test/inbox",
      workerPath: "/inbox",
    },
    artifacts: {
      corePath: path.join(root, "artifacts"),
      parentRunnerPath: "/environments/env-setup-test/artifacts",
      workerPath: "/artifacts",
    },
  };
}

function bashResult(overrides: Partial<BashExecutionResult> = {}): BashExecutionResult & {ok: true} {
  return {
    ok: true,
    shell: "/bin/bash",
    finalCwd: "/workspace",
    durationMs: 10,
    timeoutMs: 300_000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    abortReason: null,
    interrupted: false,
    success: true,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutChars: 0,
    stderrChars: 0,
    stdoutPersisted: false,
    stderrPersisted: false,
    noOutput: true,
    trackedEnvKeys: [],
    persistedEnvEntries: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {"content-type": "application/json"},
  });
}

const execFileAsync = promisify(execFile);

describe("RemoteExecutionEnvironmentSetupRunner", () => {
  it("toolchain probe command emits valid observations without stderr", async () => {
    const {stdout, stderr} = await execFileAsync("bash", ["-lc", TOOLCHAIN_PROBE_COMMAND], {
      timeout: 30_000,
    });

    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      tools: Record<string, {status: string; path?: string; version?: string}>;
    };
    expect(parsed.tools.node).toMatchObject({status: "present"});
    expect(parsed.tools.node?.path?.trim()).toBeTruthy();
    expect(parsed.tools.node?.version?.trim()).toBeTruthy();
    for (const tool of Object.values(parsed.tools)) {
      if (tool.status === "present") {
        expect(tool.path?.trim()).toBeTruthy();
        expect(tool.version?.trim()).toBeTruthy();
      }
    }
  });

  it("copies setup artifacts, injects credentials only into setup exec, redacts logs, and records actual toolchain", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-runner-"));
    try {
      const sourceScript = path.join(tmp, "setup.sh");
      await writeFile(sourceScript, "#!/usr/bin/env bash\necho setup\n", "utf8");
      const requests: BashRunnerExecRequest[] = [];
      const responses = [
        bashResult({
          stdout: "setup saw SECRET_DO_NOT_STORE\n",
          stderr: "stderr SECRET_DO_NOT_STORE\n",
          stdoutChars: "setup saw SECRET_DO_NOT_STORE\n".length,
          stderrChars: "stderr SECRET_DO_NOT_STORE\n".length,
          noOutput: false,
        }),
        bashResult({
          timeoutMs: 30_000,
          stdout: JSON.stringify({
            tools: {
              node: {status: "present", path: "/opt/node/bin/node", version: "v99.1.0"},
              pnpm: {status: "missing"},
              corepack: {status: "present", path: "/opt/node/bin/corepack", version: "0.34.0"},
            },
          }),
          noOutput: false,
        }),
      ];
      const fetchImpl: typeof fetch = async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as BashRunnerExecRequest);
        const response = responses.shift();
        if (!response) {
          throw new Error("unexpected setup runner request");
        }
        return jsonResponse(response);
      };
      const runner = new RemoteExecutionEnvironmentSetupRunner({
        env: {} as NodeJS.ProcessEnv,
        fetchImpl,
        credentialResolver: {
          resolveEnvironment: async () => ({SECRET_TOKEN: "SECRET_DO_NOT_STORE"}),
        },
      });

      const metadata = await runner.runSetup({
        agentKey: "panda",
        environmentId: "env-setup",
        runnerUrl: "http://runner:8080",
        runnerCwd: "/workspace",
        filesystem: createFilesystem(tmp),
        setupScript: {
          requestedPath: "setup.sh",
          resolvedPath: sourceScript,
        },
      });

      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        command: "bash /artifacts/setup/setup.sh",
        cwd: "/workspace",
        env: {SECRET_TOKEN: "SECRET_DO_NOT_STORE"},
        trackedEnvKeys: [],
      });
      expect(requests[1]?.env).toBeUndefined();
      const setupDir = path.join(tmp, "artifacts", "setup");
      await expect(stat(path.join(setupDir, "setup.sh"))).resolves.toMatchObject({});
      await expect(readFile(path.join(setupDir, "setup.sh"), "utf8")).resolves.toBe(
        "#!/usr/bin/env bash\necho setup\n",
      );
      await expect(readFile(path.join(setupDir, "stdout.log"), "utf8")).resolves.toContain("[redacted]");
      await expect(readFile(path.join(setupDir, "stderr.log"), "utf8")).resolves.toContain("[redacted]");
      const resultJson = await readFile(path.join(setupDir, "setup-result.json"), "utf8");
      const toolchainJson = await readFile(path.join(setupDir, "toolchain.json"), "utf8");
      expect(resultJson).not.toContain("SECRET_DO_NOT_STORE");
      expect(toolchainJson).not.toContain("SECRET_DO_NOT_STORE");
      expect(JSON.stringify(metadata)).not.toContain("SECRET_DO_NOT_STORE");
      expect(JSON.parse(toolchainJson)).toMatchObject({
        status: "succeeded",
        tools: {
          node: {status: "present", version: "v99.1.0"},
          pnpm: {status: "missing"},
          corepack: {status: "present", version: "0.34.0"},
        },
      });
      expect(metadata).toMatchObject({
        setup: {
          status: "succeeded",
          artifacts: {
            script: "/artifacts/setup/setup.sh",
            result: "/artifacts/setup/setup-result.json",
            parent: {
              script: "/environments/env-setup-test/artifacts/setup/setup.sh",
            },
          },
          script: {
            inspectable: true,
            note: expect.stringContaining("do not embed secrets"),
          },
          toolchain: {
            tools: {
              pnpm: {status: "missing"},
            },
          },
        },
      });
    } finally {
      await rm(tmp, {recursive: true, force: true});
    }
  });


  it("copies the setup script to the local worker mount source when it differs from core artifacts", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-worker-local-"));
    try {
      const coreRoot = path.join(tmp, "core");
      const hostRoot = path.join(tmp, "host");
      const sourceScript = path.join(tmp, "setup.sh");
      await writeFile(sourceScript, "#!/usr/bin/env bash\necho setup\n", "utf8");
      const filesystem = createFilesystem(coreRoot);
      filesystem.artifacts.hostPath = path.join(hostRoot, "artifacts");
      const requests: BashRunnerExecRequest[] = [];
      const responses = [
        bashResult(),
        bashResult({
          timeoutMs: 30_000,
          stdout: JSON.stringify({
            tools: {
              node: {status: "missing"},
              pnpm: {status: "missing"},
              corepack: {status: "missing"},
            },
          }),
          noOutput: false,
        }),
      ];
      const fetchImpl: typeof fetch = async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as BashRunnerExecRequest);
        await expect(stat(path.join(hostRoot, "artifacts", "setup", "setup.sh"))).resolves.toMatchObject({});
        return jsonResponse(responses.shift() ?? bashResult());
      };
      const runner = new RemoteExecutionEnvironmentSetupRunner({
        env: {} as NodeJS.ProcessEnv,
        fetchImpl,
      });

      await runner.runSetup({
        agentKey: "panda",
        environmentId: "env-setup",
        runnerUrl: "http://runner:8080",
        runnerCwd: "/workspace",
        filesystem,
        setupScript: {
          requestedPath: "setup.sh",
          resolvedPath: sourceScript,
        },
      });

      expect(responses).toHaveLength(0);
      expect(requests[0]?.command).toBe("bash /artifacts/setup/setup.sh");
      await expect(readFile(path.join(coreRoot, "artifacts", "setup", "setup.sh"), "utf8")).resolves.toBe("#!/usr/bin/env bash\necho setup\n");
      await expect(readFile(path.join(hostRoot, "artifacts", "setup", "setup.sh"), "utf8")).resolves.toBe("#!/usr/bin/env bash\necho setup\n");
    } finally {
      await rm(tmp, {recursive: true, force: true});
    }
  });

  it("writes failed setup artifacts for non-zero setup exits", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-fail-"));
    try {
      const sourceScript = path.join(tmp, "setup.sh");
      await writeFile(sourceScript, "#!/usr/bin/env bash\nexit 7\n", "utf8");
      const fetchImpl: typeof fetch = async () => jsonResponse(bashResult({
        exitCode: 7,
        success: false,
        stdout: "SECRET_DO_NOT_STORE\n",
        stdoutChars: "SECRET_DO_NOT_STORE\n".length,
        noOutput: false,
      }));
      const runner = new RemoteExecutionEnvironmentSetupRunner({
        env: {} as NodeJS.ProcessEnv,
        fetchImpl,
        credentialResolver: {
          resolveEnvironment: async () => ({SECRET_TOKEN: "SECRET_DO_NOT_STORE"}),
        },
      });

      await expect(runner.runSetup({
        agentKey: "panda",
        environmentId: "env-setup",
        runnerUrl: "http://runner:8080",
        runnerCwd: "/workspace",
        filesystem: createFilesystem(tmp),
        setupScript: {
          requestedPath: "setup.sh",
          resolvedPath: sourceScript,
        },
      })).rejects.toBeInstanceOf(ExecutionEnvironmentSetupError);

      const setupDir = path.join(tmp, "artifacts", "setup");
      await expect(readFile(path.join(setupDir, "stdout.log"), "utf8")).resolves.toContain("[redacted]");
      const result = JSON.parse(await readFile(path.join(setupDir, "setup-result.json"), "utf8"));
      const toolchain = JSON.parse(await readFile(path.join(setupDir, "toolchain.json"), "utf8"));
      expect(result).toMatchObject({
        status: "failed",
        execution: {
          exitCode: 7,
        },
        error: "Setup script exited with code 7. Output: [redacted]",
      });
      expect(toolchain).toMatchObject({
        status: "not_run",
      });
      expect(JSON.stringify(result)).not.toContain("SECRET_DO_NOT_STORE");
    } finally {
      await rm(tmp, {recursive: true, force: true});
    }
  });

  it("fails closed when the toolchain probe emits stderr even with parseable stdout", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-probe-stderr-"));
    try {
      const sourceScript = path.join(tmp, "setup.sh");
      await writeFile(sourceScript, "#!/usr/bin/env bash\ntrue\n", "utf8");
      const responses = [
        bashResult(),
        bashResult({
          timeoutMs: 30_000,
          stdout: JSON.stringify({
            tools: {
              node: {status: "present", path: "", version: ""},
              pnpm: {status: "missing"},
              corepack: {status: "missing"},
            },
          }),
          stderr: "sed: -e expression #1, char 34: unterminated `s' command\n",
          stderrChars: "sed: -e expression #1, char 34: unterminated `s' command\n".length,
          noOutput: false,
        }),
      ];
      const fetchImpl: typeof fetch = async () => jsonResponse(responses.shift() ?? bashResult());
      const runner = new RemoteExecutionEnvironmentSetupRunner({
        env: {} as NodeJS.ProcessEnv,
        fetchImpl,
      });

      await expect(runner.runSetup({
        agentKey: "panda",
        environmentId: "env-setup",
        runnerUrl: "http://runner:8080",
        runnerCwd: "/workspace",
        filesystem: createFilesystem(tmp),
        setupScript: {
          requestedPath: "setup.sh",
          resolvedPath: sourceScript,
        },
      })).rejects.toThrow("Toolchain probe wrote to stderr");

      const result = JSON.parse(await readFile(path.join(tmp, "artifacts", "setup", "setup-result.json"), "utf8"));
      expect(result).toMatchObject({
        status: "failed",
        error: expect.stringContaining("sed:"),
      });
    } finally {
      await rm(tmp, {recursive: true, force: true});
    }
  });

  it("fails closed instead of recording a Corepack notice as a version", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-corepack-notice-"));
    try {
      const sourceScript = path.join(tmp, "setup.sh");
      await writeFile(sourceScript, "#!/usr/bin/env bash\ntrue\n", "utf8");
      const responses = [
        bashResult(),
        bashResult({
          timeoutMs: 30_000,
          stdout: JSON.stringify({
            tools: {
              node: {status: "present", path: "/usr/bin/node", version: "v99.1.0"},
              pnpm: {status: "missing"},
              corepack: {
                status: "present",
                path: "/usr/bin/corepack",
                version: "! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-10.0.0.tgz",
              },
            },
          }),
          noOutput: false,
        }),
      ];
      const fetchImpl: typeof fetch = async () => jsonResponse(responses.shift() ?? bashResult());
      const runner = new RemoteExecutionEnvironmentSetupRunner({
        env: {} as NodeJS.ProcessEnv,
        fetchImpl,
      });

      await expect(runner.runSetup({
        agentKey: "panda",
        environmentId: "env-setup",
        runnerUrl: "http://runner:8080",
        runnerCwd: "/workspace",
        filesystem: createFilesystem(tmp),
        setupScript: {
          requestedPath: "setup.sh",
          resolvedPath: sourceScript,
        },
      })).rejects.toThrow("Toolchain probe returned invalid corepack version output");

      const toolchain = JSON.parse(await readFile(path.join(tmp, "artifacts", "setup", "toolchain.json"), "utf8"));
      expect(toolchain).toMatchObject({
        status: "failed",
        error: expect.stringContaining("invalid corepack version"),
      });
    } finally {
      await rm(tmp, {recursive: true, force: true});
    }
  });

  it("probe command exits non-zero when a tool writes a Corepack notice on stdout", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-probe-bin-"));
    try {
      const bin = path.join(tmp, "bin");
      await writeFile(path.join(tmp, "placeholder"), "", "utf8");
      await mkdir(bin, {recursive: true});
      await writeFile(path.join(bin, "node"), "#!/usr/bin/env bash\nprintf 'v99.1.0\n'\n", {mode: 0o755});
      await writeFile(path.join(bin, "pnpm"), "#!/usr/bin/env bash\nprintf '10.0.0\n'\n", {mode: 0o755});
      await writeFile(
        path.join(bin, "corepack"),
        "#!/usr/bin/env bash\nprintf '! Corepack is about to download pnpm@10.0.0\n'\n",
        {mode: 0o755},
      );

      await expect(execFileAsync("bash", ["-lc", TOOLCHAIN_PROBE_COMMAND], {
        env: {PATH: `${bin}:${process.env.PATH ?? ""}`},
        timeout: 30_000,
      })).rejects.toMatchObject({
        code: 1,
      });
    } finally {
      await rm(tmp, {recursive: true, force: true});
    }
  });

  it("fails closed when a present tool observation has empty path or version", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-empty-tool-"));
    try {
      const sourceScript = path.join(tmp, "setup.sh");
      await writeFile(sourceScript, "#!/usr/bin/env bash\ntrue\n", "utf8");
      const responses = [
        bashResult(),
        bashResult({
          timeoutMs: 30_000,
          stdout: JSON.stringify({
            tools: {
              node: {status: "present", path: "", version: "v99.1.0"},
              pnpm: {status: "missing"},
              corepack: {status: "missing"},
            },
          }),
          noOutput: false,
        }),
      ];
      const fetchImpl: typeof fetch = async () => jsonResponse(responses.shift() ?? bashResult());
      const runner = new RemoteExecutionEnvironmentSetupRunner({
        env: {} as NodeJS.ProcessEnv,
        fetchImpl,
      });

      await expect(runner.runSetup({
        agentKey: "panda",
        environmentId: "env-setup",
        runnerUrl: "http://runner:8080",
        runnerCwd: "/workspace",
        filesystem: createFilesystem(tmp),
        setupScript: {
          requestedPath: "setup.sh",
          resolvedPath: sourceScript,
        },
      })).rejects.toThrow("Toolchain probe returned empty node details");
    } finally {
      await rm(tmp, {recursive: true, force: true});
    }
  });

  it("fails closed when the toolchain probe output cannot be parsed", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "panda-setup-probe-"));
    try {
      const sourceScript = path.join(tmp, "setup.sh");
      await writeFile(sourceScript, "#!/usr/bin/env bash\ntrue\n", "utf8");
      const responses = [
        bashResult(),
        bashResult({timeoutMs: 30_000, stdout: "not-json", noOutput: false}),
      ];
      const fetchImpl: typeof fetch = async () => jsonResponse(responses.shift() ?? bashResult());
      const runner = new RemoteExecutionEnvironmentSetupRunner({
        env: {} as NodeJS.ProcessEnv,
        fetchImpl,
      });

      await expect(runner.runSetup({
        agentKey: "panda",
        environmentId: "env-setup",
        runnerUrl: "http://runner:8080",
        runnerCwd: "/workspace",
        filesystem: createFilesystem(tmp),
        setupScript: {
          requestedPath: "setup.sh",
          resolvedPath: sourceScript,
        },
      })).rejects.toThrow("Toolchain probe returned unparsable JSON");

      const setupDir = path.join(tmp, "artifacts", "setup");
      const result = JSON.parse(await readFile(path.join(setupDir, "setup-result.json"), "utf8"));
      const toolchain = JSON.parse(await readFile(path.join(setupDir, "toolchain.json"), "utf8"));
      expect(result).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Toolchain probe returned unparsable JSON"),
      });
      expect(toolchain).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Toolchain probe returned unparsable JSON"),
      });
    } finally {
      await rm(tmp, {recursive: true, force: true});
    }
  });
});
