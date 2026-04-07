import { spawn } from "node:child_process";
import path from "node:path";

import { z } from "zod";

import { Tool } from "../../agent-core/tool.js";
import { ToolResponse } from "../../agent-core/tool-response.js";
import type { PandaSessionContext } from "../types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 8_000;

export interface BashToolOptions {
  shell?: string;
  defaultTimeoutMs?: number;
  maxOutputChars?: number;
  env?: NodeJS.ProcessEnv;
}

interface CapturedOutput {
  value: string;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveBaseCwd(context: unknown): string {
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

export class BashTool<TContext = PandaSessionContext> extends Tool<typeof BashTool.schema, TContext> {
  static schema = z.object({
    command: z.string().trim().min(1),
    cwd: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().min(100).max(300_000).optional(),
  });

  name = "bash";
  description =
    "Run a shell command in the local workspace and return stdout, stderr, exit code, and cwd. Prefer short, targeted commands.";
  schema = BashTool.schema;

  private readonly shell?: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: BashToolOptions = {}) {
    super();
    this.shell = options.shell;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.env = options.env ?? process.env;
  }

  async handle(args: z.output<typeof BashTool.schema>): Promise<ToolResponse> {
    const startedAt = Date.now();
    const baseCwd = resolveBaseCwd(this.runContext.context);
    const cwd = resolveCommandCwd(args.cwd, baseCwd);
    const shell = this.shell ?? process.env.SHELL ?? "/bin/zsh";
    const timeoutMs = args.timeoutMs ?? this.defaultTimeoutMs;

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const result = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      spawnError?: Error;
    }>((resolve) => {
      const child = spawn(shell, ["-lc", args.command], {
        cwd,
        env: this.env,
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

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        const next = appendChunk(stdout, chunk, this.maxOutputChars);
        stdout = next.value;
        stdoutTruncated ||= next.truncated;
      });

      child.stderr.on("data", (chunk: string) => {
        const next = appendChunk(stderr, chunk, this.maxOutputChars);
        stderr = next.value;
        stderrTruncated ||= next.truncated;
      });

      child.once("error", (error) => {
        clearTimeout(timeout);
        resolve({
          exitCode: null,
          signal: null,
          spawnError: error,
        });
      });

      child.once("close", (exitCode, signal) => {
        clearTimeout(timeout);
        resolve({
          exitCode,
          signal,
        });
      });
    });

    const durationMs = Date.now() - startedAt;

    if (result.spawnError) {
      return ToolResponse.error({
        command: args.command,
        cwd,
        shell,
        durationMs,
        error: result.spawnError.message,
      });
    }

    const payload = {
      command: args.command,
      cwd,
      shell,
      durationMs,
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
    };

    if (timedOut || result.exitCode !== 0) {
      return ToolResponse.error(payload);
    }

    return new ToolResponse({ output: payload });
  }
}
