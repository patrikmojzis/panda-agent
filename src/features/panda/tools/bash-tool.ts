import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { z } from "zod";

import type { RunContext } from "../../agent-core/run-context.js";
import { Tool, type ToolOutput } from "../../agent-core/tool.js";
import { ToolError } from "../../agent-core/exceptions.js";
import type { JsonObject, JsonValue } from "../../agent-core/types.js";
import type { PandaSessionContext, PandaShellSession } from "../types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const DEFAULT_PROGRESS_TAIL_CHARS = 1_200;
const DEFAULT_OUTPUT_DIRECTORY = path.join(tmpdir(), "panda-tool-results");

const SILENT_COMMANDS = new Set([
  "cd",
  "cp",
  "chmod",
  "chown",
  "export",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "touch",
  "unset",
]);

export interface BashToolOptions {
  shell?: string;
  defaultTimeoutMs?: number;
  maxOutputChars?: number;
  persistOutputThresholdChars?: number;
  progressIntervalMs?: number;
  progressTailChars?: number;
  outputDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

interface CapturedOutput {
  value: string;
  truncated: boolean;
}

interface OutputCaptureState {
  preview: string;
  previewTruncated: boolean;
  totalChars: number;
  writer: WriteStream;
  filePath: string;
}

interface InvocationPaths {
  directory: string;
  cwdStatePath: string;
  envStatePath: string;
  stdoutPath: string;
  stderrPath: string;
}

interface PersistedEnvEntry {
  key: string;
  present: boolean;
  value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appendChunk(current: string, chunk: string, maxChars: number): CapturedOutput {
  if (current.length >= maxChars) {
    return {
      value: current,
      truncated: true,
    };
  }

  const remaining = maxChars - current.length;
  if (chunk.length <= remaining) {
    return {
      value: current + chunk,
      truncated: false,
    };
  }

  return {
    value: current + chunk.slice(0, remaining),
    truncated: true,
  };
}

function tailString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(-maxChars);
}

function ensureShellSession(context: unknown): PandaShellSession | null {
  if (!isRecord(context)) {
    return null;
  }

  const shell = context.shell;
  if (isRecord(shell) && typeof shell.cwd === "string") {
    const shellSession = shell as unknown as PandaShellSession;
    shellSession.cwd = path.resolve(shellSession.cwd);

    if (!isRecord(shellSession.env)) {
      shellSession.env = {};
    } else {
      for (const [key, value] of Object.entries(shellSession.env)) {
        if (typeof value !== "string") {
          delete shellSession.env[key];
        }
      }
    }

    return shellSession;
  }

  const nextShell: PandaShellSession = {
    cwd:
      typeof context.cwd === "string" && context.cwd.trim()
        ? path.resolve(context.cwd)
        : process.cwd(),
    env: {},
  };

  context.shell = nextShell;
  return nextShell;
}

function resolveBaseCwd(context: unknown): string {
  const shell = ensureShellSession(context);
  if (shell) {
    return path.resolve(shell.cwd);
  }

  if (isRecord(context) && typeof context.cwd === "string" && context.cwd.trim()) {
    return path.resolve(context.cwd);
  }

  return process.cwd();
}

function resolveCommandCwd(commandCwd: string | undefined, baseCwd: string): string {
  if (!commandCwd?.trim()) {
    return baseCwd;
  }

  return path.isAbsolute(commandCwd)
    ? path.resolve(commandCwd)
    : path.resolve(baseCwd, commandCwd);
}

function looksLikeSilentCommand(command: string): boolean {
  const match = command.trim().match(/^([A-Za-z0-9_.-]+)/);
  return match ? SILENT_COMMANDS.has(match[1] ?? "") : false;
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function consumeLeadingAssignment(body: string, start: number): { name: string; end: number } | null {
  const slice = body.slice(start);
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*=(?:'(?:[^']*)'|"(?:\\.|[^"])*"|[^ \t]+))?/.exec(slice);
  if (!match || !match[1]) {
    return null;
  }

  return {
    name: match[1],
    end: start + match[0].length,
  };
}

function parseExportNames(segment: string): string[] {
  const body = segment.replace(/^export\s+/, "").trim();
  if (!body || body.startsWith("-")) {
    return [];
  }

  const names: string[] = [];
  let index = 0;

  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index] ?? "")) {
      index += 1;
    }

    const parsed = consumeLeadingAssignment(body, index);
    if (!parsed) {
      break;
    }

    names.push(parsed.name);
    index = parsed.end;
  }

  return names;
}

