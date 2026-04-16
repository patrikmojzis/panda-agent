import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/integrations/shell/bash-output.js", async () => {
  const actual = await vi.importActual<typeof import("../src/integrations/shell/bash-output.js")>(
    "../src/integrations/shell/bash-output.js",
  );

  return {
    ...actual,
    finalizeOutputCapture: vi.fn(async (options: Parameters<typeof actual.finalizeOutputCapture>[0]) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return actual.finalizeOutputCapture(options);
    }),
  };
});

describe("ManagedBashJob", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop() ?? "", { recursive: true, force: true });
    }
  });

  it("keeps status snapshots running until terminal metadata is ready", async () => {
    const {ManagedBashJob} = await import("../src/integrations/shell/bash-background-job.js");
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-job-"));
    directories.push(workspace);

    const job = await ManagedBashJob.start({
      jobId: "job-race",
      command: "printf '0123456789ABCDEF'",
      cwd: workspace,
      childEnv: process.env,
      shell: process.env.SHELL ?? "/bin/zsh",
      timeoutMs: 5_000,
      trackedEnvKeys: [],
      maxOutputChars: 8,
      persistOutputThresholdChars: 8,
      persistOutputFiles: true,
      outputDirectory: path.join(workspace, "tool-results"),
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(job.snapshot().status).toBe("running");

    const final = await job.wait(1_000);
    expect(final.status).toBe("completed");
    expect(final.finalCwd).toBe(await realpath(workspace));
    expect(final.stdoutPersisted).toBe(true);
    expect(final.stdoutPath).toBeDefined();
  });
});
