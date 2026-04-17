import {randomUUID} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import type {Message} from "@mariozechner/pi-ai";

import {
    type CreateIdentityInput,
    type IdentityRecord,
    normalizeIdentityHandle,
    PostgresIdentityStore,
} from "../../domain/identity/index.js";
import {PostgresAgentStore} from "../../domain/agents/postgres.js";
import {DEFAULT_AGENT_DOCUMENT_TEMPLATES} from "../../domain/agents/templates.js";
import {normalizeAgentKey} from "../../domain/agents/types.js";
import {PostgresSessionStore} from "../../domain/sessions/index.js";
import type {
    ThreadBashJobRecord,
    ThreadMessageRecord,
    ThreadRecord,
    ThreadRunRecord,
} from "../../domain/threads/runtime/index.js";
import {readToolArtifact, type ToolArtifactDescriptor} from "../../kernel/agent/tool-artifacts.js";
import {createRuntimeClient} from "../runtime/client.js";
import {createDaemon} from "../runtime/daemon.js";
import {DAEMON_STALE_AFTER_MS, DEFAULT_DAEMON_KEY} from "../runtime/daemon-shared.js";
import {createPostgresPool} from "../runtime/database.js";
import {ensureSchemas, withPostgresPool} from "../runtime/postgres-bootstrap.js";
import {DaemonStateRepo} from "../runtime/state/repo.js";
import {
    DEFAULT_SMOKE_TIMEOUT_MS,
    requireSmokeDatabaseUrl,
    resolveSmokeArtifactDirectory,
    resolveSmokeModelSelector,
} from "./config.js";
import {recreateSmokeDatabase, resolveSmokeDatabaseTarget, type SmokeDatabaseTarget,} from "./database.js";

export interface SmokeInput {
  agentKey?: string;
  artifactsDir?: string;
  allowUnsafeDbReset?: boolean;
  cwd?: string;
  dbUrl?: string;
  expectText?: readonly string[];
  expectTool?: readonly string[];
  forbidToolError?: boolean;
  identity?: string;
  inputs: readonly string[];
  model?: string;
  reuseDb?: boolean;
  sessionId?: string;
  timeoutMs?: number;
}

export type SmokeStage =
  | "config"
  | "db_reset"
  | "daemon_start"
  | "bootstrap"
  | "client"
  | "run"
  | "collect"
  | "assertions";

export interface SmokeAssertion {
  details?: string;
  label: string;
  passed: boolean;
}

export interface SmokeArtifacts {
  runs: string;
  summary: string;
  toolArtifacts: string;
  transcript: string;
}

export interface SmokeToolArtifactEntry {
  artifact: ToolArtifactDescriptor;
  isError: boolean;
  messageId: string;
  runId?: string;
  toolName: string;
}

export interface SmokeBashArtifactEntry {
  command: string;
  jobId: string;
  runId?: string;
  status: ThreadBashJobRecord["status"];
  stderrPath?: string;
  stdoutPath?: string;
}

export interface SmokeToolArtifacts {
  bashArtifacts: readonly SmokeBashArtifactEntry[];
  toolArtifacts: readonly SmokeToolArtifactEntry[];
}

export interface SmokeError {
  message: string;
  stage: SmokeStage;
}

