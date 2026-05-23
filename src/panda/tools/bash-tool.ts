import {tmpdir} from "node:os";
import path from "node:path";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import {joinMessageTextParts} from "../../kernel/agent/helpers/message-text.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool, type ToolOutput} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject, JsonValue} from "../../lib/json.js";
import type {CredentialResolver} from "../../domain/credentials/resolver.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {ensureShellSession, readBaseCwd} from "../../app/runtime/panda-path-context.js";
import {
  type BashExecutor,
  createDefaultBashExecutor,
  LocalShellExecutor,
  RemoteShellExecutor,
} from "../../integrations/shell/bash-executor.js";
import {startBashBackgroundJob} from "../../integrations/shell/bash-background-runner.js";
import {sanitizeBashOutputPreview} from "../../integrations/shell/bash-output.js";
import {readThreadId} from "../../integrations/shell/runtime-context.js";
import {
  redactSecretsInJsonObject,
  redactSecretsInString,
} from "../../integrations/shell/redaction.js";
import {applyPersistedEnv, collectTrackedEnvKeys, resolveCommandCwd,} from "../../integrations/shell/bash-session.js";
import type {PersistedEnvEntry} from "../../integrations/shell/bash-protocol.js";
import type {ShellSession} from "../../integrations/shell/types.js";
import {uniqueTrimmedStrings} from "../../lib/strings.js";
import type {
  ExecutionCredentialPolicy,
  ResolvedExecutionEnvironment
} from "../../domain/execution-environments/types.js";
import {buildBackgroundJobPayload, formatBackgroundJobResult} from "./background-job-tools.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const DEFAULT_PROGRESS_TAIL_CHARS = 1_200;
const DEFAULT_OUTPUT_DIRECTORY = path.join(tmpdir(), "runtime-tool-results");

function readToolResultText(message: ToolResultMessage<JsonValue>): string {
  return joinMessageTextParts(message.content);
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

type BashSecretCandidateSource = "credential" | "session" | "call-env-key";

interface BashSecretCandidate {
  source: BashSecretCandidateSource;
  key: string;
  value: string;
}

interface BashSecretInventory {
  redactionValues: string[];
  hasSecretMaterial: boolean;
  sourceSecretValues: Set<string>;
}

function isSecretLikeEnvKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  if (!normalized || normalized.includes("PUBLIC_KEY") || normalized.startsWith("NEXT_PUBLIC_")) {
    return false;
  }

  return /(^|[_-])(SECRET|TOKEN|PASSWORD|PASSCODE|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH|BEARER|CREDENTIAL)([_-]|$)/.test(normalized);
}


function addSecretCandidate(
  candidates: BashSecretCandidate[],
  source: BashSecretCandidateSource,
  key: string,
  value: string,
): void {
  const trimmed = value.trim();
  if (!key.trim() || !trimmed) {
    return;
  }

  candidates.push({
    source,
    key,
    value: trimmed,
  });
}

function addEnvSecretCandidates(
  candidates: BashSecretCandidate[],
  source: BashSecretCandidateSource,
  env: Record<string, string> | undefined,
): void {
  if (!env) {
    return;
  }

  for (const [key, value] of Object.entries(env)) {
    addSecretCandidate(candidates, source, key, value);
  }
}

function buildBashSecretInventory(options: {
  resolvedCredentialEnv?: Record<string, string>;
  callEnv?: Record<string, string>;
  priorSecretSessionEnv?: Record<string, string>;
  currentSecretSessionEnv?: Record<string, string>;
}): BashSecretInventory {
  const candidates: BashSecretCandidate[] = [];
  addEnvSecretCandidates(candidates, "credential", options.resolvedCredentialEnv);
  addEnvSecretCandidates(candidates, "session", options.priorSecretSessionEnv);
  addEnvSecretCandidates(candidates, "session", options.currentSecretSessionEnv);

  for (const [key, value] of Object.entries(options.callEnv ?? {})) {
    if (isSecretLikeEnvKey(key)) {
      addSecretCandidate(candidates, "call-env-key", key, value);
    }
  }

  const sourceSecretValues = new Set(candidates.map((candidate) => candidate.value));
  const redactionValues = uniqueTrimmedStrings(
    candidates.map((candidate) => candidate.value),
  ).sort((left, right) => right.length - left.length);

  return {
    redactionValues,
    hasSecretMaterial: candidates.length > 0,
    sourceSecretValues,
  };
}

function readSecretSessionEnv(shellSession: ShellSession | null): Record<string, string> {
  if (!shellSession || !Array.isArray(shellSession.secretEnvKeys) || shellSession.secretEnvKeys.length === 0) {
    return {};
  }

  return Object.fromEntries(
    shellSession.secretEnvKeys.flatMap((key) => {
      const value = shellSession.env[key];
      return typeof value === "string" && value.length > 0 ? [[key, value]] : [];
    }),
  );
}

