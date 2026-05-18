import {randomUUID} from "node:crypto";

import type {
  DisposableEnvironmentCreateResult,
  ExecutionCredentialPolicy,
  ExecutionEnvironmentManager,
  ExecutionEnvironmentRecord,
  ExecutionSkillPolicy,
  ExecutionToolPolicy,
  SessionEnvironmentBindingRecord,
} from "../../domain/execution-environments/types.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import type {JsonValue} from "../../lib/json.js";
import {isJsonObject, normalizeToJsonValue, stableStringify} from "../../lib/json.js";
import {trimToUndefined} from "../../lib/strings.js";

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

export interface EnsureBoundSessionEnvironmentReadyInput {
  session: Pick<SessionRecord, "id" | "agentKey">;
  binding: SessionEnvironmentBindingRecord;
  ttlMs?: number;
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
}

export type ExecutionEnvironmentStopStore = Pick<
  ExecutionEnvironmentStore,
  "createEnvironment" | "getEnvironment"
>;

type ExecutionEnvironmentLifecycleStore = ExecutionEnvironmentStopStore & Pick<
  ExecutionEnvironmentStore,
  | "bindSession"
  | "getDefaultBinding"
  | "listExpiredDisposableEnvironments"
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

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return stableStringify(left) === stableStringify(right);
}

export async function stopExecutionEnvironment(input: {
  environmentId: string;
  manager: ExecutionEnvironmentManager;
  store: ExecutionEnvironmentStopStore;
}): Promise<ExecutionEnvironmentRecord> {
  const existing = await input.store.getEnvironment(input.environmentId);
  await input.store.createEnvironment({
    ...existing,
    state: "stopping",
  });
  await input.manager.stopEnvironment(input.environmentId);
  return input.store.createEnvironment({
    ...existing,
    state: "stopped",
  });
}

export class ExecutionEnvironmentLifecycleService {
  private readonly store: ExecutionEnvironmentLifecycleStore;
  private readonly manager: ExecutionEnvironmentManager | null;

