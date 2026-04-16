import {readdir, readFile, stat} from "node:fs/promises";
import path from "node:path";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {formatToolResultFallback, Tool} from "../../kernel/agent/tool.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {JsonObject, JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {resolveContextPath} from "../../app/runtime/panda-path-context.js";

const DEFAULT_GLOB_LIMIT = 200;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_READ_MAX_LINES = 200;
const MAX_TEXT_FILE_BYTES = 512_000;
const MAX_SKIPPED_FILE_SAMPLES = 20;
const DEFAULT_SKIPPED_DIRECTORY_NAMES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
];
const SKIPPED_DIRECTORY_NAMES = new Set(DEFAULT_SKIPPED_DIRECTORY_NAMES);

const utf8Decoder = new TextDecoder("utf-8", {fatal: true});

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ToolError("Tool execution aborted.");
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function resolveWorkspaceRoot(context: unknown): string {
  return resolveContextPath(".", context);
}

function formatDisplayPath(targetPath: string, context: unknown): string {
  const workspaceRoot = resolveWorkspaceRoot(context);
  const relativePath = path.relative(workspaceRoot, targetPath);
  if (!relativePath) {
    return ".";
  }
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return targetPath;
  }
  return toPosixPath(relativePath);
}

function decodeUtf8File(bytes: Buffer, filePath: string): string {
  if (bytes.length > MAX_TEXT_FILE_BYTES) {
    throw new ToolError(
      `File is too large to inspect safely (${String(bytes.length)} bytes). Narrow the request or pick a smaller file.`,
      {details: {path: filePath, bytes: bytes.length}},
    );
  }

  if (bytes.includes(0)) {
    throw new ToolError(`File appears to be binary: ${filePath}`);
  }

  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new ToolError(`File is not valid UTF-8 text: ${filePath}`);
  }
}

async function readTextFile(filePath: string, displayPath = filePath): Promise<string> {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) {
    throw new ToolError(`Path is not a file: ${displayPath}`);
  }

  const bytes = await readFile(filePath);
  return decodeUtf8File(bytes, displayPath);
}

function buildLineSliceText(args: {
  path: string;
  lines: readonly string[];
  startLine: number;
  totalLines: number;
  truncated: boolean;
}): string {
  const endLine = args.startLine + args.lines.length - 1;
  const numberedLines = args.lines.map((line, index) => `${String(args.startLine + index)} | ${line}`);
  const header = [
    `Path: ${args.path}`,
    `Lines: ${String(args.startLine)}-${String(endLine)} of ${String(args.totalLines)}`,
  ];
  if (args.truncated) {
    header.push("Truncated: true");
  }
  return [...header, "", ...numberedLines].join("\n").trim();
}

function matchesGlob(filePath: string, pattern: string): boolean {
  return path.matchesGlob(toPosixPath(filePath), toPosixPath(pattern));
}

function formatRootRelativePath(rootPath: string, targetPath: string): string {
  const relativePath = path.relative(rootPath, targetPath);
  if (!relativePath) {
    return path.basename(targetPath);
  }
  return toPosixPath(relativePath);
}

function matchesSearchPattern(
  filePath: string,
  pattern: string,
  args: {
    rootPath: string;
    context: unknown;
  },
): boolean {
  const workspacePath = formatDisplayPath(filePath, args.context);
  const rootRelativePath = formatRootRelativePath(args.rootPath, filePath);
  // Accept both root-relative and workspace-relative patterns so the agent does not have to guess.
  return matchesGlob(rootRelativePath, pattern) || matchesGlob(workspacePath, pattern);
}

function buildSearchHeader(args: {
  root: string;
  pattern: string;
  glob?: string;
  literal?: boolean;
  skippedFileCount?: number;
}): string {
  const lines = [
    `Root: ${args.root}`,
    `${args.literal ? "Literal" : "Pattern"}: ${args.pattern}`,
    ...(args.glob ? [`Glob: ${args.glob}`] : []),
    `Default skipped directories: ${DEFAULT_SKIPPED_DIRECTORY_NAMES.join(", ")}`,
  ];

  if (args.skippedFileCount && args.skippedFileCount > 0) {
    lines.push(`Skipped unreadable files: ${String(args.skippedFileCount)}`);
  }

  return `${lines.join("\n")}\n`;
}

function buildSkippedFileSampleText(
  skippedFiles: readonly {path: string; reason: string}[],
): string {
  if (skippedFiles.length === 0) {
    return "";
  }

  return [
    "Skipped file samples:",
    ...skippedFiles.map((entry) => `- ${entry.path}: ${entry.reason}`),
  ].join("\n");
}