function updateSecretSessionKeys(
  shellSession: ShellSession | null,
  entries: readonly PersistedEnvEntry[],
  sourceSecretValues: ReadonlySet<string>,
): void {
  if (!shellSession) {
    return;
  }

  const nextSecretKeys = new Set(shellSession.secretEnvKeys ?? []);

  for (const entry of entries) {
    if (!entry.present) {
      nextSecretKeys.delete(entry.key);
      continue;
    }

    if (isSecretLikeEnvKey(entry.key) || sourceSecretValues.has(entry.value) || sourceSecretValues.has(entry.value.trim())) {
      nextSecretKeys.add(entry.key);
      continue;
    }

    nextSecretKeys.delete(entry.key);
  }

  shellSession.secretEnvKeys = [...nextSecretKeys];
}

function filterCredentialEnv(
  env: Record<string, string>,
  policy: ExecutionCredentialPolicy | undefined,
): Record<string, string> {
  if (!policy || policy.mode === "all_agent") {
    return env;
  }
  if (policy.mode === "none") {
    return {};
  }

  const allowed = new Set(policy.envKeys);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key)));
}

function assertBashAllowed(executionEnvironment: ResolvedExecutionEnvironment | undefined): void {
  if (executionEnvironment?.toolPolicy.bash?.allowed === false) {
    throw new ToolError("Bash is not allowed in this execution environment.");
  }
}


function sanitizeBashPayloadOutputFields(payload: JsonObject): JsonObject {
  const sanitized: JsonObject = {...payload};
  if (typeof payload.stdout === "string") {
    sanitized.stdout = sanitizeBashOutputPreview(payload.stdout);
  }
  if (typeof payload.stderr === "string") {
    sanitized.stderr = sanitizeBashOutputPreview(payload.stderr);
  }

  return sanitized;
}

type BashCredentialResolver = Pick<CredentialResolver, "resolveEnvironment">;

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
  credentialResolver?: BashCredentialResolver;
  jobService?: BackgroundToolJobService;
}

export class BashTool<TContext = DefaultAgentSessionContext> extends Tool<typeof BashTool.schema, TContext> {
  static schema = z.object({
    command: z.string().trim().min(1),
    cwd: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().min(100).max(300_000).optional(),
    env: z.record(z.string(), z.string()).optional(),
    background: z.boolean().optional(),
  });

  name = "bash";
  description =
    "Run a shell command. Foreground bash mutates the shared shell cwd and simple export/unset env state across calls. Background bash starts an isolated snapshot job, returns immediately, never mutates the shared shell session, and may later surface as a machine-generated runtime event; use background_job_status, background_job_wait, and background_job_cancel for follow-up.";
  schema = BashTool.schema;

  private readonly defaultTimeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly persistOutputThresholdChars: number;
  private readonly progressIntervalMs: number;
  private readonly progressTailChars: number;
  private readonly outputDirectory: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly shell?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly executor?: BashExecutor;
  private readonly credentialResolver?: BashCredentialResolver;
  private readonly jobService?: BackgroundToolJobService;

