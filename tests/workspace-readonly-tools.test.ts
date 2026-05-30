import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {
    Agent,
    type DefaultAgentSessionContext,
    GlobFilesTool,
    GrepFilesTool,
    ReadFileTool,
    RunContext,
    Thread,
    ToolError,
    type Tool,
} from "../src/index.js";

function createRunContext(tool: Tool, cwd: string): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "panda",
      instructions: "Inspect files.",
      tools: [tool],
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
  const root = await mkdtemp(path.join(tmpdir(), "runtime-readonly-tools-"));
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

  it("reports a missing read_file path as a recoverable tool error", async () => {
    const root = await createWorkspace();
    const tool = new ReadFileTool();

    const promise = tool.run({
      path: "src/missing.ts",
    }, createRunContext(tool, root));

    await expect(promise).rejects.toMatchObject({
      message: "Path does not exist: src/missing.ts",
      details: {path: "src/missing.ts"},
    });
    await expect(promise).rejects.toBeInstanceOf(ToolError);
  });

  it("reports a path below a file as a missing read_file path", async () => {
    const root = await createWorkspace();
    const tool = new ReadFileTool();

    const promise = tool.run({
      path: "src/main.ts/child",
    }, createRunContext(tool, root));

    await expect(promise).rejects.toMatchObject({
      message: "Path does not exist: src/main.ts/child",
      details: {path: "src/main.ts/child"},
    });
    await expect(promise).rejects.toBeInstanceOf(ToolError);
  });

  it("converts paths below files into model-visible thread tool errors", async () => {
    const root = await createWorkspace();
    const tool = new ReadFileTool();
    const agent = new Agent({
      name: "panda",
      instructions: "Inspect files.",
      tools: [tool],
    });
    const context: DefaultAgentSessionContext = {
      cwd: root,
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    };
    const thread = new Thread<DefaultAgentSessionContext>({agent, context});

    const result = await thread.callTool({
      type: "toolCall",
      id: "call-read-child-of-file",
      name: "read_file",
      arguments: {path: "src/main.ts/child"},
    }, createRunContext(tool, root));

    expect(result).toMatchObject({
      role: "toolResult",
      toolCallId: "call-read-child-of-file",
      toolName: "read_file",
      isError: true,
      details: {path: "src/main.ts/child"},
    });
    expect(JSON.stringify(result.content)).toContain("Path does not exist: src/main.ts/child");
  });

  it("converts missing read_file paths into model-visible thread tool errors", async () => {
    const root = await createWorkspace();
    const tool = new ReadFileTool();
    const agent = new Agent({
      name: "panda",
      instructions: "Inspect files.",
      tools: [tool],
    });
    const context: DefaultAgentSessionContext = {
      cwd: root,
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    };
    const thread = new Thread<DefaultAgentSessionContext>({agent, context});

    const result = await thread.callTool({
      type: "toolCall",
      id: "call-read-missing",
      name: "read_file",
      arguments: {path: "src/missing.ts"},
    }, createRunContext(tool, root));

    expect(result).toMatchObject({
      role: "toolResult",
      toolCallId: "call-read-missing",
      toolName: "read_file",
      isError: true,
      details: {path: "src/missing.ts"},
    });
    expect(JSON.stringify(result.content)).toContain("Path does not exist: src/missing.ts");
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
