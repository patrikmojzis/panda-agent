import {randomUUID} from "node:crypto";

import type {
  DisposableEnvironmentCreateResult,
  DisposableEnvironmentLogsRequest,
  DisposableEnvironmentLogsResult,
  ExecutionCredentialPolicy,
  ExecutionEnvironmentManager,
  ExecutionEnvironmentRecord,
  ExecutionSkillPolicy,
  ExecutionToolPolicy,
  ResolvedExecutionEnvironment,
  SessionEnvironmentBindingRecord,
  SettleExecutionEnvironmentOperationInput,
} from "../../domain/execution-environments/types.js";
import {ExecutionEnvironmentManagerPreflightError} from "../../domain/execution-environments/types.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import type {JsonObject, JsonValue} from "../../lib/json.js";
import {isJsonObject, normalizeToJsonValue, stableStringify} from "../../lib/json.js";
import {trimToUndefined} from "../../lib/strings.js";
import {
  hasExecutionEnvironmentSetup,
  type ExecutionEnvironmentSetupScriptInput,
} from "../../domain/execution-environments/setup.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/filesystem.js";
import type {ExecutionEnvironmentSetupRunner} from "./execution-environment-setup-runner.js";
import {readExecutionEnvironmentSetupErrorMetadata} from "./execution-environment-setup-runner.js";
import type {CommandLeaseIssuer} from "./command-leases.js";
import {
  executionEnvironmentRunnerAuthScope,
  type RunnerTokenAuthority,
} from "../../integrations/shell/runner-auth.js";

const DEFAULT_DISPOSABLE_ALIAS = "self";
export const DEFAULT_DISPOSABLE_ENVIRONMENT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface CreateDisposableSessionEnvironmentInput {
  session: Pick<SessionRecord, "id" | "agentKey">;
  environmentId?: string;
  createdBySessionId?: string;
  alias?: string;
  isDefault?: boolean;
  credentialPolicy?: ExecutionCredentialPolicy;
  skillPolicy?: ExecutionSkillPolicy;
  toolPolicy?: ExecutionToolPolicy;
  ttlMs?: number;
  metadata?: JsonValue;
}

export interface CreateStandaloneDisposableEnvironmentInput {
  agentKey: string;
  createdBySessionId: string;
  environmentId?: string;
  ttlMs?: number;
  metadata?: JsonValue;
  setupScript?: ExecutionEnvironmentSetupScriptInput;
}

export interface AttachSessionToDisposableEnvironmentInput {
  session: Pick<SessionRecord, "id" | "agentKey">;
  environmentId: string;
  ownerSessionId: string;
  alias?: string;
  isDefault?: boolean;
  credentialPolicy?: ExecutionCredentialPolicy;
  skillPolicy?: ExecutionSkillPolicy;
  toolPolicy?: ExecutionToolPolicy;
}

export interface AttachReadySessionToDisposableEnvironmentInput {
  session: Pick<SessionRecord, "id" | "agentKey">;
  environmentId: string;
  ownerSessionId: string;
  alias?: string;
  isDefault?: boolean;
  credentialPolicy?: ExecutionCredentialPolicy;
  skillPolicy?: ExecutionSkillPolicy;
  toolPolicy?: ExecutionToolPolicy;
}

export class InvalidDisposableEnvironmentAttachmentError extends Error {
  override readonly name = "InvalidDisposableEnvironmentAttachmentError";
}

export interface EnsureBoundSessionEnvironmentReadyInput {
  session: Pick<SessionRecord, "id" | "agentKey">;
  binding: SessionEnvironmentBindingRecord;
  ttlMs?: number;
}

export interface RefreshSessionCommandAccessInput {
  session: Pick<SessionRecord, "id" | "agentKey">;
  executionEnvironment: Pick<
    ResolvedExecutionEnvironment,
    "credentialPolicy" | "id" | "kind" | "skillPolicy" | "source" | "toolPolicy"
  >;
  identityId?: string;
  inputMessageId?: string;
  runId?: string;
  parentToolCallId?: string;
  ttlMs?: number;
}

