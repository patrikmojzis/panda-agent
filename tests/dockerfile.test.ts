import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerfilePath = path.join(repoRoot, "Dockerfile");

interface DockerStage {
  readonly base: string;
  readonly body: string;
}

function parseDockerStages(dockerfile: string): Map<string, DockerStage> {
  const stages = new Map<string, DockerStage>();
  const stagePattern = /^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/gim;
  const matches = [...dockerfile.matchAll(stagePattern)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const next = matches[index + 1];
    const base = match[1]!;
    const name = match[2]!;
    const bodyStart = match.index! + match[0].length;
    const bodyEnd = next?.index ?? dockerfile.length;
    stages.set(name, {
      base,
      body: dockerfile.slice(bodyStart, bodyEnd),
    });
  }

  return stages;
}

describe("Dockerfile targets", () => {
  it("keeps default app image and bash runner targets on separate CMD defaults", async () => {
    const stages = parseDockerStages(await readFile(dockerfilePath, "utf8"));

    expect(stages.get("app")?.body).toContain('CMD ["--help"]');
    expect(stages.get("final")?.base).toBe("app");
    expect(stages.get("bash-runner")?.body).toContain('CMD ["bash-server"]');
    expect(stages.get("runner")?.base).toBe("bash-runner");
  });

  it("keeps legacy workspace tools in bash-runner while workspace exec is deferred", async () => {
    const stages = parseDockerStages(await readFile(dockerfilePath, "utf8"));
    const bashRunnerBody = stages.get("bash-runner")?.body ?? "";

    expect(bashRunnerBody).toContain("mongodb-mongosh");
    expect(bashRunnerBody).toContain("ripgrep");
    expect(bashRunnerBody).toContain("sqlite3");
    expect(bashRunnerBody).toContain("python3-venv");
    expect(bashRunnerBody).toContain("libreoffice-nogui");
    expect(bashRunnerBody).toContain('CMD ["bash-server"]');
  });

  it("adds a workspace image target without Node or Panda runtime artifacts", async () => {
    const stages = parseDockerStages(await readFile(dockerfilePath, "utf8"));
    const workspace = stages.get("workspace-runner");

    expect(workspace?.base).toBe("ubuntu:24.04");
    expect(workspace?.body).toContain('WORKDIR /workspace');
    expect(workspace?.body).toContain('CMD ["sleep", "infinity"]');
    expect(stages.get("workspace")?.base).toBe("workspace-runner");
    expect(workspace?.body).not.toMatch(/nodejs/);
    expect(workspace?.body).not.toContain("corepack");
    expect(workspace?.body).not.toContain("pnpm");
    expect(workspace?.body).not.toContain("/app/dist");
    expect(workspace?.body).not.toContain("/usr/local/bin/panda");
  });
});
