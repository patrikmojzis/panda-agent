import { spawn } from "node:child_process";

import type { RunContext } from "../../agent-core/run-context.js";
import { appendOutput, tailString, type OutputCaptureState } from "./bash-output.js";

export interface BashProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
  interruption: "timeout" | "abort" | null;
  abortReason: string | null;
  durationMs: number;
}

export async function runWrappedBashCommand<TContext>(options: {
  command: string;
  shell: string;
  cwd: string;
  childEnv: NodeJS.ProcessEnv;
  wrappedCommand: string;
  timeoutMs: number;
  progressIntervalMs: number;
  progressTailChars: number;
  maxOutputChars: number;
  stdoutCapture: OutputCaptureState;
  stderrCapture: OutputCaptureState;
  run: RunContext<TContext>;
}): Promise<BashProcessResult> {
  const startedAt = Date.now();
  let interruption: "timeout" | "abort" | null = null;
  let abortReason: string | null = null;
  let progressTimer: NodeJS.Timeout | undefined;
  let lastProgressAt = startedAt;
  let lastProgressStdoutChars = 0;
  let lastProgressStderrChars = 0;

  const emitProgress = (force = false): void => {
    const now = Date.now();
    const stdoutChanged = options.stdoutCapture.totalChars !== lastProgressStdoutChars;
    const stderrChanged = options.stderrCapture.totalChars !== lastProgressStderrChars;

    if (!force && !stdoutChanged && !stderrChanged && now - startedAt < options.progressIntervalMs * 2) {
      return;
    }

    if (!force && now - lastProgressAt < options.progressIntervalMs) {
      return;
    }

    options.run.emitToolProgress({
      command: options.command,
      cwd: options.cwd,
      elapsedMs: Date.now() - startedAt,
      stdoutTail: tailString(options.stdoutCapture.preview, options.progressTailChars),
      stderrTail: tailString(options.stderrCapture.preview, options.progressTailChars),
      stdoutChars: options.stdoutCapture.totalChars,
      stderrChars: options.stderrCapture.totalChars,
    });

    lastProgressAt = now;
    lastProgressStdoutChars = options.stdoutCapture.totalChars;
    lastProgressStderrChars = options.stderrCapture.totalChars;
  };

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: Error;
  }>((resolve) => {
    const child = spawn(options.shell, ["-lc", options.wrappedCommand], {
      cwd: options.cwd,
      env: options.childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let abortKillTimer: NodeJS.Timeout | undefined;

    const killChild = (signal: NodeJS.Signals): boolean => {
      const pid = child.pid;
      if (!pid || child.exitCode !== null || child.signalCode !== null || child.killed) {
        return false;
      }

      try {
        if (process.platform !== "win32") {
          process.kill(-pid, signal);
        } else {
          child.kill(signal);
        }
        return true;
      } catch {
        return false;
      }
    };

    const abortHandler = (): void => {
      abortReason =
        options.run.signal?.reason instanceof Error
          ? options.run.signal.reason.message
          : typeof options.run.signal?.reason === "string"
            ? options.run.signal.reason
            : "Command aborted.";
      if (!killChild("SIGTERM")) {
        return;
      }

      interruption ??= "abort";
      abortKillTimer = setTimeout(() => {
        killChild("SIGKILL");
      }, 250);
      abortKillTimer.unref();
    };

    if (options.run.signal) {
      if (options.run.signal.aborted) {
        abortHandler();
      } else {
        options.run.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    const timeout = setTimeout(() => {
      if (!killChild("SIGTERM")) {
        return;
      }

      interruption ??= "timeout";
      setTimeout(() => {
        killChild("SIGKILL");
      }, 250).unref();
    }, options.timeoutMs);

    progressTimer = setInterval(() => {
      emitProgress();
    }, options.progressIntervalMs);
    progressTimer.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      appendOutput(options.stdoutCapture, chunk, options.maxOutputChars);
      emitProgress();
    });

    child.stderr.on("data", (chunk: string) => {
      appendOutput(options.stderrCapture, chunk, options.maxOutputChars);
      emitProgress();
    });

    child.once("error", (error) => {
      options.run.signal?.removeEventListener("abort", abortHandler);
      clearTimeout(abortKillTimer);
      clearTimeout(timeout);
      clearInterval(progressTimer);
      resolve({
        exitCode: null,
        signal: null,
        spawnError: error,
      });
    });

    child.once("close", (exitCode, signal) => {
      options.run.signal?.removeEventListener("abort", abortHandler);
      clearTimeout(abortKillTimer);
      clearTimeout(timeout);
      clearInterval(progressTimer);
      resolve({
        exitCode,
        signal,
      });
    });
  });

  clearInterval(progressTimer);

  return {
    ...result,
    interruption,
    abortReason,
    durationMs: Date.now() - startedAt,
  };
}
