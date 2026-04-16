import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {
    Agent,
    GlobFilesTool,
    GrepFilesTool,
    type PandaSessionContext,
    ReadFileTool,
    RunContext,
} from "../src/index.js";

function createRunContext(tool: {name: string}, cwd: string): RunContext<PandaSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "panda",
      instructions: "Inspect files.",
      tools: [tool as any],
    }),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context: {
      cwd,
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    },
  });
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {recursive: true, force: true})));
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "panda-readonly-tools-"));
  tempDirs.push(root);
  await mkdir(path.join(root, "src", "nested"), {recursive: true});
  await writeFile(
    path.join(root, "src", "main.ts"),
    [
      "import {helper} from \"./nested/helper.js\";",
      "",
      "export function runPanda(): string {",
      "  return helper(\"Panda\");",
      "}",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "src", "nested", "helper.ts"),
    [
      "export function helper(name: string): string {",
      "  return `Hello ${name}`;",
      "}",
    ].join("\n"),
  );
  return root;
}

describe("workspace readonly tools", () => {
  it("reads a file with line numbers", async () => {
    const root = await createWorkspace();
    const tool = new ReadFileTool();

    const result = await tool.run({
      path: "src/main.ts",
      startLine: 2,
      maxLines: 2,
    }, createRunContext(tool, root));

    expect(result).toMatchObject({
      details: {
        path: "src/main.ts",
        startLine: 2,
        endLine: 3,
        totalLines: 5,
        truncated: true,
      },
    });
    expect(JSON.stringify(result)).toContain("2 | ");
    expect(JSON.stringify(result)).toContain("3 | export function runPanda(): string {");
  });

  it("globs files relative to the workspace root", async () => {
    const root = await createWorkspace();
    const tool = new GlobFilesTool();

    const result = await tool.run({
      pattern: "src/**/*.ts",
    }, createRunContext(tool, root));

    expect(result).toMatchObject({
      details: {
        matches: ["src/main.ts", "src/nested/helper.ts"],
      },
    });
  });

  it("globs files relative to the provided root without forcing workspace-prefixed patterns", async () => {
    const root = await createWorkspace();
    const tool = new GlobFilesTool();

    const result = await tool.run({
      root: "src",
      pattern: "nested/*.ts",
    }, createRunContext(tool, root));

    expect(result).toMatchObject({
      details: {
        root: "src",
        matches: ["src/nested/helper.ts"],
        skippedDirectories: expect.arrayContaining(["node_modules"]),
      },
    });
  });

  it("greps matching lines and respects a glob filter", async () => {
    const root = await createWorkspace();
    const tool = new GrepFilesTool();

    const result = await tool.run({
      pattern: "runPanda|helper",
      glob: "src/**/*.ts",
    }, createRunContext(tool, root));

    expect(result).toMatchObject({
      details: {
        matches: [
          {
            path: "src/main.ts",
            line: 1,
          },
          {
            path: "src/main.ts",
            line: 3,
          },
          {
            path: "src/main.ts",
            line: 4,
          },
          {
            path: "src/nested/helper.ts",
            line: 1,
          },
        ],
      },
    });
  });

  it("greps with a root-relative glob and reports skipped unreadable files", async () => {
    const root = await createWorkspace();
    await writeFile(path.join(root, "src", "binary.dat"), Buffer.from([0, 1, 2, 3]));
    const tool = new GrepFilesTool();

    const result = await tool.run({
      root: "src",
      pattern: "helper",
      glob: "*.dat",
    }, createRunContext(tool, root));

    expect(result).toMatchObject({
      details: {
        root: "src",
        glob: "*.dat",
        matches: [],
        skippedFileCount: 1,
        skippedDirectories: expect.arrayContaining(["node_modules"]),
        skippedFiles: [{
          path: "src/binary.dat",
          reason: "File appears to be binary: src/binary.dat",
        }],
      },
    });
    expect(JSON.stringify(result)).toContain("Skipped unreadable files: 1");
    expect(JSON.stringify(result)).toContain("src/binary.dat");
  });
});
