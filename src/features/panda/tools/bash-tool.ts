import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { z } from "zod";

import type { RunContext } from "../../agent-core/run-context.js";
import { Tool, type ToolOutput } from "../../agent-core/tool.js";
import { ToolError } from "../../agent-core/exceptions.js";
import type { JsonObject, JsonValue } from "../../agent-core/types.js";
import type { PandaSessionContext } from "../types.js";
import { runWrappedBashCommand } from "./bash-process.js";
import {
  createOutputCapture,
  finalizeOutputCapture,
} from "./bash-output.js";
import {
  applyPersistedEnv,
  buildWrappedCommand,
  collectTrackedEnvKeys,
  createInvocationPaths,
  looksLikeSilentCommand,
  readPersistedCwd,
  readPersistedEnv,
  resolveCommandCwd,
} from "./bash-session.js";
import { ensurePandaShellSession, readPandaBaseCwd } from "./context.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const DEFAULT_PROGRESS_TAIL_CHARS = 1_200;
const DEFAULT_OUTPUT_DIRECTORY = path.join(tmpdir(), "panda-tool-results");

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
    if (!details || typeof details !== "object" || Array.isArray(details)) {
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
    const shellSession = ensurePandaShellSession(run.context);
    const baseCwd = shellSession?.cwd ?? readPandaBaseCwd(run.context);
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

    const result = await runWrappedBashCommand({
      command: args.command,
      shell,
      cwd,
      childEnv,
      wrappedCommand,
      timeoutMs,
      progressIntervalMs: this.progressIntervalMs,
      progressTailChars: this.progressTailChars,
      maxOutputChars: this.maxOutputChars,
      stdoutCapture,
      stderrCapture,
      run,
    });

    const timedOut = result.interruption === "timeout";
    const aborted = result.interruption === "abort";
    const interrupted = timedOut || aborted || (result.signal !== null && result.exitCode === null);
    const success = !interrupted && result.exitCode === 0;
    const finalCwd = success
      ? await readPersistedCwd(invocationPaths.cwdStatePath, cwd)
      : cwd;
    const persistedEnvEntries = success ? await readPersistedEnv(invocationPaths.envStatePath) : [];
    const appliedSessionEnvKeys = applyPersistedEnv(shellSession, persistedEnvEntries);

    if (success && shellSession) {
      shellSession.cwd = finalCwd;

      if (run.context && typeof run.context === "object" && !Array.isArray(run.context)) {
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
          durationMs: result.durationMs,
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
      durationMs: result.durationMs,
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut,
      aborted,
      abortReason: result.abortReason,
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

    if (aborted) {
      throw new ToolError(result.abortReason ?? "Command aborted.", { details: payload });
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
