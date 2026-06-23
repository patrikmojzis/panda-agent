import {mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
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


function bindTargetFilesystem(
  context: DefaultAgentSessionContext,
  targetRoot: string,
  toolPolicy: NonNullable<DefaultAgentSessionContext["executionEnvironment"]>["toolPolicy"] = {},
): DefaultAgentSessionContext {
  return {
    ...context,
    resolveExecutionTarget: async (target) => {
      if (target !== "vps") throw new Error("unknown target");
      return {
        id: "env-vps",
        agentKey: "panda",
        kind: "local",
        state: "ready",
        executionMode: "local",
        initialCwd: "/workspace",
        alias: "vps",
        rootPath: "/workspace",
        metadata: {
          filesystem: {
            envDir: "env-vps",
            root: {corePath: targetRoot, workerPath: "/workspace", parentRunnerPath: "/workspace"},
            workspace: {corePath: targetRoot, workerPath: "/workspace", parentRunnerPath: "/workspace"},
            inbox: {corePath: path.join(targetRoot, "inbox"), workerPath: "/inbox", parentRunnerPath: "/inbox"},
            artifacts: {corePath: path.join(targetRoot, "artifacts"), workerPath: "/artifacts", parentRunnerPath: "/artifacts"},
          },
        },
        credentialPolicy: {mode: "none"},
        skillPolicy: {mode: "none"},
        toolPolicy,
        source: "binding",
      };
    },
  };
}

function createRunContextWithContext(tool: Tool, context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "panda",
      instructions: "Inspect files.",
      tools: [tool],
    }),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

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

  it("routes read-only file tools through selected target filesystem metadata", async () => {
    const root = await createWorkspace();
    const targetRoot = await mkdtemp(path.join(tmpdir(), "runtime-readonly-target-"));
    tempDirs.push(targetRoot);
    await mkdir(path.join(targetRoot, "nested"), {recursive: true});
    await writeFile(path.join(targetRoot, "target.txt"), "hello from target\n");
    await writeFile(path.join(targetRoot, "nested", "match.ts"), "export const target = true;\n");
    const baseContext: DefaultAgentSessionContext = {
      cwd: root,
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    };
    const context = bindTargetFilesystem(baseContext, targetRoot, {
      allowedTools: ["read_file", "glob_files", "grep_files"],
    });

    const read = new ReadFileTool();
    const glob = new GlobFilesTool();
    const grep = new GrepFilesTool();

    await expect(read.run({path: "target.txt"}, createRunContextWithContext(read, baseContext)))
      .rejects.toThrow("Path does not exist: target.txt");

    await expect(read.run({path: "/workspace/target.txt", target: "vps"}, createRunContextWithContext(read, context)))
      .resolves.toMatchObject({
        details: {
          path: "target.txt",
          totalLines: 2,
        },
      });
    await expect(glob.run({root: "/workspace", pattern: "**/*.ts", target: "vps"}, createRunContextWithContext(glob, context)))
      .resolves.toMatchObject({
        details: {
          root: ".",
          matches: ["nested/match.ts"],
        },
      });
    await expect(grep.run({root: "/workspace", pattern: "export const", target: "vps"}, createRunContextWithContext(grep, context)))
      .resolves.toMatchObject({
        details: {
          root: ".",
          matches: [{path: "nested/match.ts", line: 1, text: "export const target = true;"}],
        },
      });
  });

  it("denies read-only tools when the selected target has no allowlist", async () => {
    const root = await createWorkspace();
    const targetRoot = await mkdtemp(path.join(tmpdir(), "runtime-readonly-target-denied-"));
    tempDirs.push(targetRoot);
    await writeFile(path.join(targetRoot, "target.txt"), "hello from target\n");
    const baseContext: DefaultAgentSessionContext = {
      cwd: root,
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    };
    const context = bindTargetFilesystem(baseContext, targetRoot);

    const read = new ReadFileTool();
    const glob = new GlobFilesTool();
    const grep = new GrepFilesTool();

    await expect(read.run({path: "/workspace/target.txt", target: "vps"}, createRunContextWithContext(read, context)))
      .rejects.toThrow("Tool read_file is not allowed in execution target vps.");
    await expect(glob.run({root: "/workspace", pattern: "**/*.txt", target: "vps"}, createRunContextWithContext(glob, context)))
      .rejects.toThrow("Tool glob_files is not allowed in execution target vps.");
    await expect(grep.run({root: "/workspace", pattern: "hello", target: "vps"}, createRunContextWithContext(grep, context)))
      .rejects.toThrow("Tool grep_files is not allowed in execution target vps.");
  });

  it("requires selected file targets to expose filesystem metadata", async () => {
    const root = await createWorkspace();
    const context: DefaultAgentSessionContext = {
      cwd: root,
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
      resolveExecutionTarget: async () => ({
        id: "env-vps",
        agentKey: "panda",
        kind: "persistent_agent_runner",
        state: "ready",
        executionMode: "remote",
        runnerUrl: "http://runner:8080",
        alias: "vps",
        credentialPolicy: {mode: "none"},
        skillPolicy: {mode: "none"},
        toolPolicy: {allowedTools: ["read_file"]},
        source: "binding",
      }),
    };
    const tool = new ReadFileTool();

    await expect(tool.run({path: "/workspace/file.txt", target: "vps"}, createRunContextWithContext(tool, context)))
      .rejects.toThrow("Execution target vps does not expose readable filesystem metadata.");
  });

  it("blocks selected target symlinks that escape the execution environment root", async () => {
    const root = await createWorkspace();
    const targetRoot = await mkdtemp(path.join(tmpdir(), "runtime-readonly-target-symlink-"));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "runtime-readonly-target-outside-"));
    tempDirs.push(targetRoot, outsideRoot);
    await writeFile(path.join(outsideRoot, "secret.txt"), "outside\n");
    await symlink(path.join(outsideRoot, "secret.txt"), path.join(targetRoot, "escape.txt"));
    const context = bindTargetFilesystem({
      cwd: root,
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    }, targetRoot, {allowedTools: ["read_file"]});
    const tool = new ReadFileTool();

    await expect(tool.run({path: "/workspace/escape.txt", target: "vps"}, createRunContextWithContext(tool, context)))
      .rejects.toThrow("Resolved path escapes the execution environment root: /workspace/escape.txt");
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

  it("converts missing glob_files roots into model-visible thread tool errors", async () => {
    const root = await createWorkspace();
    const tool = new GlobFilesTool();
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
      id: "call-glob-missing-root",
      name: "glob_files",
      arguments: {root: "src/missing-root", pattern: "**/*.ts"},
    }, createRunContext(tool, root));

    expect(result).toMatchObject({
      role: "toolResult",
      toolCallId: "call-glob-missing-root",
      toolName: "glob_files",
      isError: true,
      details: {path: "src/missing-root"},
    });
    expect(JSON.stringify(result.content)).toContain("Path does not exist: src/missing-root");
    expect(JSON.stringify(result.content)).not.toContain("ENOENT");
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

  it("converts missing grep_files roots into model-visible thread tool errors", async () => {
    const root = await createWorkspace();
    const tool = new GrepFilesTool();
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
      id: "call-grep-missing-root",
      name: "grep_files",
      arguments: {root: "src/missing-root", pattern: "helper"},
    }, createRunContext(tool, root));

    expect(result).toMatchObject({
      role: "toolResult",
      toolCallId: "call-grep-missing-root",
      toolName: "grep_files",
      isError: true,
      details: {path: "src/missing-root"},
    });
    expect(JSON.stringify(result.content)).toContain("Path does not exist: src/missing-root");
    expect(JSON.stringify(result.content)).not.toContain("ENOENT");
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