  constructor(options: ExecutionEnvironmentLifecycleServiceOptions) {
    this.store = options.store;
    this.manager = options.manager ?? null;
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

    await this.store.createEnvironment({
      id: environmentId,
      agentKey: input.session.agentKey,
      kind: "disposable_container",
      state: "provisioning",
      createdBySessionId: input.createdBySessionId,
      createdForSessionId: input.session.id,
      expiresAt,
      metadata: input.metadata,
    });

    let created: DisposableEnvironmentCreateResult | null = null;
    try {
      created = await this.manager.createDisposableEnvironment({
        agentKey: input.session.agentKey,
        sessionId: input.session.id,
        environmentId,
        ...(input.ttlMs === undefined ? {} : {ttlMs: input.ttlMs}),
        ...(input.metadata === undefined ? {} : {metadata: input.metadata}),
      });

      const environment = await this.store.createEnvironment({
        id: environmentId,
        agentKey: input.session.agentKey,
        kind: "disposable_container",
        state: "ready",
        runnerUrl: created.runnerUrl,
        runnerCwd: created.runnerCwd,
        rootPath: created.rootPath,
        createdBySessionId: input.createdBySessionId,
        createdForSessionId: input.session.id,
        expiresAt,
        metadata: mergeMetadata(input.metadata, created.metadata),
      });
      const binding = await this.store.bindSession({
        sessionId: input.session.id,
        environmentId,
        alias: trimToUndefined(input.alias) ?? DEFAULT_DISPOSABLE_ALIAS,
        isDefault: input.isDefault ?? true,
        credentialPolicy,
        skillPolicy,
        toolPolicy,
      });

      return {environment, binding};
    } catch (error) {
      if (created) {
        await this.manager.stopEnvironment(environmentId).catch(() => {});
      }
      await this.store.createEnvironment({
        id: environmentId,
        agentKey: input.session.agentKey,
        kind: "disposable_container",
        state: "failed",
        runnerUrl: created?.runnerUrl,
        runnerCwd: created?.runnerCwd,
        rootPath: created?.rootPath,
        createdBySessionId: input.createdBySessionId,
        createdForSessionId: input.session.id,
        expiresAt,
        metadata: mergeMetadata(input.metadata, created?.metadata, errorMetadata(error)),
      });
      throw error;
    }
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

    const environmentId = trimToUndefined(input.environmentId) ?? buildStandaloneEnvironmentId(ownerSessionId);
    const expiresAt = input.ttlMs === undefined ? undefined : Date.now() + input.ttlMs;
    await this.store.createEnvironment({
      id: environmentId,
      agentKey,
      kind: "disposable_container",
      state: "provisioning",
      createdBySessionId: ownerSessionId,
      expiresAt,
      metadata: input.metadata,
    });

    let created: DisposableEnvironmentCreateResult | null = null;
    try {
      created = await this.manager.createDisposableEnvironment({
        agentKey,
        sessionId: ownerSessionId,
        environmentId,
        ...(input.ttlMs === undefined ? {} : {ttlMs: input.ttlMs}),
        ...(input.metadata === undefined ? {} : {metadata: input.metadata}),
      });

      return this.store.createEnvironment({
        id: environmentId,
        agentKey,
        kind: "disposable_container",
        state: "ready",
        runnerUrl: created.runnerUrl,
        runnerCwd: created.runnerCwd,
        rootPath: created.rootPath,
        createdBySessionId: ownerSessionId,
        expiresAt,
        metadata: mergeMetadata(input.metadata, created.metadata),
      });
    } catch (error) {
      if (created) {
        await this.manager.stopEnvironment(environmentId).catch(() => {});
      }
      await this.store.createEnvironment({
        id: environmentId,
        agentKey,
        kind: "disposable_container",
        state: "failed",
        runnerUrl: created?.runnerUrl,
        runnerCwd: created?.runnerCwd,
        rootPath: created?.rootPath,
        createdBySessionId: ownerSessionId,
        expiresAt,
        metadata: mergeMetadata(input.metadata, created?.metadata, errorMetadata(error)),
      });
      throw error;
    }
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

  async ensureBoundEnvironmentReady(
    input: EnsureBoundSessionEnvironmentReadyInput,
  ): Promise<ExecutionEnvironmentRecord> {
    let environment = await this.store.getEnvironment(input.binding.environmentId);
    if (environment.agentKey !== input.session.agentKey) {
      throw new Error(`Execution environment ${environment.id} does not belong to agent ${input.session.agentKey}.`);
    }
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

    const managerSessionId = environment.createdForSessionId ?? environment.createdBySessionId;
    if (!managerSessionId) {
      throw new Error(`Execution environment ${environment.id} is missing an owning session id.`);
    }

    await this.store.createEnvironment({
      ...environment,
      state: "provisioning",
    });

    let created: DisposableEnvironmentCreateResult | null = null;
    try {
      const ttlMs = options.ttlMs ?? remainingTtlMs(environment);
      const expiresAt = options.ttlMs === undefined ? environment.expiresAt : Date.now() + options.ttlMs;
      created = await this.manager.createDisposableEnvironment({
        agentKey: environment.agentKey,
        sessionId: managerSessionId,
        environmentId: environment.id,
        ...(ttlMs === undefined ? {} : {ttlMs}),
        ...(environment.metadata === undefined ? {} : {metadata: environment.metadata}),
      });
      return this.store.createEnvironment({
        ...environment,
        state: "ready",
        runnerUrl: created.runnerUrl,
        runnerCwd: created.runnerCwd,
        rootPath: created.rootPath,
        expiresAt,
        metadata: mergeMetadata(environment.metadata, created.metadata),
      });
    } catch (error) {
      if (created) {
        await this.manager.stopEnvironment(environment.id).catch(() => {});
      }
      await this.store.createEnvironment({
        ...environment,
        state: "failed",
        runnerUrl: created?.runnerUrl ?? environment.runnerUrl,
        runnerCwd: created?.runnerCwd ?? environment.runnerCwd,
        rootPath: created?.rootPath ?? environment.rootPath,
        metadata: mergeMetadata(environment.metadata, created?.metadata, errorMetadata(error)),
      });
      throw error;
    }
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
        await this.stopEnvironment(environment.id);
        stopped += 1;
      } catch (error) {
        failed += 1;
        await this.store.createEnvironment({
          ...environment,
          state: "failed",
          metadata: mergeMetadata(environment.metadata, errorMetadata(error)),
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