export interface RefreshSessionCommandAccessResult {
  refreshed: boolean;
  reason?: "unsupported_environment" | "unsupported_manager" | "command_server_disabled" | "no_allowed_commands";
  commandAccess?: {
    url?: string;
    socketPath?: string;
    token: string;
  };
}

export interface CreateDisposableSessionEnvironmentResult {
  environment: ExecutionEnvironmentRecord;
  binding: SessionEnvironmentBindingRecord;
}

export interface SweepExpiredExecutionEnvironmentsResult {
  checked: number;
  stopped: number;
  failed: number;
}

export interface ExecutionEnvironmentLifecycleServiceOptions {
  store: ExecutionEnvironmentLifecycleStore;
  manager?: ExecutionEnvironmentManager | null;
  setupRunner?: ExecutionEnvironmentSetupRunner | null;
  commandLeases?: CommandLeaseIssuer | null;
  fallbackRunnerCommandSocketAccess?: boolean;
  runnerTokenAuthority?: RunnerTokenAuthority | null;
  legacyRunnerSharedSecret?: string | null;
}

export type ExecutionEnvironmentStopStore = Pick<
  ExecutionEnvironmentStore,
  "claimEnvironmentOperation" | "settleEnvironmentOperation" | "getEnvironment"
>;

type ExecutionEnvironmentLifecycleStore = ExecutionEnvironmentStopStore & Pick<
  ExecutionEnvironmentStore,
  | "bindSession"
  | "getBinding"
  | "getDefaultBinding"
  | "listExpiredDisposableEnvironments"
  | "reserveEnvironment"
>;

function buildDisposableEnvironmentId(sessionId: string): string {
  return `disposable:${sessionId}:${randomUUID()}`;
}

function buildStandaloneEnvironmentId(sessionId: string): string {
  return `environment:${sessionId}:${randomUUID()}`;
}

function mergeMetadata(...values: Array<JsonValue | undefined>): JsonValue | undefined {
  const present = values.filter((entry): entry is JsonValue => entry !== undefined);
  if (present.length === 0) {
    return undefined;
  }

  const records = present.filter(isJsonObject);
  if (records.length === present.length) {
    const merged = Object.assign({}, ...records);
    if (isJsonObject(merged)) {
      return merged;
    }
  }

  return present[present.length - 1];
}

function errorMetadata(error: unknown): JsonValue {
  return {
    error: error instanceof Error ? error.message : String(error),
  };
}

function isExpired(environment: ExecutionEnvironmentRecord): boolean {
  return environment.expiresAt !== undefined && environment.expiresAt <= Date.now();
}

function remainingTtlMs(environment: Pick<ExecutionEnvironmentRecord, "expiresAt">): number | undefined {
  return environment.expiresAt === undefined
    ? undefined
    : Math.max(1, environment.expiresAt - Date.now());
}

function commandSocketAccessAllowed(
  environment: Pick<ResolvedExecutionEnvironment, "kind" | "source">,
  fallbackRunnerCommandSocketAccess: boolean,
): boolean {
  if (environment.kind === "local") {
    return true;
  }
  if (environment.kind === "disposable_container") {
    return true;
  }

  return environment.source === "fallback" && fallbackRunnerCommandSocketAccess;
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return stableStringify(left) === stableStringify(right);
}

function assertIdleEnvironment(environment: ExecutionEnvironmentRecord): asserts environment is ExecutionEnvironmentRecord & {
  state: "ready" | "failed" | "stopped";
} {
  if (environment.state === "provisioning" || environment.state === "stopping") {
    throw new Error(`Execution environment ${environment.id} is ${environment.state}; operation ${environment.operationId ?? "legacy/unresolved"} must finish before another transition.`);
  }
}

function uncertainOperation(environment: ExecutionEnvironmentRecord, error: unknown): Error {
  return new Error(`Execution environment ${environment.id} operation ${environment.operationId} has an unresolved outcome and remains ${environment.state}; no automatic retry or takeover is safe.`, {cause: error});
}

