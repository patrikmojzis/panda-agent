import {type ChildProcess, spawn} from "node:child_process";
import {rm} from "node:fs/promises";

import {createOutputCapture, finalizeOutputCapture, type OutputCaptureState} from "./bash-output.js";
import type {BashJobSnapshot} from "./bash-protocol.js";
import {buildWrappedCommand, createInvocationPaths, readPersistedCwd} from "./bash-session.js";

export interface ManagedBashJobOptions {
  jobId: string;
  command: string;
  cwd: string;
  childEnv: NodeJS.ProcessEnv;
  shell: string;
  timeoutMs: number;
  trackedEnvKeys: string[];
  maxOutputChars: number;
  persistOutputThresholdChars: number;
  persistOutputFiles?: boolean;
  outputDirectory: string;
}

type JobInterruption = "timeout" | "cancel" | null;

interface FinalizedJobState {
  snapshot: BashJobSnapshot;
}

function resolveTerminalStatus(options: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  interruption: JobInterruption;
}): BashJobSnapshot["status"] {
  if (options.interruption === "cancel") {
    return "cancelled";
  }

  if (options.interruption === "timeout") {
    return "failed";
  }

  if (options.exitCode === 0 && options.signal === null) {
    return "completed";
  }

  return "failed";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: () => T): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.resolve(fallback());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(fallback());
    }, timeoutMs);
    timer.unref();

    promise.then((value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

export class ManagedBashJob {
  static async start(options: ManagedBashJobOptions): Promise<ManagedBashJob> {
    const invocationPaths = await createInvocationPaths(options.outputDirectory);
    const stdoutCapture = createOutputCapture(invocationPaths.stdoutPath);
    const stderrCapture = createOutputCapture(invocationPaths.stderrPath);
    const wrappedCommand = buildWrappedCommand({
      command: options.command,
      cwdStatePath: invocationPaths.cwdStatePath,
      envStatePath: invocationPaths.envStatePath,
      trackedEnvKeys: options.trackedEnvKeys,
    });

    const job = new ManagedBashJob(options, invocationPaths, stdoutCapture, stderrCapture);
    try {
      await job.spawn(wrappedCommand);
      return job;
    } catch (error) {
      await job.cleanupFailedStart();
      throw error;
    }
  }

  private readonly startedAt = Date.now();
  private readonly donePromise: Promise<FinalizedJobState>;
  private resolveDone!: (value: FinalizedJobState) => void;
  private rejectDone!: (reason?: unknown) => void;
  private child: ChildProcess | null = null;
  private interruption: JobInterruption = null;
  private exitCode: number | null | undefined;
  private signal: NodeJS.Signals | null | undefined;
  private finalCwd: string | undefined;
  private finishedAt: number | undefined;
  private durationMs: number | undefined;
  private cleanupPromise: Promise<void> | null = null;
  private finalSnapshot: BashJobSnapshot | null = null;
  private stdoutPath: string | undefined;
  private stderrPath: string | undefined;

  private constructor(
    private readonly options: ManagedBashJobOptions,
    private readonly invocationPaths: Awaited<ReturnType<typeof createInvocationPaths>>,
    private readonly stdoutCapture: OutputCaptureState,
    private readonly stderrCapture: OutputCaptureState,
  ) {
    this.donePromise = new Promise<FinalizedJobState>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  private async spawn(wrappedCommand: string): Promise<void> {
    const child = spawn(this.options.shell, ["-lc", wrappedCommand], {
      cwd: this.options.cwd,
      env: this.options.childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;

    const started = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      this.stdoutCapture.totalChars += chunk.length;
      if (this.stdoutCapture.preview.length < this.options.maxOutputChars) {
        const remaining = this.options.maxOutputChars - this.stdoutCapture.preview.length;
        this.stdoutCapture.preview += chunk.slice(0, remaining);
        this.stdoutCapture.previewTruncated ||= chunk.length > remaining;
      } else {
        this.stdoutCapture.previewTruncated = true;
      }
      this.stdoutCapture.writer.write(chunk);
    });

    child.stderr?.on("data", (chunk: string) => {
      this.stderrCapture.totalChars += chunk.length;
      if (this.stderrCapture.preview.length < this.options.maxOutputChars) {
        const remaining = this.options.maxOutputChars - this.stderrCapture.preview.length;
        this.stderrCapture.preview += chunk.slice(0, remaining);
        this.stderrCapture.previewTruncated ||= chunk.length > remaining;
      } else {
        this.stderrCapture.previewTruncated = true;
      }
      this.stderrCapture.writer.write(chunk);
    });

    const timeoutTimer = setTimeout(() => {
      this.interruption ??= "timeout";
      this.kill("SIGTERM");
      setTimeout(() => {
        this.kill("SIGKILL");
      }, 250).unref();
    }, this.options.timeoutMs);
    timeoutTimer.unref();

    child.once("error", (error) => {
      clearTimeout(timeoutTimer);
      if (this.finishedAt !== undefined) {
        return;
      }

      this.finishedAt = Date.now();
      this.durationMs = this.finishedAt - this.startedAt;
      this.exitCode = null;
      this.signal = null;
      void this.finalize(undefined, error);
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timeoutTimer);
      this.finishedAt = Date.now();
      this.durationMs = this.finishedAt - this.startedAt;
      this.exitCode = exitCode;
      this.signal = signal;
      void this.finalize(signal === null && exitCode === 0 ? this.options.cwd : undefined);
    });

    await started;
  }

  private kill(signal: NodeJS.Signals): boolean {
    const child = this.child;
    const pid = child?.pid;
    if (!child || !pid || child.exitCode !== null || child.signalCode !== null || child.killed) {
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
  }

  private async finalize(successFallbackCwd: string | undefined, spawnError?: Error): Promise<void> {
    if (this.cleanupPromise) {
      await this.cleanupPromise;
      return;
    }

    this.cleanupPromise = (async () => {
      const success = !spawnError && this.interruption === null && this.exitCode === 0 && this.signal === null;
      this.finalCwd = success
        ? await readPersistedCwd(this.invocationPaths.cwdStatePath, successFallbackCwd ?? this.options.cwd)
        : undefined;

      const persistOutputFiles = this.options.persistOutputFiles ?? true;
      const stdoutPath = persistOutputFiles && this.stdoutCapture.totalChars > this.options.persistOutputThresholdChars
        ? this.stdoutCapture.filePath
        : undefined;
      const stderrPath = persistOutputFiles && this.stderrCapture.totalChars > this.options.persistOutputThresholdChars
        ? this.stderrCapture.filePath
        : undefined;
      this.stdoutPath = stdoutPath;
      this.stderrPath = stderrPath;

      await Promise.all([
        finalizeOutputCapture({
          capture: this.stdoutCapture,
          keepFile: stdoutPath !== undefined,
        }),
        finalizeOutputCapture({
          capture: this.stderrCapture,
          keepFile: stderrPath !== undefined,
        }),
      ]);

      await rm(this.invocationPaths.cwdStatePath, { force: true });
      await rm(this.invocationPaths.envStatePath, { force: true });

      if (!stdoutPath && !stderrPath) {
        await rm(this.invocationPaths.directory, { recursive: true, force: true });
      }

      const snapshot: BashJobSnapshot = {
        jobId: this.options.jobId,
        status: resolveTerminalStatus({
          exitCode: this.exitCode ?? null,
          signal: this.signal ?? null,
          interruption: this.interruption,
        }),
        command: this.options.command,
        initialCwd: this.options.cwd,
        startedAt: this.startedAt,
        timedOut: this.interruption === "timeout",
        stdout: this.stdoutCapture.preview,
        stderr: this.stderrCapture.preview,
        stdoutTruncated: this.stdoutCapture.previewTruncated,
        stderrTruncated: this.stderrCapture.previewTruncated,
        stdoutChars: this.stdoutCapture.totalChars,
        stderrChars: this.stderrCapture.totalChars,
        stdoutPersisted: this.stdoutPath !== undefined,
        stderrPersisted: this.stderrPath !== undefined,
        trackedEnvKeys: [...this.options.trackedEnvKeys],
        ...(this.finalCwd ? { finalCwd: this.finalCwd } : {}),
        ...(this.finishedAt !== undefined ? { finishedAt: this.finishedAt } : {}),
        ...(this.durationMs !== undefined ? { durationMs: this.durationMs } : {}),
        ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
        ...(this.signal !== undefined ? { signal: this.signal } : {}),
        ...(this.stdoutPath ? { stdoutPath: this.stdoutPath } : {}),
        ...(this.stderrPath ? { stderrPath: this.stderrPath } : {}),
      };

      this.finalSnapshot = snapshot;
      this.resolveDone({ snapshot });
    })();

    try {
      await this.cleanupPromise;
    } catch (error) {
      this.rejectDone(error);
      throw error;
    }
  }

  private async cleanupFailedStart(): Promise<void> {
    try {
      await Promise.all([
        finalizeOutputCapture({
          capture: this.stdoutCapture,
          keepFile: false,
        }),
        finalizeOutputCapture({
          capture: this.stderrCapture,
          keepFile: false,
        }),
      ]);
    } finally {
      await rm(this.invocationPaths.cwdStatePath, { force: true });
      await rm(this.invocationPaths.envStatePath, { force: true });
      await rm(this.invocationPaths.directory, { recursive: true, force: true });
    }
  }

  snapshot(): BashJobSnapshot {
    if (this.finalSnapshot) {
      return this.finalSnapshot;
    }

    return {
      jobId: this.options.jobId,
      status: "running",
      command: this.options.command,
      initialCwd: this.options.cwd,
      startedAt: this.startedAt,
      timedOut: false,
      stdout: this.stdoutCapture.preview,
      stderr: this.stderrCapture.preview,
      stdoutTruncated: this.stdoutCapture.previewTruncated,
      stderrTruncated: this.stderrCapture.previewTruncated,
      stdoutChars: this.stdoutCapture.totalChars,
      stderrChars: this.stderrCapture.totalChars,
      stdoutPersisted: false,
      stderrPersisted: false,
      trackedEnvKeys: [...this.options.trackedEnvKeys],
    };
  }

  async wait(timeoutMs = 15_000): Promise<BashJobSnapshot> {
    if (this.finalSnapshot) {
      return this.finalSnapshot;
    }

    const result = await withTimeout(this.donePromise, timeoutMs, () => ({ snapshot: this.snapshot() }));
    return result.snapshot;
  }

  async cancel(timeoutMs = 1_000): Promise<BashJobSnapshot> {
    if (this.finishedAt === undefined) {
      this.interruption ??= "cancel";
      if (this.kill("SIGTERM")) {
        setTimeout(() => {
          this.kill("SIGKILL");
        }, 250).unref();
      }
    }

    return this.wait(timeoutMs);
  }
}
