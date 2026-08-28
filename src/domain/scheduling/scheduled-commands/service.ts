import {randomUUID} from "node:crypto";

import {normalizeCredentialEnvKey} from "../../credentials/types.js";
import type {CredentialResolver} from "../../credentials/resolver.js";
import {commandScopeDenied, commandStaleVersionConflict} from "../../commands/errors.js";
import type {ExecutionCredentialPolicy} from "../../execution-environments/types.js";
import {computeRecurringNextFireAt, normalizeScheduledTaskSchedule} from "../tasks/schedule.js";
import type {ScheduledCommandIntegrity} from "./integrity.js";
import {ScheduledCommandVersionConflictError, type ScheduledCommandStore} from "./store.js";
import type {
  ScheduledCommandListStatus,
  ScheduledCommandRecord,
  ScheduledCommandRunRecord,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 6 * 60 * 60_000;
const MAX_COMMAND_LENGTH = 64_000;
const MAX_TITLE_LENGTH = 200;
const MAX_CREDENTIALS = 64;

export interface ScheduledCommandActor {
  sessionId: string;
  agentKey: string;
  identityId?: string;
  inputMessageId?: string;
  credentialPolicy?: ExecutionCredentialPolicy;
}

export interface ScheduledCommandDefinitionInput {
  title: string;
  command: string;
  cwd?: string;
  cron: string;
  timezone: string;
  credentialNames?: readonly string[];
  timeoutMs?: number;
  enabled?: boolean;
}

export interface ScheduledCommandUpdateInput {
  expectedVersion: number;
  title?: string;
  command?: string;
  cwd?: string | null;
  cron?: string;
  timezone?: string;
  credentialNames?: readonly string[];
  timeoutMs?: number;
  enabled?: boolean;
}

export interface ScheduledCommandServiceOptions {
  store: ScheduledCommandStore;
  integrity: ScheduledCommandIntegrity;
  credentials: Pick<CredentialResolver, "resolveCredential">;
  now?: () => number;
}

function requireText(label: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Scheduled command ${label} must not be empty.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`Scheduled command ${label} must not exceed ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Scheduled command timeoutMs must be an integer between 1000 and ${MAX_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

function normalizeCredentials(values: readonly string[] | undefined): string[] {
  const names = [...new Set((values ?? []).map(normalizeCredentialEnvKey))].sort();
  if (names.length > MAX_CREDENTIALS) {
    throw new Error(`Scheduled commands may request at most ${MAX_CREDENTIALS} credentials.`);
  }
  return names;
}

function assertCredentialPolicy(policy: ExecutionCredentialPolicy | undefined, names: readonly string[]): void {
  if (names.length === 0 || policy?.mode === "all_agent") {
    return;
  }
  const allowed = policy?.mode === "allowlist" ? new Set(policy.envKeys) : new Set<string>();
  if (names.some((name) => !allowed.has(name))) {
    throw commandScopeDenied(
      "A credential requested by this scheduled command is not allowed in the current execution scope.",
      "command_scope_denied",
      "Use only credentials allowed by the current execution environment.",
    );
  }
}

function assertRecordInSession(record: ScheduledCommandRecord, sessionId: string): void {
  if (record.sessionId !== sessionId) {
    throw commandScopeDenied(
      "The scheduled command is not visible to the current session.",
      "resource_scope_denied",
      "Use a scheduled command owned by the current session.",
    );
  }
}

export class ScheduledCommandService {
  private readonly store: ScheduledCommandStore;
  private readonly integrity: ScheduledCommandIntegrity;
  private readonly credentials: Pick<CredentialResolver, "resolveCredential">;
  private readonly now: () => number;

  constructor(options: ScheduledCommandServiceOptions) {
    this.store = options.store;
    this.integrity = options.integrity;
    this.credentials = options.credentials;
    this.now = options.now ?? Date.now;
  }

  async create(actor: ScheduledCommandActor, input: ScheduledCommandDefinitionInput): Promise<ScheduledCommandRecord> {
    const id = randomUUID();
    const fields = this.normalizeDefinition(input);
    await this.assertCredentialsAvailable(actor, fields.credentialNames);
    const signable = {
      commandId: id,
      sessionId: actor.sessionId,
      version: 1,
      ...fields,
    };
    const signature = this.integrity.sign(signable);
    return this.store.createCommand({
      id,
      sessionId: actor.sessionId,
      createdByIdentityId: actor.identityId,
      createdFromMessageId: actor.inputMessageId,
      definition: {...fields, ...signature},
      nextFireAt: fields.enabled
        ? computeRecurringNextFireAt({kind: "recurring", cron: fields.cron, timezone: fields.timezone}, this.now())
        : undefined,
    });
  }

  async update(
    actor: ScheduledCommandActor,
    commandId: string,
    input: ScheduledCommandUpdateInput,
  ): Promise<ScheduledCommandRecord> {
    return this.replace(actor, commandId, input, true);
  }

  async setEnabled(
    actor: ScheduledCommandActor,
    commandId: string,
    enabled: boolean,
    expectedVersion: number,
  ): Promise<ScheduledCommandRecord> {
    // Revoked credentials or Bash authority must never prevent an agent from
    // disabling persistent work. Enabling still receives the full preflight.
    return this.replace(actor, commandId, {expectedVersion, enabled}, enabled);
  }

  private async replace(
    actor: ScheduledCommandActor,
    commandId: string,
    input: ScheduledCommandUpdateInput,
    preflightCredentials: boolean,
  ): Promise<ScheduledCommandRecord> {
    const existing = await this.readVerified(commandId, actor.sessionId);
    this.assertExpectedVersion(existing, input.expectedVersion);
    const fields = this.normalizeDefinition({
      title: input.title ?? existing.title,
      command: input.command ?? existing.command,
      cwd: input.cwd === null ? undefined : input.cwd ?? existing.cwd,
      cron: input.cron ?? existing.cron,
      timezone: input.timezone ?? existing.timezone,
      credentialNames: input.credentialNames ?? existing.credentialNames,
      timeoutMs: input.timeoutMs ?? existing.timeoutMs,
      enabled: input.enabled ?? existing.enabled,
    });
    if (preflightCredentials) {
      await this.assertCredentialsAvailable(actor, fields.credentialNames);
    }
    const version = existing.version + 1;
    const signable = {commandId, sessionId: actor.sessionId, version, ...fields};
    const signature = this.integrity.sign(signable);
    return this.runVersionedMutation(commandId, input.expectedVersion, () => this.store.replaceVersion({
      commandId,
      sessionId: actor.sessionId,
      expectedVersion: input.expectedVersion,
      definition: {...fields, ...signature},
      nextFireAt: fields.enabled
        ? computeRecurringNextFireAt({kind: "recurring", cron: fields.cron, timezone: fields.timezone}, this.now())
        : undefined,
    }));
  }

  async delete(actor: Pick<ScheduledCommandActor, "sessionId">, commandId: string, expectedVersion: number): Promise<boolean> {
    const existing = await this.store.getCommand(commandId);
    assertRecordInSession(existing, actor.sessionId);
    this.assertExpectedVersion(existing, expectedVersion);
    const deleted = await this.runVersionedMutation(commandId, expectedVersion, () => this.store.deleteCommand({
      commandId,
      sessionId: actor.sessionId,
      expectedVersion,
    }));
    if (!deleted) {
      throw new Error(`Scheduled command ${commandId} changed before it could be deleted. Refresh it before retrying.`);
    }
    return true;
  }

  async runNow(actor: ScheduledCommandActor, commandId: string, expectedVersion: number): Promise<ScheduledCommandRunRecord> {
    const existing = await this.readVerified(commandId, actor.sessionId);
    this.assertExpectedVersion(existing, expectedVersion);
    await this.assertCredentialsAvailable(actor, existing.credentialNames);
    return this.runVersionedMutation(commandId, expectedVersion, () => this.store.enqueueManualRun({
      commandId,
      sessionId: actor.sessionId,
      expectedVersion,
    }));
  }

  async show(sessionId: string, commandId: string): Promise<ScheduledCommandRecord> {
    const record = await this.store.getCommand(commandId);
    assertRecordInSession(record, sessionId);
    return record;
  }

  verifyDefinition(record: ScheduledCommandRecord): boolean {
    return this.integrity.verify(record);
  }

  list(sessionId: string, status?: ScheduledCommandListStatus, limit?: number): Promise<readonly ScheduledCommandRecord[]> {
    return this.store.listCommands({sessionId, status, limit});
  }

  async runs(sessionId: string, commandId: string, limit?: number): Promise<readonly ScheduledCommandRunRecord[]> {
    await this.show(sessionId, commandId);
    return this.store.listRuns({sessionId, commandId, limit});
  }

  private normalizeDefinition(input: ScheduledCommandDefinitionInput) {
    const schedule = normalizeScheduledTaskSchedule({
      kind: "recurring",
      cron: input.cron,
      timezone: input.timezone,
    });
    if (schedule.kind !== "recurring") {
      throw new Error("Scheduled commands must use recurring schedules.");
    }
    return {
      title: requireText("title", input.title, MAX_TITLE_LENGTH),
      command: requireText("command", input.command, MAX_COMMAND_LENGTH),
      ...(input.cwd === undefined ? {} : {cwd: requireText("cwd", input.cwd, 2_048)}),
      cron: schedule.cron,
      timezone: schedule.timezone,
      credentialNames: normalizeCredentials(input.credentialNames),
      timeoutMs: normalizeTimeout(input.timeoutMs),
      enabled: input.enabled ?? true,
    };
  }

  private async assertCredentialsAvailable(actor: ScheduledCommandActor, names: readonly string[]): Promise<void> {
    assertCredentialPolicy(actor.credentialPolicy, names);
    for (const name of names) {
      const credential = await this.credentials.resolveCredential(name, {agentKey: actor.agentKey});
      if (!credential) {
        throw new Error(`Scheduled command credential ${name} is not configured for agent ${actor.agentKey}.`);
      }
    }
  }

  private async readVerified(commandId: string, sessionId: string): Promise<ScheduledCommandRecord> {
    const record = await this.store.getCommand(commandId);
    assertRecordInSession(record, sessionId);
    if (!this.integrity.verify(record)) {
      throw new Error(`Scheduled command ${commandId} failed its integrity check and can only be deleted.`);
    }
    if (record.blockedAt !== undefined) {
      throw new Error(`Scheduled command ${commandId} is blocked: ${record.blockedReason ?? "integrity violation"}.`);
    }
    return record;
  }

  private assertExpectedVersion(record: ScheduledCommandRecord, expectedVersion: number): void {
    if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      throw new Error("Scheduled command expectedVersion must be a positive integer.");
    }
    if (record.version !== expectedVersion) {
      throw this.staleVersionConflict(record.commandId, record.version, expectedVersion);
    }
  }

  private async runVersionedMutation<T>(
    commandId: string,
    expectedVersion: number,
    mutation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await mutation();
    } catch (error) {
      if (error instanceof ScheduledCommandVersionConflictError) {
        throw this.staleVersionConflict(commandId, error.currentVersion, expectedVersion);
      }
      throw error;
    }
  }

  private staleVersionConflict(commandId: string, currentVersion: number, expectedVersion: number): Error {
    return commandStaleVersionConflict({
      message: `Scheduled command ${commandId} is version ${currentVersion}, not expected version ${expectedVersion}.`,
      resource: {
        kind: "scheduled_command",
        id: commandId,
        latestRevision: currentVersion,
      },
      nextAction: {
        kind: "refresh_merge_write",
        command: `panda cron show ${commandId}`,
      },
    });
  }
}