async function settleEnvironmentOperation(
  store: ExecutionEnvironmentStopStore,
  input: SettleExecutionEnvironmentOperationInput,
): Promise<ExecutionEnvironmentRecord> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const settled = await store.settleEnvironmentOperation(input);
      if (settled) return settled;
    } catch (error) {
      lastError = error;
    }
    let current: ExecutionEnvironmentRecord;
    try {
      current = await store.getEnvironment(input.environmentId);
    } catch (error) {
      lastError = error;
      continue;
    }
    if (current.operationId === input.operationId && current.state === input.state) return current;
    if (current.operationId !== input.operationId || current.state !== input.operationState) {
      throw new Error(`Execution environment ${input.environmentId} operation ${input.operationId} no longer owns settlement.`);
    }
  }
  throw new Error(`Execution environment ${input.environmentId} operation ${input.operationId} finished externally but its ${input.state} receipt is unresolved.`, {cause: lastError});
}

export async function stopExecutionEnvironment(input: {
  environmentId: string;
  manager: ExecutionEnvironmentManager;
  store: ExecutionEnvironmentStopStore;
  expiresBefore?: number;
}): Promise<ExecutionEnvironmentRecord> {
  const existing = await input.store.getEnvironment(input.environmentId);
  assertIdleEnvironment(existing);
  if (existing.state === "stopped") return existing;
  const operationId = randomUUID();
  const claimed = await input.store.claimEnvironmentOperation({
    environmentId: existing.id,
    operationId,
    expectedOperationId: existing.operationId,
    expectedState: existing.state,
    state: "stopping",
    expiresBefore: input.expiresBefore,
  });
  if (!claimed) throw new Error(`Execution environment ${existing.id} changed before stop could claim it.`);
  try {
    await input.manager.stopEnvironment(input.environmentId);
  } catch (error) {
    if (error instanceof ExecutionEnvironmentManagerPreflightError) {
      await settleEnvironmentOperation(input.store, {
        environmentId: existing.id, operationId, operationState: "stopping", state: existing.state,
      });
      throw error;
    }
    throw uncertainOperation(claimed, error);
  }
  return settleEnvironmentOperation(input.store, {
    environmentId: existing.id,
    operationId,
    operationState: "stopping",
    state: "stopped",
  });
}

export class ExecutionEnvironmentLifecycleService {
  private readonly store: ExecutionEnvironmentLifecycleStore;
  private readonly manager: ExecutionEnvironmentManager | null;
  private readonly setupRunner: ExecutionEnvironmentSetupRunner | null;
  private readonly commandLeases: CommandLeaseIssuer | null;
  private readonly fallbackRunnerCommandSocketAccess: boolean;
  private readonly runnerTokenAuthority: RunnerTokenAuthority | null;
  private readonly legacyRunnerSharedSecret: string | null;

  constructor(options: ExecutionEnvironmentLifecycleServiceOptions) {
    this.store = options.store;
    this.manager = options.manager ?? null;
    this.setupRunner = options.setupRunner ?? null;
    this.commandLeases = options.commandLeases ?? null;
    this.fallbackRunnerCommandSocketAccess = options.fallbackRunnerCommandSocketAccess === true;
    this.runnerTokenAuthority = options.runnerTokenAuthority ?? null;
    this.legacyRunnerSharedSecret = trimToUndefined(options.legacyRunnerSharedSecret ?? undefined) ?? null;
  }

  private resolveRunnerAuthToken(agentKey: string, environmentId: string): string | undefined {
    return this.runnerTokenAuthority?.derive(executionEnvironmentRunnerAuthScope(agentKey, environmentId))
      ?? this.legacyRunnerSharedSecret
      ?? undefined;
  }