function parseUnsetNames(segment: string): string[] {
  const body = segment.replace(/^unset\s+/, "").trim();
  if (!body || body.startsWith("-")) {
    return [];
  }

  const names: string[] = [];
  let index = 0;

  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index] ?? "")) {
      index += 1;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(body.slice(index));
    if (!match || !match[1]) {
      break;
    }

    names.push(match[1]);
    index += match[0].length;
  }

  return names;
}

function collectTrackedEnvKeys(command: string): string[] {
  const keys = new Set<string>();

  for (const segment of splitCommandSegments(command)) {
    if (segment.startsWith("export ")) {
      for (const name of parseExportNames(segment)) {
        keys.add(name);
      }
    }

    if (segment.startsWith("unset ")) {
      for (const name of parseUnsetNames(segment)) {
        keys.add(name);
      }
    }
  }

  return [...keys];
}

function buildWrappedCommand(options: {
  command: string;
  cwdStatePath: string;
  envStatePath: string;
  trackedEnvKeys: string[];
}): string {
  const lines = [
    options.command,
    "__panda_status=$?",
    'if [ "$__panda_status" -eq 0 ]; then',
    `  pwd -P >| ${shellQuote(options.cwdStatePath)}`,
  ];

  if (options.trackedEnvKeys.length > 0) {
    lines.push(`  : >| ${shellQuote(options.envStatePath)}`);

    for (const key of options.trackedEnvKeys) {
      const quotedKey = shellQuote(key);
      lines.push(`  if printenv ${quotedKey} >/dev/null 2>&1; then`);
      lines.push(
        `    printf '%s\\0present\\0%s\\0' ${quotedKey} "$(printenv ${quotedKey})" >> ${shellQuote(options.envStatePath)}`,
      );
      lines.push("  else");
      lines.push(
        `    printf '%s\\0absent\\0\\0' ${quotedKey} >> ${shellQuote(options.envStatePath)}`,
      );
      lines.push("  fi");
    }
  }

  lines.push("fi", 'exit "$__panda_status"');
  return lines.join("\n");
}

async function createInvocationPaths(rootDirectory: string): Promise<InvocationPaths> {
  const directory = path.join(rootDirectory, randomUUID());
  await mkdir(directory, { recursive: true });

  return {
    directory,
    cwdStatePath: path.join(directory, "cwd.txt"),
    envStatePath: path.join(directory, "env.bin"),
    stdoutPath: path.join(directory, "stdout.txt"),
    stderrPath: path.join(directory, "stderr.txt"),
  };
}

function createOutputCapture(filePath: string): OutputCaptureState {
  return {
    preview: "",
    previewTruncated: false,
    totalChars: 0,
    writer: createWriteStream(filePath, { encoding: "utf8" }),
    filePath,
  };
}

function appendOutput(capture: OutputCaptureState, chunk: string, previewLimit: number): void {
  capture.totalChars += chunk.length;
  const next = appendChunk(capture.preview, chunk, previewLimit);
  capture.preview = next.value;
  capture.previewTruncated ||= next.truncated;
  capture.writer.write(chunk);
}

async function finalizeOutputCapture(options: {
  capture: OutputCaptureState;
  keepFile: boolean;
}): Promise<void> {
  options.capture.writer.end();
  await finished(options.capture.writer);

  if (!options.keepFile) {
    await rm(options.capture.filePath, { force: true });
  }
}

async function readPersistedCwd(cwdStatePath: string, fallbackCwd: string): Promise<string> {
  try {
    const value = (await readFile(cwdStatePath, "utf8")).trim();
    return value ? path.resolve(value) : fallbackCwd;
  } catch {
    return fallbackCwd;
  }
}

function parsePersistedEnvDump(buffer: Buffer): PersistedEnvEntry[] {
  if (buffer.length === 0) {
    return [];
  }

  const parts = buffer.toString("utf8").split("\0");
  const entries: PersistedEnvEntry[] = [];

  for (let index = 0; index + 2 < parts.length; index += 3) {
    const key = parts[index];
    const state = parts[index + 1];
    const value = parts[index + 2];
    if (!key || !state) {
      continue;
    }

    entries.push({
      key,
      present: state === "present",
      value: value ?? "",
    });
  }

  return entries;
}

async function readPersistedEnv(envStatePath: string): Promise<PersistedEnvEntry[]> {
  try {
    const buffer = await readFile(envStatePath);
    return parsePersistedEnvDump(buffer);
  } catch {
    return [];
  }
}