async function visitFiles(
  rootPath: string,
  signal: AbortSignal | undefined,
  visit: (filePath: string) => Promise<boolean>,
): Promise<void> {
  const rootStats = await stat(rootPath);
  if (rootStats.isFile()) {
    await visit(rootPath);
    return;
  }

  if (!rootStats.isDirectory()) {
    throw new ToolError(`Path is neither a file nor directory: ${rootPath}`);
  }

  const stack = [rootPath];
  while (stack.length > 0) {
    throwIfAborted(signal);
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await readdir(currentDir, {withFileTypes: true});
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }
        stack.push(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const shouldStop = await visit(entryPath);
      if (shouldStop) {
        return;
      }
    }
  }
}

function buildMatchText(matches: readonly {path: string; line: number; text: string}[]): string {
  if (matches.length === 0) {
    return "No matches.";
  }
  return matches.map((match) => `${match.path}:${String(match.line)}: ${match.text}`).join("\n");
}

export class ReadFileTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof ReadFileTool.schema, TContext> {
  static schema = z.object({
    path: z.string().trim().min(1).describe("Path to the text file to inspect."),
    startLine: z.number().int().min(1).optional().describe("1-based line number to start from."),
    maxLines: z.number().int().min(1).max(500).optional().describe("Maximum number of lines to return."),
  });

  name = "read_file";
  description =
    "Read a local UTF-8 text file with line numbers. Use this instead of bash cat/head/tail for workspace inspection.";
  schema = ReadFileTool.schema;

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.path === "string" ? args.path : super.formatCall(args);
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return formatToolResultFallback(message);
    }

    const filePath = typeof details.path === "string" ? details.path : "file";
    const startLine = typeof details.startLine === "number" ? details.startLine : 1;
    const endLine = typeof details.endLine === "number" ? details.endLine : startLine;
    const truncated = details.truncated === true ? " · truncated" : "";
    return `${filePath} · lines ${String(startLine)}-${String(endLine)}${truncated}`;
  }

  async handle(
    args: z.output<typeof ReadFileTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const resolvedPath = resolveContextPath(args.path, run.context);
    const displayPath = formatDisplayPath(resolvedPath, run.context);
    const startLine = args.startLine ?? 1;
    const maxLines = args.maxLines ?? DEFAULT_READ_MAX_LINES;
    const fileText = await readTextFile(resolvedPath, displayPath);
    const lines = fileText.split(/\r?\n/);
    const startIndex = Math.max(0, startLine - 1);
    const slicedLines = lines.slice(startIndex, startIndex + maxLines);
    if (startIndex >= lines.length) {
      throw new ToolError(`startLine ${String(startLine)} is past the end of ${displayPath}.`, {
        details: {
          path: displayPath,
          totalLines: lines.length,
        },
      });
    }

    const endLine = startLine + slicedLines.length - 1;
    const truncated = endLine < lines.length;
    const details = {
      path: displayPath,
      startLine,
      endLine,
      totalLines: lines.length,
      truncated,
    } satisfies JsonObject;

    return {
      content: [{
        type: "text",
        text: buildLineSliceText({
          path: displayPath,
          lines: slicedLines,
          startLine,
          totalLines: lines.length,
          truncated,
        }),
      }],
      details,
    };
  }
}

export class GlobFilesTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof GlobFilesTool.schema, TContext> {
  static schema = z.object({
    pattern: z.string().trim().min(1).describe("Glob pattern like src/**/*.ts or **/*.md."),
    root: z.string().trim().min(1).optional().describe("Optional directory or file path to search from."),
    limit: z.number().int().min(1).max(500).optional().describe("Maximum number of matches to return."),
  });

  name = "glob_files";
  description =
    "Find local files by glob pattern without shell access. Patterns may be workspace-relative or relative to root. Returns workspace-relative paths.";
  schema = GlobFilesTool.schema;

  override formatCall(args: Record<string, unknown>): string {
    if (typeof args.pattern !== "string") {
      return super.formatCall(args);
    }
    return typeof args.root === "string" ? `${args.pattern} in ${args.root}` : args.pattern;
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return formatToolResultFallback(message);
    }