  async refreshSessionCommandAccess(
    input: RefreshSessionCommandAccessInput,
  ): Promise<RefreshSessionCommandAccessResult> {
    if (!this.commandLeases) {
      return {refreshed: false, reason: "command_server_disabled"};
    }

    const socketAccessAllowed = commandSocketAccessAllowed(
      input.executionEnvironment,
      this.fallbackRunnerCommandSocketAccess,
    );
    if (
      this.commandLeases.hasUsableTransport
      && !this.commandLeases.hasUsableTransport({socketAccessAllowed})
    ) {
      throw new Error(
        `Panda command socket transport is not mounted in execution environment ${input.executionEnvironment.id}. `
        + "Use PANDA_COMMAND_TRANSPORT=http for remote runners, or mount the command socket into that runner.",
      );
    }

    const commandLease = this.commandLeases.issueCommandLease({
      agentKey: input.session.agentKey,
      sessionId: input.session.id,
      ...(input.executionEnvironment.source === "binding" ? {environmentId: input.executionEnvironment.id} : {}),
      toolPolicy: input.executionEnvironment.toolPolicy,
      skillPolicy: input.executionEnvironment.skillPolicy,
      credentialPolicy: input.executionEnvironment.credentialPolicy,
      credentialMutationAllowed: input.executionEnvironment.source === "fallback",
      ...(input.identityId ? {identityId: input.identityId} : {}),
      ...(input.inputMessageId ? {inputMessageId: input.inputMessageId} : {}),
      ...(input.runId ? {runId: input.runId} : {}),
      ...(input.parentToolCallId ? {parentToolCallId: input.parentToolCallId} : {}),
      socketAccessAllowed,
      ...(input.ttlMs === undefined ? {} : {ttlMs: input.ttlMs}),
    });
    const commandAccess = commandLease ? {
      ...(commandLease.url ? {url: commandLease.url} : {}),
      ...(commandLease.socketPath ? {socketPath: commandLease.socketPath} : {}),
      token: commandLease.token,
    } : undefined;

    if (
      input.executionEnvironment.kind === "disposable_container"
      && input.executionEnvironment.source === "binding"
    ) {
      if (!this.manager?.refreshCommandAccess) {
        return {refreshed: false, reason: "unsupported_manager"};
      }

      await this.manager.refreshCommandAccess({
        environmentId: input.executionEnvironment.id,
        ...(commandAccess ? {commandAccess} : {}),
      });
    }

    return commandAccess
      ? {refreshed: true, commandAccess}
      : {refreshed: false, reason: "no_allowed_commands"};
  }

  async readEnvironmentLogs(input: DisposableEnvironmentLogsRequest): Promise<DisposableEnvironmentLogsResult> {
    if (!this.manager?.readEnvironmentLogs) {
      throw new Error("Execution environment manager does not support logs.");
    }
    return this.manager.readEnvironmentLogs(input);
  }