  constructor(options: BashToolOptions = {}) {
    super();
    const env = options.env ?? process.env;
    this.env = env;
    this.shell = options.shell;
    this.fetchImpl = options.fetchImpl;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.persistOutputThresholdChars =
      options.persistOutputThresholdChars ?? this.maxOutputChars;
    this.progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.progressTailChars = options.progressTailChars ?? DEFAULT_PROGRESS_TAIL_CHARS;
    this.outputDirectory = path.resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY);
    this.credentialResolver = options.credentialResolver;
    this.jobService = options.jobService;
    this.executor = options.executor;
  }

  override formatCall(args: Record<string, unknown>): string {
    if (typeof args.command !== "string") {
      return super.formatCall(args);
    }

    const cwd = typeof args.cwd === "string" && args.cwd.trim()
      ? args.cwd.trim()
      : null;
    const scope = args.background === true ? "[background] " : "";
    return cwd ? `${scope}[cwd ${cwd}] ${args.command}` : `${scope}${args.command}`;
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    const text = readToolResultText(message);
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return text || super.formatResult(message);
    }

    if (details.kind === "bash" && typeof details.status === "string") {
      return formatBackgroundJobResult(message);
    }

    if (details.sessionStateIsolated === true && typeof details.status === "string") {
      return formatBackgroundJobResult(message);
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

  override redactCallArguments(args: Record<string, unknown>): Record<string, unknown> {
    if (!args.env || typeof args.env !== "object" || Array.isArray(args.env)) {
      return args;
    }

    const redactedEnv = Object.fromEntries(
      Object.keys(args.env).map((key) => [key, "[redacted]"]),
    );

    return {
      ...args,
      env: redactedEnv,
    };
  }

  async handle(
    args: z.output<typeof BashTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolOutput> {
    const context = run.context as DefaultAgentSessionContext | undefined;
    const executionEnvironment = context?.executionEnvironment;
    assertBashAllowed(executionEnvironment);
    const shellSession = ensureShellSession(run.context);
    const baseCwd = shellSession?.cwd ?? readBaseCwd(run.context);
    const cwd = resolveCommandCwd(args.cwd, baseCwd);
    const timeoutMs = args.timeoutMs ?? this.defaultTimeoutMs;
    const priorSecretSessionEnv = readSecretSessionEnv(shellSession);
    const resolvedCredentialEnv = filterCredentialEnv(this.credentialResolver
      ? await this.credentialResolver.resolveEnvironment({
        agentKey: typeof run.context === "object" && run.context !== null && "agentKey" in run.context
          ? (run.context as {agentKey?: string}).agentKey
          : undefined,
      })
      : {}, executionEnvironment?.credentialPolicy);
    const shellEnv = shellSession?.env ?? {};
    const secretInventory = buildBashSecretInventory({
      resolvedCredentialEnv,
      callEnv: args.env,
      priorSecretSessionEnv,
    });
    const trackedEnvKeys = collectTrackedEnvKeys(args.command);
    const exportsSecretLikeKey = trackedEnvKeys.some(isSecretLikeEnvKey);
    const persistOutputFiles = !secretInventory.hasSecretMaterial && !exportsSecretLikeKey;
    if (args.background === true) {
      if (!this.jobService) {
        throw new ToolError("Background bash is not available in this runtime.");
      }

      const job = await this.jobService.start({
        threadId: readThreadId(context),
        runId: context?.runId,
        kind: "bash",
        summary: redactSecretsInString(args.command, secretInventory.redactionValues),
        start: ({jobId}) => startBashBackgroundJob({
          jobId,
          command: args.command,
          cwd,
          timeoutMs,
          trackedEnvKeys,
          maxOutputChars: this.maxOutputChars,
          persistOutputThresholdChars: this.persistOutputThresholdChars,
          outputDirectory: this.outputDirectory,
          env: args.env,
          resolvedEnv: resolvedCredentialEnv,
          shellEnv,
          executionEnvironment,
          redactionValues: secretInventory.redactionValues,
          persistOutputFiles,
          context,
          processEnv: this.env,
          shell: this.shell,
          fetchImpl: this.fetchImpl,
        }),
      });

      return buildBackgroundJobPayload(job);
    }
    const result = await this.resolveExecutor(executionEnvironment).execute({
      command: args.command,
      cwd,
      timeoutMs,
      trackedEnvKeys,
      progressIntervalMs: this.progressIntervalMs,
      progressTailChars: this.progressTailChars,
      maxOutputChars: this.maxOutputChars,
      persistOutputThresholdChars: this.persistOutputThresholdChars,
      persistOutputFiles,
      redactionValues: secretInventory.redactionValues,
      outputDirectory: this.outputDirectory,
      env: args.env,
      resolvedEnv: resolvedCredentialEnv,
      shellEnv,
      executionEnvironment,
      run: run as RunContext<DefaultAgentSessionContext>,
    });
    const appliedSessionEnvKeys = applyPersistedEnv(shellSession, result.persistedEnvEntries);
    updateSecretSessionKeys(shellSession, result.persistedEnvEntries, secretInventory.sourceSecretValues);
    const resultSecretInventory = buildBashSecretInventory({
      resolvedCredentialEnv,
      callEnv: args.env,
      priorSecretSessionEnv,
      currentSecretSessionEnv: readSecretSessionEnv(shellSession),
    });

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
    const redactedPayload = resultSecretInventory.redactionValues.length > 0
      ? redactSecretsInJsonObject(payload, resultSecretInventory.redactionValues)
      : payload;
    const sanitizedPayload = sanitizeBashPayloadOutputFields(redactedPayload);

    if (result.timedOut) {
      throw new ToolError(`Command timed out after ${timeoutMs}ms`, { details: sanitizedPayload });
    }

    if (result.aborted) {
      throw new ToolError(result.abortReason ?? "Command aborted.", { details: sanitizedPayload });
    }

    if (result.exitCode !== 0 || result.signal !== null) {
      const message = result.signal !== null
        ? `Command exited with signal ${result.signal}`
        : `Command exited with code ${String(result.exitCode)}`;
      throw new ToolError(message, { details: sanitizedPayload });
    }

    return sanitizedPayload;
  }

  private resolveExecutor(executionEnvironment: ResolvedExecutionEnvironment | undefined): BashExecutor {
    if (this.executor) {
      return this.executor;
    }

    if (executionEnvironment?.executionMode === "local") {
      return new LocalShellExecutor({
        shell: this.shell,
        env: this.env,
      });
    }

    if (executionEnvironment?.executionMode === "remote") {
      return new RemoteShellExecutor({
        env: this.env,
        fetchImpl: this.fetchImpl,
      });
    }

    return createDefaultBashExecutor({
      shell: this.shell,
      env: this.env,
      fetchImpl: this.fetchImpl,
    });
  }
}
