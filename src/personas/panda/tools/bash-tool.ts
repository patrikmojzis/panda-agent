import {tmpdir} from "node:os";
import path from "node:path";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../../kernel/agent/run-context.js";
import {Tool, type ToolOutput} from "../../../kernel/agent/tool.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {JsonObject, JsonValue} from "../../../kernel/agent/types.js";
import type {PandaSessionContext} from "../types.js";
import {ensurePandaShellSession, readPandaBaseCwd} from "./context.js";
import {
  type BashExecutionMode,
  type BashExecutor,
  createDefaultBashExecutor,
  resolveBashExecutionMode,
} from "../../../integrations/shell/bash-executor.js";
import {
  applyPersistedEnv,
  collectTrackedEnvKeys,
  resolveCommandCwd,
} from "../../../integrations/shell/bash-session.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const DEFAULT_PROGRESS_TAIL_CHARS = 1_200;
const DEFAULT_OUTPUT_DIRECTORY = path.join(tmpdir(), "panda-tool-results");

function readToolResultText(message: ToolResultMessage<JsonValue>): string {
  return message.content
    .flatMap((part) => part.type === "text" && part.text.trim() ? [part.text.trim()] : [])
    .join("\n\n")
    .trim();
}

function formatBashStatus(details: Record<string, unknown>): string {
  if (details.timedOut === true) {
    return "timed out";
  }

  if (details.aborted === true) {
    const reason = typeof details.abortReason === "string" ? details.abortReason.trim() : "";
    return reason ? `aborted\n${reason}` : "aborted";
  }

  if (typeof details.signal === "string" && details.signal.trim()) {
    return `signal ${details.signal}`;
  }

  if (typeof details.exitCode === "number") {
    return `exit ${String(details.exitCode)}`;
  }

  return "command failed";
}

export interface BashToolOptions {
  shell?: string;
  defaultTimeoutMs?: number;
  maxOutputChars?: number;
  persistOutputThresholdChars?: number;
  progressIntervalMs?: number;
  progressTailChars?: number;
  outputDirectory?: string;
  env?: NodeJS.ProcessEnv;
  executor?: BashExecutor;
  fetchImpl?: typeof fetch;
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
    "Run a shell command in the local workspace. The working directory persists across bash calls. In local mode, simple export/unset environment changes persist too. Remote mode does not accept env overrides.";
  schema = BashTool.schema;

  private readonly defaultTimeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly persistOutputThresholdChars: number;
  private readonly progressIntervalMs: number;
  private readonly progressTailChars: number;
  private readonly outputDirectory: string;
  private readonly executor: BashExecutor;
  private readonly executionMode: BashExecutionMode;

  constructor(options: BashToolOptions = {}) {
    super();
    const env = options.env ?? process.env;
    this.executionMode = resolveBashExecutionMode(env);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.persistOutputThresholdChars =
      options.persistOutputThresholdChars ?? this.maxOutputChars;
    this.progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.progressTailChars = options.progressTailChars ?? DEFAULT_PROGRESS_TAIL_CHARS;
    this.outputDirectory = path.resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY);
    this.executor = options.executor ?? createDefaultBashExecutor({
      shell: options.shell,
      env,
      fetchImpl: options.fetchImpl,
    });
  }

  override formatCall(args: Record<string, unknown>): string {
    if (typeof args.command !== "string") {
      return super.formatCall(args);
    }

    const cwd = typeof args.cwd === "string" && args.cwd.trim()
      ? args.cwd.trim()
      : null;
    return cwd ? `[cwd ${cwd}] ${args.command}` : args.command;
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    const text = readToolResultText(message);
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return text || super.formatResult(message);
    }

    const stdout = typeof details.stdout === "string" ? details.stdout.trim() : "";
    const stderr = typeof details.stderr === "string" ? details.stderr.trim() : "";
    if (message.isError) {
      const status = formatBashStatus(details);
      const shellSummary = [stderr, stdout].filter(Boolean).join("\n\n");
      const summary = shellSummary || text;
      return summary ? `${status}\n${summary}` : status;
    }

    const status = formatBashStatus(details);
    const shellSummary = [stdout, stderr].filter(Boolean).join("\n\n");
    const summary = shellSummary || text || "Command completed with no output.";

    return `${status}\n${summary}`;
  }

  async handle(
    args: z.output<typeof BashTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolOutput> {
    const shellSession = ensurePandaShellSession(run.context);
    const baseCwd = shellSession?.cwd ?? readPandaBaseCwd(run.context);
    const cwd = resolveCommandCwd(args.cwd, baseCwd);
    const timeoutMs = args.timeoutMs ?? this.defaultTimeoutMs;
    if (this.executionMode === "remote" && args.env && Object.keys(args.env).length > 0) {
      throw new ToolError("Remote bash does not accept env overrides.");
    }

    const trackedEnvKeys = this.executionMode === "remote"
      ? []
      : collectTrackedEnvKeys(args.command);
    const result = await this.executor.execute({
      command: args.command,
      cwd,
      timeoutMs,
      trackedEnvKeys,
      progressIntervalMs: this.progressIntervalMs,
      progressTailChars: this.progressTailChars,
      maxOutputChars: this.maxOutputChars,
      persistOutputThresholdChars: this.persistOutputThresholdChars,
      outputDirectory: this.outputDirectory,
      env: args.env,
      run: run as RunContext<PandaSessionContext>,
    });
    const appliedSessionEnvKeys = this.executionMode === "remote"
      ? []
      : applyPersistedEnv(shellSession, result.persistedEnvEntries);

    if (result.success && shellSession) {
      shellSession.cwd = result.finalCwd;

      if (run.context && typeof run.context === "object" && !Array.isArray(run.context)) {
        (run.context as Record<string, unknown>).cwd = result.finalCwd;
      }
    }

    const payload: JsonObject = {
      command: args.command,
      cwd,
      initialCwd: cwd,
      finalCwd: result.finalCwd,
      cwdChanged: result.finalCwd !== cwd,
      shell: result.shell,
      durationMs: result.durationMs,
      timeoutMs: result.timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      abortReason: result.abortReason,
      interrupted: result.interrupted,
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      stdoutChars: result.stdoutChars,
      stderrChars: result.stderrChars,
      stdoutPersisted: result.stdoutPersisted,
      stderrPersisted: result.stderrPersisted,
      noOutput: result.noOutput,
      sessionEnvKeys: appliedSessionEnvKeys,
      sessionEnvChanged: appliedSessionEnvKeys.length > 0,
      appliedEnvKeys: Object.keys(args.env ?? {}),
      trackedEnvKeys,
      ...(result.stdoutPath ? { stdoutPath: result.stdoutPath } : {}),
      ...(result.stderrPath ? { stderrPath: result.stderrPath } : {}),
    };

    if (result.timedOut) {
      throw new ToolError(`Command timed out after ${timeoutMs}ms`, { details: payload });
    }

    if (result.aborted) {
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