  async createDisposableForSession(
    input: CreateDisposableSessionEnvironmentInput,
  ): Promise<CreateDisposableSessionEnvironmentResult> {
    if (!this.manager) {
      throw new Error("Disposable execution environment manager is not configured.");
    }

    const environmentId = trimToUndefined(input.environmentId) ?? buildDisposableEnvironmentId(input.session.id);
    const expiresAt = input.ttlMs === undefined ? undefined : Date.now() + input.ttlMs;
    const credentialPolicy = input.credentialPolicy ?? {mode: "allowlist" as const, envKeys: []};
    const skillPolicy = input.skillPolicy ?? {mode: "allowlist" as const, skillKeys: []};
    const toolPolicy = input.toolPolicy ?? {};
    const existingBinding = await this.store.getDefaultBinding(input.session.id);
    if (existingBinding?.environmentId === environmentId) {
      if (
        !sameJson(normalizeToJsonValue(existingBinding.credentialPolicy), normalizeToJsonValue(credentialPolicy))
        || !sameJson(normalizeToJsonValue(existingBinding.skillPolicy), normalizeToJsonValue(skillPolicy))
        || !sameJson(normalizeToJsonValue(existingBinding.toolPolicy), normalizeToJsonValue(toolPolicy))
      ) {
        throw new Error(`Execution environment binding for session ${input.session.id} already exists with different policy.`);
      }
      const existingEnvironment = await this.store.getEnvironment(environmentId);
      if (existingEnvironment.state === "ready" && !isExpired(existingEnvironment)) {
        return {
          environment: existingEnvironment,
          binding: existingBinding,
        };
      }
    }

    const runnerAuthToken = this.resolveRunnerAuthToken(input.session.agentKey, environmentId);
    const environment = await this.store.reserveEnvironment({
      id: environmentId,
      operationId: randomUUID(),
      agentKey: input.session.agentKey,
      kind: "disposable_container",
      state: "provisioning",
      createdBySessionId: input.createdBySessionId,
      createdForSessionId: input.session.id,
      expiresAt,
      metadata: input.metadata,
    });
    if (!environment) throw new Error(`Execution environment ${environmentId} already exists; use its existing binding or lifecycle operation.`);

    let binding: SessionEnvironmentBindingRecord | undefined;
    const ready = await this.provisionEnvironment(environment, async () => {
      let commandLease;
      try {
        commandLease = this.commandLeases?.issueCommandLease({
          agentKey: input.session.agentKey,
          sessionId: input.session.id,
          environmentId,
          toolPolicy,
          skillPolicy,
          credentialPolicy,
          credentialMutationAllowed: false,
          socketAccessAllowed: true,
          ...(input.ttlMs === undefined ? {} : {ttlMs: input.ttlMs}),
        });
      } catch (error) {
        throw new ExecutionEnvironmentManagerPreflightError(error);
      }
      return this.manager!.createDisposableEnvironment({
        agentKey: input.session.agentKey,
        sessionId: input.session.id,
        environmentId,
        ...(runnerAuthToken ? {runnerAuthToken} : {}),
        ...(input.ttlMs === undefined ? {} : {ttlMs: input.ttlMs}),
        ...(input.metadata === undefined ? {} : {metadata: input.metadata}),
        ...(commandLease
          ? {
            commandAccess: {
              ...(commandLease.url ? {url: commandLease.url} : {}),
              ...(commandLease.socketPath ? {socketPath: commandLease.socketPath} : {}),
              token: commandLease.token,
            },
          }
          : {}),
      });
    }, async () => {
      binding = await this.store.bindSession({
        sessionId: input.session.id,
        environmentId,
        alias: trimToUndefined(input.alias) ?? DEFAULT_DISPOSABLE_ALIAS,
        isDefault: input.isDefault ?? true,
        credentialPolicy,
        skillPolicy,
        toolPolicy,
      });

      return undefined;
    });
    return {environment: ready, binding: binding!};
  }

  async createStandaloneDisposableEnvironment(
    input: CreateStandaloneDisposableEnvironmentInput,
  ): Promise<ExecutionEnvironmentRecord> {
    if (!this.manager) {
      throw new Error("Disposable execution environment manager is not configured.");
    }

    const agentKey = trimToUndefined(input.agentKey);
    const ownerSessionId = trimToUndefined(input.createdBySessionId);
    if (!agentKey) {
      throw new Error("Disposable environment agentKey must not be empty.");
    }
    if (!ownerSessionId) {
      throw new Error("Disposable environment owner session id must not be empty.");
    }
    if (input.setupScript && !this.setupRunner) {
      throw new Error("Disposable environment setup runner is not configured.");
    }

    const environmentId = trimToUndefined(input.environmentId) ?? buildStandaloneEnvironmentId(ownerSessionId);
    const expiresAt = input.ttlMs === undefined ? undefined : Date.now() + input.ttlMs;
    const runnerAuthToken = this.resolveRunnerAuthToken(agentKey, environmentId);
    const environment = await this.store.reserveEnvironment({
      id: environmentId,
      operationId: randomUUID(),
      agentKey,
      kind: "disposable_container",
      state: "provisioning",
      createdBySessionId: ownerSessionId,
      expiresAt,
      metadata: input.metadata,
    });
    if (!environment) throw new Error(`Execution environment ${environmentId} already exists; create requires a new environment id.`);

    return this.provisionEnvironment(environment, async () => {
      return this.manager!.createDisposableEnvironment({
        agentKey,
        sessionId: ownerSessionId,
        environmentId,
        ...(runnerAuthToken ? {runnerAuthToken} : {}),
        ...(input.ttlMs === undefined ? {} : {ttlMs: input.ttlMs}),
        ...(input.metadata === undefined ? {} : {metadata: input.metadata}),
      });
    }, async (created) => {
      let setupMetadata: JsonObject | undefined;
      if (input.setupScript) {
        const filesystem = readExecutionEnvironmentFilesystemMetadata(created.metadata);
        if (!filesystem) {
          throw new Error("Disposable environment setup requires filesystem metadata from the environment manager.");
        }
        setupMetadata = await this.setupRunner!.runSetup({
          agentKey,
          environmentId,
          runnerUrl: created.runnerUrl,
          runnerCwd: created.runnerCwd,
          filesystem,
          setupScript: input.setupScript,
        });
      }

      return setupMetadata;
    });
  }