    const matchCount = Array.isArray(details.matches) ? details.matches.length : 0;
    const truncated = details.truncated === true ? " · truncated" : "";
    return `${String(matchCount)} file match${matchCount === 1 ? "" : "es"}${truncated}`;
  }

  async handle(
    args: z.output<typeof GlobFilesTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const rootPath = resolveContextPath(args.root ?? ".", run.context);
    const limit = args.limit ?? DEFAULT_GLOB_LIMIT;
    const matches: string[] = [];
    let truncated = false;

    await visitFiles(rootPath, run.signal, async (filePath) => {
      if (!matchesSearchPattern(filePath, args.pattern, {
        rootPath,
        context: run.context,
      })) {
        return false;
      }

      const displayPath = formatDisplayPath(filePath, run.context);
      matches.push(displayPath);
      if (matches.length >= limit) {
        truncated = true;
        return true;
      }
      return false;
    });

    const details = {
      root: formatDisplayPath(rootPath, run.context),
      pattern: args.pattern,
      matches,
      truncated,
      skippedDirectories: DEFAULT_SKIPPED_DIRECTORY_NAMES,
    } satisfies JsonObject;

    return {
      content: [{
        type: "text",
        text: [
          buildSearchHeader({
            root: formatDisplayPath(rootPath, run.context),
            pattern: args.pattern,
          }),
          matches.length > 0 ? matches.join("\n") : "No matches.",
        ].join("\n"),
      }],
      details,
    };
  }
}

export class GrepFilesTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof GrepFilesTool.schema, TContext> {
  static schema = z.object({
    pattern: z.string().trim().min(1).describe("Regex pattern to search for."),
    root: z.string().trim().min(1).optional().describe("Optional directory or file path to search from."),
    glob: z.string().trim().min(1).optional().describe("Optional glob filter for candidate files."),
    literal: z.boolean().optional().describe("Treat pattern as literal text instead of regex."),
    caseSensitive: z.boolean().optional().describe("Match with case sensitivity."),
    limit: z.number().int().min(1).max(500).optional().describe("Maximum number of matches to return."),
  });

  name = "grep_files";
  description =
    "Search local UTF-8 text files with regex or literal matching. The optional glob may be workspace-relative or relative to root. Returns matching lines with file paths and line numbers.";
  schema = GrepFilesTool.schema;

  override formatCall(args: Record<string, unknown>): string {
    if (typeof args.pattern !== "string") {
      return super.formatCall(args);
    }
    return typeof args.glob === "string" ? `${args.pattern} in ${args.glob}` : args.pattern;
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return formatToolResultFallback(message);
    }

    const matches = Array.isArray(details.matches) ? details.matches.length : 0;
    const truncated = details.truncated === true ? " · truncated" : "";
    return `${String(matches)} match${matches === 1 ? "" : "es"}${truncated}`;
  }

  async handle(
    args: z.output<typeof GrepFilesTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const rootPath = resolveContextPath(args.root ?? ".", run.context);
    const limit = args.limit ?? DEFAULT_GREP_LIMIT;
    const source = args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.pattern;
    const flags = args.caseSensitive ? "" : "i";
    let matcher: RegExp;

    try {
      matcher = new RegExp(source, flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid regex pattern.";
      throw new ToolError(`Invalid grep pattern: ${message}`);
    }

    const matches: Array<{path: string; line: number; text: string}> = [];
    const skippedFiles: Array<{path: string; reason: string}> = [];
    let skippedFileCount = 0;
    let truncated = false;

    await visitFiles(rootPath, run.signal, async (filePath) => {
      const displayPath = formatDisplayPath(filePath, run.context);
      if (args.glob && !matchesSearchPattern(filePath, args.glob, {
        rootPath,
        context: run.context,
      })) {
        return false;
      }

      let fileText: string;
      try {
        fileText = await readTextFile(filePath, displayPath);
      } catch (error) {
        if (error instanceof ToolError) {
          skippedFileCount += 1;
          if (skippedFiles.length < MAX_SKIPPED_FILE_SAMPLES) {
            skippedFiles.push({
              path: displayPath,
              reason: error.message,
            });
          }
          return false;
        }
        throw error;
      }

      const lines = fileText.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!matcher.test(line)) {
          continue;
        }

        matches.push({
          path: displayPath,
          line: index + 1,
          text: line,
        });

        if (matches.length >= limit) {
          truncated = true;
          return true;
        }
      }

      return false;
    });

    const details = {
      root: formatDisplayPath(rootPath, run.context),
      pattern: args.pattern,
      matches: matches.map((match) => ({
        path: match.path,
        line: match.line,
        text: match.text,
      }) satisfies JsonObject),
      skippedDirectories: DEFAULT_SKIPPED_DIRECTORY_NAMES,
      skippedFileCount,
      skippedFiles: skippedFiles.map((entry) => ({
        path: entry.path,
        reason: entry.reason,
      }) satisfies JsonObject),
      truncated,
      ...(args.glob ? {glob: args.glob} : {}),
    } satisfies JsonObject;

    return {
      content: [{
        type: "text",
        text: [
          buildSearchHeader({
            root: formatDisplayPath(rootPath, run.context),
            pattern: args.pattern,
            glob: args.glob,
            literal: args.literal,
            skippedFileCount,
          }),
          buildMatchText(matches),
          buildSkippedFileSampleText(skippedFiles),
        ].filter(Boolean).join("\n\n"),
      }],
      details,
    };
  }
}
