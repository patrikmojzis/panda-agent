import {randomUUID} from "node:crypto";

import type {
  DisposableEnvironmentCreateResult,
  ExecutionCredentialPolicy,
  ExecutionEnvironmentManager,
  ExecutionEnvironmentRecord,
  ExecutionEnvironmentStore,
  ExecutionSkillPolicy,
  ExecutionToolPolicy,
  SessionEnvironmentBindingRecord,
} from "../../domain/execution-environments/index.js";
import type {SessionRecord} from "../../domain/sessions/index.js";
import type {JsonValue} from "../../kernel/agent/types.js";
import {stableStringify} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";

const DEFAULT_DISPOSABLE_ALIAS = "self";

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
  store: ExecutionEnvironmentStore;
  manager?: ExecutionEnvironmentManager | null;
}

function buildDisposableEnvironmentId(sessionId: string): string {
  return `disposable:${sessionId}:${randomUUID()}`;
}

function buildStandaloneEnvironmentId(sessionId: string): string {
  return `environment:${sessionId}:${randomUUID()}`;
}

function mergeMetadata(...values: Array<JsonValue | undefined>): JsonValue | undefined {
  const records = values.filter(isRecord);
  if (records.length === values.filter((entry) => entry !== undefined).length) {
    return Object.assign({}, ...records) as JsonValue;
  }
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
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

export class ExecutionEnvironmentLifecycleService {
  private readonly store: ExecutionEnvironmentStore;
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
        !sameJson(existingBinding.credentialPolicy as unknown as JsonValue, credentialPolicy as unknown as JsonValue)
        || !sameJson(existingBinding.skillPolicy as unknown as JsonValue, skillPolicy as unknown as JsonValue)
        || !sameJson(existingBinding.toolPolicy as unknown as JsonValue, toolPolicy as unknown as JsonValue)
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
    if (isExpired(environment)) {
      throw new Error(`Execution environment ${environment.id} is expired.`);
    }
    if (environment.state === "stopped") {
      environment = await this.restartDisposableEnvironment(environment);
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

  private async restartDisposableEnvironment(
    environment: ExecutionEnvironmentRecord,
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
      const ttlMs = remainingTtlMs(environment);
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

    const existing = await this.store.getEnvironment(environmentId);
    await this.store.createEnvironment({
      ...existing,
      state: "stopping",
    });
    await this.manager.stopEnvironment(environmentId);
    return this.store.createEnvironment({
      ...existing,
      state: "stopped",
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
