import {rm} from "node:fs/promises";

import {type JsonObject} from "../../kernel/agent/types.js";
import {createOutputCapture, finalizeOutputCapture} from "./bash-output.js";
import {runWrappedBashCommand} from "./bash-process.js";
import type {BashExecutionResult} from "./bash-protocol.js";
import {buildWrappedCommand, createInvocationPaths, readPersistedCwd, readPersistedEnv,} from "./bash-session.js";

export interface ExecuteBashCommandOptions {
  command: string;
  cwd: string;
  childEnv: NodeJS.ProcessEnv;
  shell: string;
  timeoutMs: number;
  trackedEnvKeys: string[];
  maxOutputChars: number;
  persistOutputThresholdChars: number;
  progressIntervalMs: number;
  progressTailChars: number;
  outputDirectory: string;
  persistOutputFiles?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: JsonObject) => void;
}

export interface ExecuteBashCommandOutcome {
  result: BashExecutionResult;
  spawnErrorMessage?: string;
  spawnErrorDetails?: JsonObject;
}

export async function executeBashCommand(options: ExecuteBashCommandOptions): Promise<ExecuteBashCommandOutcome> {
  const invocationPaths = await createInvocationPaths(options.outputDirectory);
  const wrappedCommand = buildWrappedCommand({
    command: options.command,
    cwdStatePath: invocationPaths.cwdStatePath,
    envStatePath: invocationPaths.envStatePath,
    trackedEnvKeys: options.trackedEnvKeys,
  });
  const stdoutCapture = createOutputCapture(invocationPaths.stdoutPath);
  const stderrCapture = createOutputCapture(invocationPaths.stderrPath);

  const processResult = await runWrappedBashCommand({
    command: options.command,
    shell: options.shell,
    cwd: options.cwd,
    childEnv: options.childEnv,
    wrappedCommand,
    timeoutMs: options.timeoutMs,
    progressIntervalMs: options.progressIntervalMs,
    progressTailChars: options.progressTailChars,
    maxOutputChars: options.maxOutputChars,
    stdoutCapture,
    stderrCapture,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  const timedOut = processResult.interruption === "timeout";
  const aborted = processResult.interruption === "abort";
  const interrupted = timedOut || aborted || (processResult.signal !== null && processResult.exitCode === null);
  const success = !interrupted && processResult.exitCode === 0;
  const finalCwd = success
    ? await readPersistedCwd(invocationPaths.cwdStatePath, options.cwd)
    : options.cwd;
  const persistedEnvEntries = success ? await readPersistedEnv(invocationPaths.envStatePath) : [];
  const persistOutputFiles = options.persistOutputFiles ?? true;
  const stdoutPath =
    persistOutputFiles && stdoutCapture.totalChars > options.persistOutputThresholdChars
      ? stdoutCapture.filePath
      : undefined;
  const stderrPath =
    persistOutputFiles && stderrCapture.totalChars > options.persistOutputThresholdChars
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

  const result: BashExecutionResult = {
    shell: options.shell,
    finalCwd,
    durationMs: processResult.durationMs,
    timeoutMs: options.timeoutMs,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    timedOut,
    aborted,
    abortReason: processResult.abortReason,
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
    trackedEnvKeys: options.trackedEnvKeys,
    persistedEnvEntries,
    ...(stdoutPath ? { stdoutPath } : {}),
    ...(stderrPath ? { stderrPath } : {}),
  };

  if (!processResult.spawnError) {
    return { result };
  }

  const spawnErrorDetails: JsonObject = {
    command: options.command,
    cwd: options.cwd,
    shell: options.shell,
    durationMs: processResult.durationMs,
    error: processResult.spawnError.message,
  };

  return {
    result,
    spawnErrorMessage: processResult.spawnError.message,
    spawnErrorDetails,
  };
}
