import {randomUUID} from "node:crypto";
import {chmod, copyFile, mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import type {JsonObject, JsonValue} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {ExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/filesystem.js";
import {
  buildSetupMetadataPatch,
  SETUP_SCRIPT_INSPECTION_NOTE,
  SETUP_TOOL_NAMES,
  type ExecutionEnvironmentSetupScriptInput,
  type SetupToolName,
} from "../../domain/execution-environments/setup.js";
import {
  buildRunnerEndpoint,
  buildRunnerRequestHeaders,
  makeNetworkTimeoutSignal,
  readRunnerError,
  resolveRunnerSharedSecret,
} from "../../integrations/shell/bash-executor.js";
import type {BashExecutionResult, BashRunnerExecRequest} from "../../integrations/shell/bash-protocol.js";
import {parseBashRunnerExecResponse} from "../../integrations/shell/bash-protocol.js";
import {redactSecretsInString} from "../../integrations/shell/redaction.js";

const SETUP_TIMEOUT_MS = 300_000;
const SETUP_MAX_OUTPUT_CHARS = 512 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_OUTPUT_CHARS = 64 * 1024;
const FETCH_TIMEOUT_BUFFER_MS = 5_000;

export const TOOLCHAIN_PROBE_COMMAND = String.raw`set -euo pipefail
json_escape() {
  printf '%s' "$1" | awk 'BEGIN { ORS=""; tab=sprintf("%c", 9); cr=sprintf("%c", 13) }
  {
    gsub(/\\/, "\\\\")
    gsub(/"/, "\\\"")
    gsub(cr, "\\r")
    gsub(tab, "\\t")
    if (NR > 1) printf "\\n"
    printf "%s", $0
  }'
}
probe_tool() {
  name="$1"
  resolved_path="$(command -v "$name" 2>/dev/null || true)"
  if [ -z "$resolved_path" ]; then
    printf '"%s":{"status":"missing"}' "$name"
    return 0
  fi
  stderr_file="$(mktemp)"
  if ! version_output="$($name --version 2>"$stderr_file")"; then
    rm -f "$stderr_file"
    return 1
  fi
  version_stderr="$(cat "$stderr_file")"
  rm -f "$stderr_file"
  if [ -n "$version_stderr" ]; then
    return 1
  fi
  version="$(printf '%s\n' "$version_output" | awk 'NF { print; exit }')"
  if [ -z "$version" ]; then
    return 1
  fi
  case "$version" in
    '!'*|*'Corepack is about to download'*) return 1 ;;
  esac
  escaped_path="$(json_escape "$resolved_path")"
  escaped_version="$(json_escape "$version")"
  printf '"%s":{"status":"present","path":"%s","version":"%s"}' "$name" "$escaped_path" "$escaped_version"
}
printf '{"tools":{'
probe_tool node
printf ','
probe_tool pnpm
printf ','
probe_tool corepack
printf '}}\n'
`;

export interface EnvironmentSetupCredentialResolver {
  resolveEnvironment(context: {agentKey: string}): Promise<Record<string, string>>;
}

export interface ExecutionEnvironmentSetupRunnerInput {
  agentKey: string;
  environmentId: string;
  runnerUrl: string;
  runnerCwd: string;
  filesystem: ExecutionEnvironmentFilesystemMetadata;
  setupScript: ExecutionEnvironmentSetupScriptInput;
}

export interface ExecutionEnvironmentSetupRunner {
  runSetup(input: ExecutionEnvironmentSetupRunnerInput): Promise<JsonObject>;
}

interface SetupArtifactPaths {
  core: {
    dir: string;
    script: string;
    stdout: string;
    stderr: string;
    result: string;
    toolchain: string;
  };
  worker: {
    dir: string;
    script: string;
    stdout: string;
    stderr: string;
    result: string;
    toolchain: string;
  };
  parent?: {
    dir: string;
    script: string;
    stdout: string;
    stderr: string;
    result: string;
    toolchain: string;
  };
}

interface RemoteExecInput {
  agentKey: string;
  runnerUrl: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  env?: Record<string, string>;
}

interface SetupMetadataInput {
  status: "succeeded" | "failed";
  artifacts: SetupArtifactPaths;
  startedAt: number;
  finishedAt: number;
  setupResult?: BashExecutionResult;
  toolchain?: JsonObject;
  error?: string;
}

export interface ExecutionEnvironmentSetupRunnerOptions {
  credentialResolver?: EnvironmentSetupCredentialResolver | null;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function compactObject(values: Record<string, JsonValue | undefined>): JsonObject {
  const compacted: JsonObject = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function sortSecretValues(credentials: Record<string, string>): string[] {
  return [...new Set(Object.values(credentials).filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function redactErrorMessage(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecretsInString(message, secrets);
}

function buildArtifactPaths(filesystem: ExecutionEnvironmentFilesystemMetadata): SetupArtifactPaths {
  const workerArtifactsRoot = filesystem.artifacts.workerPath ?? "/artifacts";
  const workerDir = path.posix.join(workerArtifactsRoot, "setup");
  const coreDir = path.join(filesystem.artifacts.corePath, "setup");
  const buildSet = (dir: string, join: (dir: string, child: string) => string) => ({
    dir,
    script: join(dir, "setup.sh"),
    stdout: join(dir, "stdout.log"),
    stderr: join(dir, "stderr.log"),
    result: join(dir, "setup-result.json"),
    toolchain: join(dir, "toolchain.json"),
  });

  return {
    core: buildSet(coreDir, path.join),
    worker: buildSet(workerDir, path.posix.join),
    ...(filesystem.artifacts.parentRunnerPath
      ? {parent: buildSet(path.posix.join(filesystem.artifacts.parentRunnerPath, "setup"), path.posix.join)}
      : {}),
  };
}

function artifactMetadata(paths: SetupArtifactPaths): JsonObject {
  return compactObject({
    setupDir: paths.worker.dir,
    script: paths.worker.script,
    stdout: paths.worker.stdout,
    stderr: paths.worker.stderr,
    result: paths.worker.result,
    toolchain: paths.worker.toolchain,
    parent: paths.parent
      ? {
        setupDir: paths.parent.dir,
        script: paths.parent.script,
        stdout: paths.parent.stdout,
        stderr: paths.parent.stderr,
        result: paths.parent.result,
        toolchain: paths.parent.toolchain,
      }
      : undefined,
  });
}

function executionSummary(result: BashExecutionResult | undefined): JsonObject | undefined {
  if (!result) {
    return undefined;
  }

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    interrupted: result.interrupted,
    durationMs: result.durationMs,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdoutChars: result.stdoutChars,
    stderrChars: result.stderrChars,
  };
}

function buildSetupMetadata(input: SetupMetadataInput): JsonObject {
  return compactObject({
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, input.finishedAt - input.startedAt),
    artifacts: artifactMetadata(input.artifacts),
    script: {
      path: input.artifacts.worker.script,
      inspectable: true,
      note: SETUP_SCRIPT_INSPECTION_NOTE,
    },
    execution: executionSummary(input.setupResult),
    toolchain: input.toolchain,
    error: input.error,
  });
}

function buildSetupResultJson(metadata: JsonObject): JsonObject {
  return metadata;
}

function notRunToolchain(error: string): JsonObject {
  return {
    status: "not_run",
    error,
  };
}

function failedToolchain(error: string): JsonObject {
  return {
    status: "failed",
    error,
  };
}

function readToolObservation(tools: Record<string, unknown>, name: SetupToolName): JsonObject {
  const value = tools[name];
  if (!isRecord(value)) {
    throw new ToolError(`Toolchain probe did not report ${name}.`);
  }

  if (value.status === "missing") {
    return {status: "missing"};
  }

  if (value.status !== "present") {
    throw new ToolError(`Toolchain probe returned invalid status for ${name}.`);
  }

  if (typeof value.path !== "string" || typeof value.version !== "string") {
    throw new ToolError(`Toolchain probe returned invalid ${name} details.`);
  }
  if (!value.path.trim() || !value.version.trim()) {
    throw new ToolError(`Toolchain probe returned empty ${name} details.`);
  }
  const version = value.version.trim();
  if (version.startsWith("!") || version.includes("Corepack is about to download")) {
    throw new ToolError(`Toolchain probe returned invalid ${name} version output.`);
  }

  return {
    status: "present",
    path: value.path,
    version: value.version,
  };
}

function parseToolchainProbe(stdout: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new ToolError(`Toolchain probe returned unparsable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isJsonObject(parsed) || !isRecord(parsed.tools)) {
    throw new ToolError("Toolchain probe returned an invalid payload.");
  }

  const tools: JsonObject = {};
  for (const name of SETUP_TOOL_NAMES) {
    tools[name] = readToolObservation(parsed.tools, name);
  }

  return {
    status: "succeeded",
    tools,
  };
}

async function writeJson(filePath: string, value: JsonValue): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export class ExecutionEnvironmentSetupError extends Error {
  readonly metadataPatch: JsonObject;

  constructor(message: string, metadataPatch: JsonObject, options: {cause?: unknown} = {}) {
    super(message, options);
    this.name = "ExecutionEnvironmentSetupError";
    this.metadataPatch = metadataPatch;
  }
}

export function readExecutionEnvironmentSetupErrorMetadata(error: unknown): JsonObject | undefined {
  return error instanceof ExecutionEnvironmentSetupError ? error.metadataPatch : undefined;
}

export class RemoteExecutionEnvironmentSetupRunner implements ExecutionEnvironmentSetupRunner {
  private readonly credentialResolver: EnvironmentSetupCredentialResolver | null;
  private readonly fetchImpl: typeof fetch;
  private readonly sharedSecret: string | null;

  constructor(options: ExecutionEnvironmentSetupRunnerOptions = {}) {
    this.credentialResolver = options.credentialResolver ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sharedSecret = resolveRunnerSharedSecret(options.env ?? process.env);
  }

  async runSetup(input: ExecutionEnvironmentSetupRunnerInput): Promise<JsonObject> {
    const artifacts = buildArtifactPaths(input.filesystem);
    await mkdir(artifacts.core.dir, {recursive: true});
    await copyFile(input.setupScript.resolvedPath, artifacts.core.script);
    await chmod(artifacts.core.script, 0o755);

    const startedAt = Date.now();
    let credentials: Record<string, string> = {};
    let secrets: string[] = [];
    let setupResult: BashExecutionResult | undefined;

    const fail = async (message: string, options: {
      setupResult?: BashExecutionResult;
      toolchain?: JsonObject;
      cause?: unknown;
    } = {}): Promise<never> => {
      const sanitizedMessage = redactSecretsInString(message, secrets);
      const finishedAt = Date.now();
      const metadata = buildSetupMetadata({
        status: "failed",
        artifacts,
        startedAt,
        finishedAt,
        setupResult: options.setupResult,
        toolchain: options.toolchain ?? notRunToolchain(sanitizedMessage),
        error: sanitizedMessage,
      });
      await writeJson(artifacts.core.result, buildSetupResultJson(metadata));
      await writeJson(artifacts.core.toolchain, options.toolchain ?? notRunToolchain(sanitizedMessage));
      throw new ExecutionEnvironmentSetupError(sanitizedMessage, buildSetupMetadataPatch(metadata), {
        cause: options.cause,
      });
    };

    try {
      credentials = this.credentialResolver
        ? await this.credentialResolver.resolveEnvironment({agentKey: input.agentKey})
        : {};
      secrets = sortSecretValues(credentials);
    } catch (error) {
      await writeFile(artifacts.core.stdout, "", "utf8");
      await writeFile(artifacts.core.stderr, "", "utf8");
      return fail(`Setup credential resolution failed: ${redactErrorMessage(error, secrets)}`, {cause: error});
    }

    try {
      setupResult = await this.exec({
        agentKey: input.agentKey,
        runnerUrl: input.runnerUrl,
        command: `bash ${artifacts.worker.script}`,
        cwd: input.runnerCwd,
        timeoutMs: SETUP_TIMEOUT_MS,
        maxOutputChars: SETUP_MAX_OUTPUT_CHARS,
        env: credentials,
      });
    } catch (error) {
      await writeFile(artifacts.core.stdout, "", "utf8");
      await writeFile(artifacts.core.stderr, "", "utf8");
      return fail(`Setup runner request failed: ${redactErrorMessage(error, secrets)}`, {cause: error});
    }

    await writeFile(artifacts.core.stdout, redactSecretsInString(setupResult.stdout, secrets), "utf8");
    await writeFile(artifacts.core.stderr, redactSecretsInString(setupResult.stderr, secrets), "utf8");

    if (!setupResult.success) {
      const reason = setupResult.timedOut
        ? "Setup script timed out."
        : setupResult.aborted
          ? "Setup script was aborted."
          : `Setup script exited with code ${String(setupResult.exitCode)}.`;
      return fail(reason, {setupResult});
    }

    let probeResult: BashExecutionResult;
    try {
      probeResult = await this.exec({
        agentKey: input.agentKey,
        runnerUrl: input.runnerUrl,
        command: TOOLCHAIN_PROBE_COMMAND,
        cwd: input.runnerCwd,
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputChars: PROBE_MAX_OUTPUT_CHARS,
      });
    } catch (error) {
      const message = `Toolchain probe runner request failed: ${redactErrorMessage(error, secrets)}`;
      return fail(message, {setupResult, toolchain: failedToolchain(message), cause: error});
    }

    if (!probeResult.success) {
      const message = probeResult.timedOut
        ? "Toolchain probe timed out."
        : `Toolchain probe exited with code ${String(probeResult.exitCode)}.`;
      return fail(message, {setupResult, toolchain: failedToolchain(message)});
    }
    if (probeResult.stderr.trim()) {
      const message = `Toolchain probe wrote to stderr: ${probeResult.stderr.trim()}`;
      return fail(message, {setupResult, toolchain: failedToolchain(message)});
    }

    let toolchain: JsonObject;
    try {
      toolchain = parseToolchainProbe(probeResult.stdout);
    } catch (error) {
      const message = redactErrorMessage(error, secrets);
      return fail(message, {setupResult, toolchain: failedToolchain(message), cause: error});
    }

    await writeJson(artifacts.core.toolchain, toolchain);
    const finishedAt = Date.now();
    const metadata = buildSetupMetadata({
      status: "succeeded",
      artifacts,
      startedAt,
      finishedAt,
      setupResult,
      toolchain,
    });
    await writeJson(artifacts.core.result, buildSetupResultJson(metadata));
    return buildSetupMetadataPatch(metadata);
  }

  private async exec(input: RemoteExecInput): Promise<BashExecutionResult> {
    const headers = buildRunnerRequestHeaders(input.agentKey, input.runnerUrl, input.runnerUrl, this.sharedSecret);
    let response: Response;
    try {
      response = await this.fetchImpl(buildRunnerEndpoint(input.runnerUrl, "exec"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          requestId: randomUUID(),
          command: input.command,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          trackedEnvKeys: [],
          maxOutputChars: input.maxOutputChars,
          ...(input.env ? {env: input.env} : {}),
        } satisfies BashRunnerExecRequest),
        signal: makeNetworkTimeoutSignal(input.timeoutMs + FETCH_TIMEOUT_BUFFER_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Remote bash runner request failed: ${message}`);
    }

    if (!response.ok) {
      await readRunnerError(response);
    }

    return parseBashRunnerExecResponse(await response.json());
  }
}