  async attachSessionToDisposableEnvironment(
    input: AttachSessionToDisposableEnvironmentInput,
  ): Promise<CreateDisposableSessionEnvironmentResult> {
    const credentialPolicy = input.credentialPolicy ?? {mode: "allowlist" as const, envKeys: []};
    const skillPolicy = input.skillPolicy ?? {mode: "allowlist" as const, skillKeys: []};
    const toolPolicy = input.toolPolicy ?? {};
    const ownerSessionId = trimToUndefined(input.ownerSessionId);
    if (!ownerSessionId) {
      throw new Error("Disposable environment owner session id must not be empty.");
    }

    let environment = await this.store.getEnvironment(input.environmentId);
    if (environment.kind !== "disposable_container") {
      throw new Error(`Execution environment ${environment.id} is not disposable.`);
    }
    if (environment.agentKey !== input.session.agentKey) {
      throw new Error(`Execution environment ${environment.id} does not belong to agent ${input.session.agentKey}.`);
    }
    if (environment.createdBySessionId !== ownerSessionId) {
      throw new Error(`Execution environment ${environment.id} is not owned by session ${ownerSessionId}.`);
    }
    assertIdleEnvironment(environment);
    if (environment.state === "stopped" || isExpired(environment)) {
      environment = await this.restartDisposableEnvironment(environment, {
        ttlMs: isExpired(environment) ? DEFAULT_DISPOSABLE_ENVIRONMENT_TTL_MS : undefined,
      });
    } else if (environment.state !== "ready") {
      throw new Error(`Execution environment ${environment.id} is ${environment.state}.`);
    }

    const binding = await this.store.bindSession({
      sessionId: input.session.id,
      environmentId: environment.id,
      alias: trimToUndefined(input.alias) ?? DEFAULT_DISPOSABLE_ALIAS,
      isDefault: input.isDefault ?? true,
      credentialPolicy,
      skillPolicy,
      toolPolicy,
    });
    return {environment, binding};
  }

  async attachReadySessionToDisposableEnvironment(
    input: AttachReadySessionToDisposableEnvironmentInput,
  ): Promise<CreateDisposableSessionEnvironmentResult> {
    const credentialPolicy = input.credentialPolicy ?? {mode: "allowlist" as const, envKeys: []};
    const skillPolicy = input.skillPolicy ?? {mode: "allowlist" as const, skillKeys: []};
    const toolPolicy = input.toolPolicy ?? {};
    const environment = await this.validateReadyDisposableEnvironment({
      environmentId: input.environmentId,
      agentKey: input.session.agentKey,
      ownerSessionId: input.ownerSessionId,
    });
    const binding = await this.store.bindSession({
      sessionId: input.session.id,
      environmentId: environment.id,
      alias: trimToUndefined(input.alias) ?? DEFAULT_DISPOSABLE_ALIAS,
      isDefault: input.isDefault ?? true,
      credentialPolicy,
      skillPolicy,
      toolPolicy,
    });
    return {environment, binding};
  }