function applyPersistedEnv(shellSession: PandaShellSession | null, entries: PersistedEnvEntry[]): string[] {
  if (!shellSession || entries.length === 0) {
    return [];
  }

  const changedKeys: string[] = [];
  for (const entry of entries) {
    if (entry.present) {
      shellSession.env[entry.key] = entry.value;
      changedKeys.push(entry.key);
      continue;
    }

    if (entry.key in shellSession.env) {
      delete shellSession.env[entry.key];
    }
    changedKeys.push(entry.key);
  }

  return changedKeys;
}

function buildProgressPayload(options: {
  command: string;
  cwd: string;
  startedAt: number;
  stdout: OutputCaptureState;
  stderr: OutputCaptureState;
  progressTailChars: number;
}): JsonObject {
  return {
    command: options.command,
    cwd: options.cwd,
    elapsedMs: Date.now() - options.startedAt,
    stdoutTail: tailString(options.stdout.preview, options.progressTailChars),
    stderrTail: tailString(options.stderr.preview, options.progressTailChars),
    stdoutChars: options.stdout.totalChars,
    stderrChars: options.stderr.totalChars,
  };
}

export class BashTool<TContext = PandaSessionContext> extends Tool<typeof BashTool.schema, TContext> {
  static schema = z.object({
    command: z.string().trim().min(1),
    cwd: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().min(100).max(300_000).optional(),
    env: z.record(z.string(), z.string()).optional(),
  });

  name = "bash";
  description =
    "Run a shell command in the local workspace. The working directory and simple export/unset environment changes persist across bash calls.";
  schema = BashTool.schema;