export interface SmokeResult {
  artifactDir: string;
  artifacts: SmokeArtifacts;
  assertions: readonly SmokeAssertion[];
  config: {
    agentKey: string;
    cwd: string;
    databaseName?: string;
    expectText: readonly string[];
    expectTool: readonly string[];
    forbidToolError: boolean;
    identityHandle: string;
    inputCount: number;
    model?: string;
    requestedSessionId?: string;
    reuseDb: boolean;
    timeoutMs: number;
  };
  error?: SmokeError;
  runs: readonly ThreadRunRecord[];
  sessionId?: string;
  startedAt: number;
  success: boolean;
  threadId?: string;
  toolArtifacts: SmokeToolArtifacts;
  transcript: readonly ThreadMessageRecord[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

const DEFAULT_SMOKE_IDENTITY_ID = "smoke";
const DEFAULT_SMOKE_IDENTITY_HANDLE = "smoke";
const DEFAULT_SMOKE_IDENTITY_DISPLAY_NAME = "Smoke";

function createDefaultSmokeIdentityInput(): CreateIdentityInput {
  return {
    id: DEFAULT_SMOKE_IDENTITY_ID,
    handle: DEFAULT_SMOKE_IDENTITY_HANDLE,
    displayName: DEFAULT_SMOKE_IDENTITY_DISPLAY_NAME,
    status: "active",
  };
}

function isMissingAgentError(error: unknown, agentKey: string): boolean {
  return error instanceof Error
    && error.message === `Unknown agent ${agentKey}. Create it with \`panda agent create ${agentKey}\`.`;
}

function isMissingIdentityHandleError(error: unknown, handle: string): boolean {
  return error instanceof Error && error.message === `Unknown identity handle ${handle}`;
}

function normalizeTextLines(message: Message): string[] {
  if (message.role === "assistant") {
    return message.content.flatMap((block) => {
      return block.type === "text" && block.text.trim()
        ? [block.text.trim()]
        : [];
    });
  }

  if (message.role === "toolResult") {
    return message.content.flatMap((block) => {
      return block.type === "text" && block.text.trim()
        ? [block.text.trim()]
        : [];
    });
  }

  return [];
}

function collectTranscriptSearchText(transcript: readonly ThreadMessageRecord[]): string {
  return transcript
    .flatMap((entry) => normalizeTextLines(entry.message))
    .join("\n")
    .toLowerCase();
}

function collectObservedTools(transcript: readonly ThreadMessageRecord[]): Set<string> {
  const toolNames = new Set<string>();
  for (const entry of transcript) {
    if (entry.message.role === "assistant") {
      for (const block of entry.message.content) {
        if (block.type === "toolCall" && typeof block.name === "string") {
          toolNames.add(block.name.toLowerCase());
        }
      }
      continue;
    }

    if (entry.message.role === "toolResult") {
      toolNames.add(entry.message.toolName.toLowerCase());
    }
  }

  return toolNames;
}

function collectToolArtifacts(
  transcript: readonly ThreadMessageRecord[],
  bashJobs: readonly ThreadBashJobRecord[],
): SmokeToolArtifacts {
  const toolArtifacts: SmokeToolArtifactEntry[] = [];
  for (const entry of transcript) {
    if (entry.message.role !== "toolResult") {
      continue;
    }

    const artifact = readToolArtifact(entry.message.details);
    if (!artifact) {
      continue;
    }

    toolArtifacts.push({
      artifact,
      isError: entry.message.isError,
      messageId: entry.id,
      runId: entry.runId,
      toolName: entry.message.toolName,
    });
  }

  const bashArtifacts = bashJobs.flatMap((job) => {
    if (!job.stdoutPath && !job.stderrPath) {
      return [];
    }

    return [{
      command: job.command,
      jobId: job.id,
      runId: job.runId,
      status: job.status,
      ...(job.stdoutPath ? {stdoutPath: job.stdoutPath} : {}),
      ...(job.stderrPath ? {stderrPath: job.stderrPath} : {}),
    } satisfies SmokeBashArtifactEntry];
  });

  return {
    bashArtifacts,
    toolArtifacts,
  };
}

function evaluateAssertions(input: {
  expectText: readonly string[];
  expectTool: readonly string[];
  forbidToolError: boolean;
  runs: readonly ThreadRunRecord[];
  transcript: readonly ThreadMessageRecord[];
}): SmokeAssertion[] {
  const assertions: SmokeAssertion[] = [];
  const transcriptText = collectTranscriptSearchText(input.transcript);
  const observedTools = collectObservedTools(input.transcript);
  const failedRuns = input.runs.filter((run) => run.status === "failed");
  const runningRuns = input.runs.filter((run) => run.status === "running");
  const toolErrors = input.transcript.filter((entry) => {
    return entry.message.role === "toolResult" && entry.message.isError;
  });

  for (const expectedText of input.expectText) {
    const expectedTextLower = expectedText.toLowerCase();
    const passed = transcriptText.includes(expectedTextLower);
    assertions.push({
      label: `text:${expectedText}`,
      passed,
      ...(passed ? {} : {details: `Missing expected text: ${expectedText}`}),
    });
  }

  for (const expectedTool of input.expectTool) {
    const normalizedTool = expectedTool.toLowerCase();
    const passed = observedTools.has(normalizedTool);
    assertions.push({
      label: `tool:${expectedTool}`,
      passed,
      ...(passed ? {} : {details: `Missing expected tool call: ${expectedTool}`}),
    });
  }

  assertions.push({
    label: "no-failed-runs",
    passed: failedRuns.length === 0,
    ...(failedRuns.length === 0
      ? {}
      : {
        details: `Failed runs: ${failedRuns.map((run) => `${run.id} (${run.error ?? "unknown error"})`).join(", ")}`,
      }),
  });

  assertions.push({
    label: "thread-idle",
    passed: runningRuns.length === 0,
    ...(runningRuns.length === 0
      ? {}
      : {
        details: `Still running: ${runningRuns.map((run) => run.id).join(", ")}`,
      }),
  });

  if (input.forbidToolError) {
    assertions.push({
      label: "no-tool-errors",
      passed: toolErrors.length === 0,
      ...(toolErrors.length === 0
        ? {}
        : {
          details: `Tool errors: ${toolErrors.map((entry) => {
            if (entry.message.role !== "toolResult") {
              return entry.id;
            }

            return `${entry.message.toolName} (${entry.id})`;
          }).join(", ")}`,
        }),
    });
  }

  return assertions;
}

function firstFailure(assertions: readonly SmokeAssertion[]): SmokeAssertion | undefined {
  return assertions.find((assertion) => !assertion.passed);
}

async function ensureSmokeIdentity(
  store: PostgresIdentityStore,
  requestedHandle?: string,
): Promise<IdentityRecord> {
  const normalizedHandle = requestedHandle
    ? normalizeIdentityHandle(requestedHandle)
    : DEFAULT_SMOKE_IDENTITY_HANDLE;

  try {
    return await store.getIdentityByHandle(normalizedHandle);
  } catch (error) {
    if (!isMissingIdentityHandleError(error, normalizedHandle)) {
      throw error;
    }
  }

  if (normalizedHandle === DEFAULT_SMOKE_IDENTITY_HANDLE) {
    return store.ensureIdentity(createDefaultSmokeIdentityInput());
  }

  return store.createIdentity({
    id: `smoke-${normalizedHandle}`,
    handle: normalizedHandle,
    displayName: normalizedHandle,
  });
}

async function bootstrapSmokeFixtures(input: {
  agentKey?: string;
  dbUrl: string;
  identityHandle?: string;
  sessionId?: string;
}): Promise<{
  agentKey: string;
  identity: IdentityRecord;
  sessionId?: string;
}> {
  return withPostgresPool(input.dbUrl, async (pool) => {
    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const sessionStore = new PostgresSessionStore({pool});
    await ensureSchemas([identityStore, agentStore, sessionStore]);

    const identity = await ensureSmokeIdentity(identityStore, input.identityHandle);
    const requestedSessionId = trimNonEmptyString(input.sessionId);
    if (requestedSessionId) {
      const session = await sessionStore.getSession(requestedSessionId);
      if (input.agentKey && input.agentKey !== session.agentKey) {
        throw new Error(
          `Session ${requestedSessionId} belongs to agent ${session.agentKey}, not ${input.agentKey}.`,
        );
      }

      await agentStore.ensurePairing(session.agentKey, identity.id);
      return {
        agentKey: session.agentKey,
        identity,
        sessionId: session.id,
      };
    }

    if (!input.agentKey) {
      throw new Error("Pass --agent or --session.");
    }

    try {
      await agentStore.getAgent(input.agentKey);
    } catch (error) {
      if (!isMissingAgentError(error, input.agentKey)) {
        throw error;
      }

      await agentStore.bootstrapAgent({
        agentKey: input.agentKey,
        displayName: input.agentKey,
        prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
      });
    }

    await agentStore.ensurePairing(input.agentKey, identity.id);
    return {
      agentKey: input.agentKey,
      identity,
    };
  });
}

async function waitForDaemonOnline(input: {
  dbUrl: string;
  timeoutMs: number;
  getDaemonError: () => Error | null;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  const pool = createPostgresPool(input.dbUrl);
  const daemonState = new DaemonStateRepo({pool});

  try {
    await ensureSchemas([daemonState]);
    while (Date.now() <= deadline) {
      const daemonError = input.getDaemonError();
      if (daemonError) {
        throw daemonError;
      }

      const state = await daemonState.readState(DEFAULT_DAEMON_KEY);
      if (state && Date.now() - state.heartbeatAt <= DAEMON_STALE_AFTER_MS) {
        return;
      }

      await sleep(100);
    }
  } finally {
    await pool.end();
  }

  const daemonError = input.getDaemonError();
  if (daemonError) {
    throw daemonError;
  }

  throw new Error("Timed out waiting for panda smoke daemon to come online.");
}

export async function waitForSmokeDaemonOnline(input: {
  dbUrl: string;
  timeoutMs: number;
  getDaemonError: () => Error | null;
}): Promise<void> {
  return waitForDaemonOnline(input);
}

export async function waitForSmokeThreadIdle(input: {
  store: Awaited<ReturnType<typeof createRuntimeClient>>["store"];
  threadId: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() <= deadline) {
    const [runs, hasRunnableInputs, hasPendingWake] = await Promise.all([
      input.store.listRuns(input.threadId),
      input.store.hasRunnableInputs(input.threadId),
      input.store.hasPendingWake(input.threadId),
    ]);

    if (!runs.some((run) => run.status === "running") && !hasRunnableInputs && !hasPendingWake) {
      return;
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for thread ${input.threadId} to become idle.`);
}

async function loadSmokeRecords(input: {
  client: Awaited<ReturnType<typeof createRuntimeClient>> | null;
  thread: ThreadRecord | null;
}): Promise<{
  bashJobs: readonly ThreadBashJobRecord[];
  runs: readonly ThreadRunRecord[];
  transcript: readonly ThreadMessageRecord[];
}> {
  if (!input.client || !input.thread) {
    return {
      bashJobs: [],
      runs: [],
      transcript: [],
    };
  }

  const [transcript, runs, bashJobs] = await Promise.all([
    input.client.store.loadTranscript(input.thread.id),
    input.client.store.listRuns(input.thread.id),
    input.client.store.listBashJobs(input.thread.id),
  ]);

  return {
    bashJobs,
    runs,
    transcript,
  };
}

async function writeSmokeArtifacts(result: SmokeResult): Promise<void> {
  await mkdir(result.artifactDir, {recursive: true});
  await Promise.all([
    writeFile(result.artifacts.summary, JSON.stringify(result, null, 2) + "\n"),
    writeFile(result.artifacts.transcript, JSON.stringify(result.transcript, null, 2) + "\n"),
    writeFile(result.artifacts.runs, JSON.stringify(result.runs, null, 2) + "\n"),
    writeFile(result.artifacts.toolArtifacts, JSON.stringify(result.toolArtifacts, null, 2) + "\n"),
  ]);
}

export async function runSmoke(input: SmokeInput): Promise<SmokeResult> {
  const startedAt = Date.now();
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const requestedAgentKey = trimNonEmptyString(input.agentKey)
    ? normalizeAgentKey(input.agentKey!)
    : undefined;
  const requestedSessionId = trimNonEmptyString(input.sessionId);
  const timeoutMs = input.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  const artifactDir = resolveSmokeArtifactDirectory({
    agentKey: requestedAgentKey ?? requestedSessionId ?? "session",
    artifactsDir: input.artifactsDir,
    cwd,
  });
  const artifacts: SmokeArtifacts = {
    runs: path.join(artifactDir, "runs.json"),
    summary: path.join(artifactDir, "summary.json"),
    toolArtifacts: path.join(artifactDir, "tool-artifacts.json"),
    transcript: path.join(artifactDir, "transcript.json"),
  };

  let stage: SmokeStage = "config";
  let client: Awaited<ReturnType<typeof createRuntimeClient>> | null = null;
  let daemon: Awaited<ReturnType<typeof createDaemon>> | null = null;
  let daemonRunPromise: Promise<void> | null = null;
  let daemonError: Error | null = null;
  let databaseTarget: SmokeDatabaseTarget | null = null;
  let resolvedAgentKey = requestedAgentKey ?? "unknown";
  let identityHandle = normalizeIdentityHandle(input.identity ?? DEFAULT_SMOKE_IDENTITY_HANDLE);
  let targetSessionId = requestedSessionId;
  let thread: ThreadRecord | null = null;
  let transcript: readonly ThreadMessageRecord[] = [];
  let runs: readonly ThreadRunRecord[] = [];
  let bashJobs: readonly ThreadBashJobRecord[] = [];
  let assertions: readonly SmokeAssertion[] = [];
  let toolArtifacts: SmokeToolArtifacts = {
    bashArtifacts: [],
    toolArtifacts: [],
  };

  await mkdir(artifactDir, {recursive: true});

  try {
    if (input.inputs.length === 0) {
      throw new Error("Pass at least one --input.");
    }

    if (!requestedAgentKey && !requestedSessionId) {
      throw new Error("Pass --agent or --session.");
    }

    if (requestedSessionId && input.reuseDb !== true) {
      throw new Error("Session-targeted smoke requires --reuse-db.");
    }

    if (requestedSessionId && input.model) {
      throw new Error("Session-targeted smoke does not support --model.");
    }

    const dbUrl = requireSmokeDatabaseUrl(input.dbUrl);
    const model = resolveSmokeModelSelector(input.model);
    databaseTarget = resolveSmokeDatabaseTarget(dbUrl);

    if (!input.reuseDb) {
      stage = "db_reset";
      databaseTarget = await recreateSmokeDatabase(dbUrl, {
        allowUnsafeReset: input.allowUnsafeDbReset,
      });
    }

    stage = "daemon_start";
    daemon = await createDaemon({
      cwd,
      dbUrl,
    });
    daemonRunPromise = daemon.run().catch((error) => {
      daemonError = error instanceof Error ? error : new Error(String(error));
    });
    await waitForDaemonOnline({
      dbUrl,
      timeoutMs: Math.min(timeoutMs, 15_000),
      getDaemonError: () => daemonError,
    });

    stage = "bootstrap";
    const bootstrapped = await bootstrapSmokeFixtures({
      agentKey: requestedAgentKey,
      dbUrl,
      identityHandle: input.identity,
      sessionId: requestedSessionId,
    });
    const identity = bootstrapped.identity;
    resolvedAgentKey = bootstrapped.agentKey;
    targetSessionId = bootstrapped.sessionId;
    identityHandle = identity.handle;

    stage = "client";
    client = await createRuntimeClient({
      dbUrl,
      identity: identity.handle,
    });
    thread = targetSessionId
      ? await client.openSession(targetSessionId)
      : await client.openMainSession({
        agentKey: resolvedAgentKey,
        ...(model ? {model} : {}),
      });

    for (const text of input.inputs) {
      stage = "run";
      const submission = await client.submitTextInput({
        actorId: identity.handle,
        externalMessageId: randomUUID(),
        text,
        threadId: thread.id,
      });
      thread = await client.getThread(submission.threadId);
      await waitForSmokeThreadIdle({
        store: client.store,
        threadId: thread.id,
        timeoutMs,
      });
    }

    stage = "collect";
    ({bashJobs, runs, transcript} = await loadSmokeRecords({
      client,
      thread,
    }));
    toolArtifacts = collectToolArtifacts(transcript, bashJobs);

    stage = "assertions";
    assertions = evaluateAssertions({
      expectText: input.expectText ?? [],
      expectTool: input.expectTool ?? [],
      forbidToolError: input.forbidToolError === true,
      runs,
      transcript,
    });

    const failure = firstFailure(assertions);
    const result: SmokeResult = {
      artifactDir,
      artifacts,
      assertions,
      config: {
        agentKey: resolvedAgentKey,
        cwd,
        ...(databaseTarget ? {databaseName: databaseTarget.databaseName} : {}),
        expectText: [...(input.expectText ?? [])],
        expectTool: [...(input.expectTool ?? [])],
        forbidToolError: input.forbidToolError === true,
        identityHandle,
        inputCount: input.inputs.length,
        ...(model ? {model} : {}),
        ...(requestedSessionId ? {requestedSessionId} : {}),
        reuseDb: input.reuseDb === true,
        timeoutMs,
      },
      ...(failure
        ? {
          error: {
            message: failure.details ?? `Assertion failed: ${failure.label}`,
            stage: "assertions",
          },
        }
        : {}),
      runs,
      sessionId: thread?.sessionId,
      startedAt,
      success: !failure,
      threadId: thread?.id,
      toolArtifacts,
      transcript,
    };
    await writeSmokeArtifacts(result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ({bashJobs, runs, transcript} = await loadSmokeRecords({
      client,
      thread,
    }));
    toolArtifacts = collectToolArtifacts(transcript, bashJobs);
    if (assertions.length === 0) {
      assertions = evaluateAssertions({
        expectText: input.expectText ?? [],
        expectTool: input.expectTool ?? [],
        forbidToolError: input.forbidToolError === true,
        runs,
        transcript,
      });
    }

    const result: SmokeResult = {
      artifactDir,
      artifacts,
      assertions,
      config: {
        agentKey: resolvedAgentKey,
        cwd,
        ...(databaseTarget ? {databaseName: databaseTarget.databaseName} : {}),
        expectText: [...(input.expectText ?? [])],
        expectTool: [...(input.expectTool ?? [])],
        forbidToolError: input.forbidToolError === true,
        identityHandle,
        inputCount: input.inputs.length,
        ...(resolveSmokeModelSelector(input.model) ? {model: resolveSmokeModelSelector(input.model)} : {}),
        ...(requestedSessionId ? {requestedSessionId} : {}),
        reuseDb: input.reuseDb === true,
        timeoutMs,
      },
      error: {
        message,
        stage,
      },
      runs,
      sessionId: thread?.sessionId,
      startedAt,
      success: false,
      threadId: thread?.id,
      toolArtifacts,
      transcript,
    };
    await writeSmokeArtifacts(result);
    return result;
  } finally {
    await client?.close().catch(() => undefined);
    await daemon?.stop().catch(() => undefined);
    await daemonRunPromise?.catch(() => undefined);
  }
}