  async getSessionEnvironmentAttachment(input: {
    session: Pick<SessionRecord, "id" | "agentKey">;
    environmentId: string;
  }): Promise<CreateDisposableSessionEnvironmentResult | null> {
    const binding = await this.store.getBinding(input.session.id, input.environmentId);
    if (!binding) return null;
    const environment = await this.store.getEnvironment(input.environmentId);
    if (environment.agentKey !== input.session.agentKey) {
      throw new Error(`Execution environment ${environment.id} does not belong to agent ${input.session.agentKey}.`);
    }
    return {binding, environment};
  }

  async validateReadyDisposableEnvironment(input: {
    environmentId: string;
    agentKey: string;
    ownerSessionId: string;
  }): Promise<ExecutionEnvironmentRecord> {
    const ownerSessionId = trimToUndefined(input.ownerSessionId);
    if (!ownerSessionId) {
      throw new InvalidDisposableEnvironmentAttachmentError(
        "Disposable environment owner session id must not be empty.",
      );
    }

    const environment = await this.store.getEnvironment(input.environmentId);
    if (environment.kind !== "disposable_container") {
      throw new InvalidDisposableEnvironmentAttachmentError(`Execution environment ${environment.id} is not disposable.`);
    }
    if (environment.agentKey !== input.agentKey) {
      throw new InvalidDisposableEnvironmentAttachmentError(
        `Execution environment ${environment.id} does not belong to agent ${input.agentKey}.`,
      );
    }
    if (environment.createdBySessionId !== ownerSessionId) {
      throw new InvalidDisposableEnvironmentAttachmentError(
        `Execution environment ${environment.id} is not owned by session ${ownerSessionId}.`,
      );
    }
    if (environment.state !== "ready") {
      throw new InvalidDisposableEnvironmentAttachmentError(
        `Execution environment ${environment.id} is ${environment.state}.`,
      );
    }
    if (isExpired(environment)) {
      throw new InvalidDisposableEnvironmentAttachmentError(`Execution environment ${environment.id} is expired.`);
    }
    return environment;
  }

  async ensureBoundEnvironmentReady(
    input: EnsureBoundSessionEnvironmentReadyInput,
  ): Promise<ExecutionEnvironmentRecord> {
    let environment = await this.store.getEnvironment(input.binding.environmentId);
    if (environment.agentKey !== input.session.agentKey) {
      throw new Error(`Execution environment ${environment.id} does not belong to agent ${input.session.agentKey}.`);
    }
    assertIdleEnvironment(environment);
    if (environment.state === "ready" && !isExpired(environment)) {
      return environment;
    }
    if (environment.kind === "disposable_container" && (environment.state === "stopped" || isExpired(environment))) {
      environment = await this.restartDisposableEnvironment(environment, {
        ttlMs: isExpired(environment) ? input.ttlMs ?? DEFAULT_DISPOSABLE_ENVIRONMENT_TTL_MS : undefined,
      });
      if (environment.state === "ready" && !isExpired(environment)) {
        return environment;
      }
    }
    if (environment.state !== "ready") {
      throw new Error(`Execution environment ${environment.id} is ${environment.state}.`);
    }
    if (isExpired(environment)) {
      throw new Error(`Execution environment ${environment.id} is expired.`);
    }
    return environment;
  }

  private async restartDisposableEnvironment(
    environment: ExecutionEnvironmentRecord,
    options: {ttlMs?: number} = {},
  ): Promise<ExecutionEnvironmentRecord> {
    if (!this.manager) {
      throw new Error("Disposable execution environment manager is not configured.");
    }
    assertIdleEnvironment(environment);

    const managerSessionId = environment.createdForSessionId ?? environment.createdBySessionId;
    if (!managerSessionId) {
      throw new Error(`Execution environment ${environment.id} is missing an owning session id.`);
    }
    if (hasExecutionEnvironmentSetup(environment.metadata)) {
      throw new Error(
        `Execution environment ${environment.id} was created with setupScript and cannot be restarted without rerunning setup.`,
      );
    }

    const runnerAuthToken = this.resolveRunnerAuthToken(environment.agentKey, environment.id);
    const claimed = await this.store.claimEnvironmentOperation({
      environmentId: environment.id,
      operationId: randomUUID(),
      expectedOperationId: environment.operationId,
      expectedState: environment.state,
      state: "provisioning",
      ...(isExpired(environment) ? {expiresBefore: Date.now()} : {}),
    });
    if (!claimed) throw new Error(`Execution environment ${environment.id} changed before restart could claim it.`);

    const expiresAt = options.ttlMs === undefined ? claimed.expiresAt : Date.now() + options.ttlMs;
    return this.provisionEnvironment(claimed, async () => {
      const ttlMs = options.ttlMs ?? remainingTtlMs(environment);
      return this.manager!.createDisposableEnvironment({
        agentKey: environment.agentKey,
        sessionId: managerSessionId,
        environmentId: environment.id,
        ...(runnerAuthToken ? {runnerAuthToken} : {}),
        ...(ttlMs === undefined ? {} : {ttlMs}),
        ...(claimed.metadata === undefined ? {} : {metadata: claimed.metadata}),
      });
    }, undefined, expiresAt, environment.state);
  }

