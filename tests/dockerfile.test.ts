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
});