  private readonly shell?: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly persistOutputThresholdChars: number;
  private readonly progressIntervalMs: number;
  private readonly progressTailChars: number;
  private readonly outputDirectory: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: BashToolOptions = {}) {
    super();
    this.shell = options.shell;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.persistOutputThresholdChars =
      options.persistOutputThresholdChars ?? this.maxOutputChars;
    this.progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.progressTailChars = options.progressTailChars ?? DEFAULT_PROGRESS_TAIL_CHARS;
    this.outputDirectory = path.resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY);
    this.env = options.env ?? process.env;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.command === "string" ? args.command : super.formatCall(args);
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!isRecord(details)) {
      return super.formatResult(message);
    }

    const stdout = typeof details.stdout === "string" ? details.stdout.trim() : "";
    const stderr = typeof details.stderr === "string" ? details.stderr.trim() : "";
    const exitCode = typeof details.exitCode === "number" ? details.exitCode : "unknown";
    const status = details.timedOut === true ? "timed out" : `exit ${String(exitCode)}`;
    const shellSummary = [stdout, stderr].filter(Boolean).join("\n\n");
    const summary = shellSummary || "Command completed with no output.";

    return `${status}\n${summary}`;
  }

  async handle(
    args: z.output<typeof BashTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolOutput> {
    const startedAt = Date.now();
    const shellSession = ensureShellSession(run.context);
    const baseCwd = resolveBaseCwd(run.context);
    const cwd = resolveCommandCwd(args.cwd, baseCwd);
    const shell = this.shell ?? process.env.SHELL ?? "/bin/zsh";
    const timeoutMs = args.timeoutMs ?? this.defaultTimeoutMs;
    const trackedEnvKeys = collectTrackedEnvKeys(args.command);
    const invocationPaths = await createInvocationPaths(this.outputDirectory);
    const wrappedCommand = buildWrappedCommand({
      command: args.command,
      cwdStatePath: invocationPaths.cwdStatePath,
      envStatePath: invocationPaths.envStatePath,
      trackedEnvKeys,
    });

    const stdoutCapture = createOutputCapture(invocationPaths.stdoutPath);
    const stderrCapture = createOutputCapture(invocationPaths.stderrPath);
    const childEnv = {
      ...this.env,
      ...(shellSession?.env ?? {}),
      ...(args.env ?? {}),
    };

    let timedOut = false;
    let progressTimer: NodeJS.Timeout | undefined;
    let lastProgressAt = startedAt;
    let lastProgressStdoutChars = 0;
    let lastProgressStderrChars = 0;

    const emitProgress = (force = false): void => {
      const now = Date.now();
      const stdoutChanged = stdoutCapture.totalChars !== lastProgressStdoutChars;
      const stderrChanged = stderrCapture.totalChars !== lastProgressStderrChars;

      if (!force && !stdoutChanged && !stderrChanged && now - startedAt < this.progressIntervalMs * 2) {
        return;
      }

      if (!force && now - lastProgressAt < this.progressIntervalMs) {
        return;
      }

      run.emitToolProgress(
        buildProgressPayload({
          command: args.command,
          cwd,
          startedAt,
          stdout: stdoutCapture,
          stderr: stderrCapture,
          progressTailChars: this.progressTailChars,
        }),
      );

      lastProgressAt = now;
      lastProgressStdoutChars = stdoutCapture.totalChars;
      lastProgressStderrChars = stderrCapture.totalChars;
    };

    const result = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      spawnError?: Error;
    }>((resolve) => {
      const child = spawn(shell, ["-lc", wrappedCommand], {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");

        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 250).unref();
      }, timeoutMs);

      progressTimer = setInterval(() => {
        emitProgress();
      }, this.progressIntervalMs);
      progressTimer.unref();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        appendOutput(stdoutCapture, chunk, this.maxOutputChars);
        emitProgress();
      });

      child.stderr.on("data", (chunk: string) => {
        appendOutput(stderrCapture, chunk, this.maxOutputChars);
        emitProgress();
      });

      child.once("error", (error) => {
        clearTimeout(timeout);
        clearInterval(progressTimer);
        resolve({
          exitCode: null,
          signal: null,
          spawnError: error,
        });
      });

      child.once("close", (exitCode, signal) => {
        clearTimeout(timeout);
        clearInterval(progressTimer);
        resolve({
          exitCode,
          signal,
        });
      });
    });

    clearInterval(progressTimer);

    const durationMs = Date.now() - startedAt;
    const interrupted = timedOut || (result.signal !== null && result.exitCode === null);
    const success = !timedOut && result.exitCode === 0;
    const finalCwd = success
      ? await readPersistedCwd(invocationPaths.cwdStatePath, cwd)
      : cwd;
    const persistedEnvEntries = success ? await readPersistedEnv(invocationPaths.envStatePath) : [];
    const appliedSessionEnvKeys = applyPersistedEnv(shellSession, persistedEnvEntries);

    if (success && shellSession) {
      shellSession.cwd = finalCwd;

      if (isRecord(run.context)) {
        (run.context as Record<string, unknown>).cwd = finalCwd;
      }
    }
    const stdoutPath =
      stdoutCapture.totalChars > this.persistOutputThresholdChars
        ? stdoutCapture.filePath
        : undefined;
    const stderrPath =
      stderrCapture.totalChars > this.persistOutputThresholdChars
        ? stderrCapture.filePath
        : undefined;

    await Promise.all([
      finalizeOutputCapture({
        capture: stdoutCapture,
        keepFile: stdoutPath !== undefined,
      }),
      finalizeOutputCapture({
        capture: stderrCapture,
        keepFile: stderrPath !== undefined,
      }),
    ]);

    await rm(invocationPaths.cwdStatePath, { force: true });
    await rm(invocationPaths.envStatePath, { force: true });

    if (!stdoutPath && !stderrPath) {
      await rm(invocationPaths.directory, { recursive: true, force: true });
    }

    if (result.spawnError) {
      throw new ToolError(`Failed to spawn shell: ${result.spawnError.message}`, {
        details: {
          command: args.command,
          cwd,
          shell,
          durationMs,
          error: result.spawnError.message,
        },
      });
    }

    const payload: JsonObject = {
      command: args.command,
      cwd,
      initialCwd: cwd,
      finalCwd,
      cwdChanged: finalCwd !== cwd,
      shell,
      durationMs,
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut,
      interrupted,
      success,
      stdout: stdoutCapture.preview,
      stderr: stderrCapture.preview,
      stdoutTruncated: stdoutCapture.previewTruncated,
      stderrTruncated: stderrCapture.previewTruncated,
      stdoutChars: stdoutCapture.totalChars,
      stderrChars: stderrCapture.totalChars,
      stdoutPersisted: stdoutPath !== undefined,
      stderrPersisted: stderrPath !== undefined,
      noOutput: stdoutCapture.totalChars === 0 && stderrCapture.totalChars === 0,
      noOutputExpected: looksLikeSilentCommand(args.command),
      sessionEnvKeys: appliedSessionEnvKeys,
      sessionEnvChanged: appliedSessionEnvKeys.length > 0,
      appliedEnvKeys: Object.keys(args.env ?? {}),
      trackedEnvKeys,
      ...(stdoutPath ? { stdoutPath } : {}),
      ...(stderrPath ? { stderrPath } : {}),
    };

    if (timedOut) {
      throw new ToolError(`Command timed out after ${timeoutMs}ms`, { details: payload });
    }

    if (result.exitCode !== 0 || result.signal !== null) {
      const message = result.signal !== null
        ? `Command exited with signal ${result.signal}`
        : `Command exited with code ${String(result.exitCode)}`;
      throw new ToolError(message, { details: payload });
    }

    return payload;
  }
}