  private async provisionEnvironment(
    environment: ExecutionEnvironmentRecord,
    create: () => Promise<DisposableEnvironmentCreateResult>,
    prepare?: (created: DisposableEnvironmentCreateResult) => Promise<JsonValue | undefined>,
    expiresAt?: number,
    undispatchedState: "ready" | "failed" | "stopped" = "failed",
  ): Promise<ExecutionEnvironmentRecord> {
    let created: DisposableEnvironmentCreateResult;
    try {
      created = await create();
    } catch (error) {
      if (error instanceof ExecutionEnvironmentManagerPreflightError) {
        await settleEnvironmentOperation(this.store, {
          environmentId: environment.id, operationId: environment.operationId!,
          operationState: "provisioning", state: undispatchedState,
        });
        throw error;
      }
      // A rejected HTTP request cannot establish whether Docker has finished.
      throw uncertainOperation(environment, error);
    }

    let metadata: JsonValue | undefined;
    try {
      metadata = await prepare?.(created);
    } catch (error) {
      try {
        await this.manager!.stopEnvironment(environment.id);
      } catch (stopError) {
        throw uncertainOperation(environment, stopError);
      }
      await settleEnvironmentOperation(this.store, {
        environmentId: environment.id,
        operationId: environment.operationId!,
        operationState: "provisioning",
        state: "failed",
        ...created,
        metadata: mergeMetadata(created.metadata, readExecutionEnvironmentSetupErrorMetadata(error), errorMetadata(error)),
      });
      throw error;
    }
    // Receipt errors must never enter setup cleanup or repeat the manager call.
    return settleEnvironmentOperation(this.store, {
      environmentId: environment.id,
      operationId: environment.operationId!,
      operationState: "provisioning",
      state: "ready",
      ...created,
      expiresAt,
      metadata: mergeMetadata(created.metadata, metadata),
    });
  }

  async stopEnvironment(environmentId: string): Promise<ExecutionEnvironmentRecord> {
    if (!this.manager) {
      throw new Error("Disposable execution environment manager is not configured.");
    }

    return stopExecutionEnvironment({
      environmentId,
      manager: this.manager,
      store: this.store,
    });
  }

  async sweepExpiredEnvironments(options: {
    now?: number;
    limit?: number;
  } = {}): Promise<SweepExpiredExecutionEnvironmentsResult> {
    if (!this.manager) {
      return {
        checked: 0,
        stopped: 0,
        failed: 0,
      };
    }

    const expired = await this.store.listExpiredDisposableEnvironments(
      options.now ?? Date.now(),
      options.limit ?? 20,
    );
    let stopped = 0;
    let failed = 0;
    for (const environment of expired) {
      try {
        await stopExecutionEnvironment({
          environmentId: environment.id,
          manager: this.manager,
          store: this.store,
          expiresBefore: options.now ?? Date.now(),
        });
        stopped += 1;
      } catch (error) {
        failed += 1;
        console.error("Execution environment expiry sweep could not settle", {
          environmentId: environment.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      checked: expired.length,
      stopped,
      failed,
    };
  }
}
