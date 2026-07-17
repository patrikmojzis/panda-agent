import {randomBytes} from "node:crypto";

import type {CommandCatalog} from "../../domain/commands/modules.js";
import type {CommandPolicyModule, CommandScope} from "../../domain/commands/types.js";
import {resolveCommandLeaseAuthority} from "../../domain/execution-environments/command-authority.js";
import {
  normalizeAgentSkillOperations,
} from "../../domain/execution-environments/policy.js";
import type {
  ExecutionCredentialPolicy,
  ExecutionSkillPolicy,
  ExecutionToolPolicy,
} from "../../domain/execution-environments/types.js";
import type {CommandLeaseVerifier} from "../../integrations/commands/http-server.js";

const DEFAULT_COMMAND_LEASE_TTL_MS = 60 * 60 * 1_000;

export interface IssuedCommandLease {
  url?: string;
  socketPath?: string;
  token: string;
  expiresAt: string;
}

export interface IssueCommandLeaseInput {
  agentKey: string;
  sessionId: string;
  environmentId?: string;
  identityId?: string;
  inputMessageId?: string;
  toolPolicy?: ExecutionToolPolicy;
  skillPolicy?: ExecutionSkillPolicy;
  credentialPolicy?: ExecutionCredentialPolicy;
  credentialMutationAllowed?: boolean;
  socketAccessAllowed?: boolean;
  ttlMs?: number;
}

export interface CommandLeaseIssuer {
  issueCommandLease(input: IssueCommandLeaseInput): IssuedCommandLease | null;
  hasUsableTransport?(input?: {socketAccessAllowed?: boolean}): boolean;
}

interface RuntimeCommandLeaseServiceOptions {
  baseUrl?: string;
  socketPath?: string;
  readonlyPostgresCommandAllowed?: boolean;
  commandCatalog?: Pick<CommandCatalog, "modules">;
  commandModules?: readonly CommandPolicyModule[];
  now?: () => Date;
}

function assertSingleCommandPolicySource(
  options: Pick<RuntimeCommandLeaseServiceOptions, "commandCatalog" | "commandModules">,
): void {
  if (options.commandCatalog && options.commandModules) {
    throw new Error("Pass either commandCatalog or commandModules, not both.");
  }
}

function isExpired(scope: CommandScope, now: Date): boolean {
  if (!scope.expiresAt) {
    return false;
  }

  const expiresAt = Date.parse(scope.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

export class RuntimeCommandLeaseService implements CommandLeaseVerifier, CommandLeaseIssuer {
  private readonly leases = new Map<string, CommandScope>();
  private readonly baseUrl?: string;
  private readonly socketPath?: string;
  private readonly readonlyPostgresCommandAllowed: boolean;
  private readonly commandCatalog?: Pick<CommandCatalog, "modules">;
  private readonly commandModules?: readonly CommandPolicyModule[];
  private readonly now: () => Date;

  constructor(options: RuntimeCommandLeaseServiceOptions) {
    assertSingleCommandPolicySource(options);
    this.baseUrl = options.baseUrl;
    this.socketPath = options.socketPath;
    this.readonlyPostgresCommandAllowed = options.readonlyPostgresCommandAllowed === true;
    this.commandCatalog = options.commandCatalog;
    this.commandModules = options.commandModules;
    this.now = options.now ?? (() => new Date());
  }

  hasUsableTransport(input: {socketAccessAllowed?: boolean} = {}): boolean {
    return Boolean(this.baseUrl || (input.socketAccessAllowed !== false && this.socketPath));
  }

  issueCommandLease(input: IssueCommandLeaseInput): IssuedCommandLease | null {
    const socketPath = input.socketAccessAllowed === false ? undefined : this.socketPath;
    if (!this.baseUrl && !socketPath) {
      return null;
    }

    const allowedCommands = resolveCommandLeaseAuthority({
      commandCatalog: this.commandCatalog,
      commandModules: this.commandModules,
      toolPolicy: input.toolPolicy,
      credentialMutationAllowed: input.credentialMutationAllowed === true,
      readonlyPostgresCommandAllowed: this.readonlyPostgresCommandAllowed,
      identityScoped: Boolean(input.identityId),
    });
    if (allowedCommands.length === 0) {
      return null;
    }

    const token = `panda-command-v1.${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(this.now().getTime() + (input.ttlMs ?? DEFAULT_COMMAND_LEASE_TTL_MS)).toISOString();
    this.leases.set(token, {
      agentKey: input.agentKey,
      sessionId: input.sessionId,
      ...(input.environmentId ? {environmentId: input.environmentId} : {}),
      ...(input.identityId ? {identityId: input.identityId} : {}),
      ...(input.inputMessageId ? {inputMessageId: input.inputMessageId} : {}),
      allowedCommands,
      expiresAt,
      credentialMutationAllowed: input.credentialMutationAllowed === true,
      ...(input.credentialPolicy ? {credentialPolicy: input.credentialPolicy} : {}),
      ...(input.skillPolicy ? {skillPolicy: input.skillPolicy} : {}),
      ...(input.toolPolicy?.agentSkill?.allowedOperations
        ? {agentSkillAllowedOperations: normalizeAgentSkillOperations(input.toolPolicy.agentSkill.allowedOperations)}
        : {}),
    });

    return {
      ...(this.baseUrl ? {url: this.baseUrl} : {}),
      ...(socketPath ? {socketPath} : {}),
      token,
      expiresAt,
    };
  }

  async verify(token: string): Promise<CommandScope | undefined> {
    const scope = this.leases.get(token);
    if (!scope) {
      return undefined;
    }
    if (isExpired(scope, this.now())) {
      this.leases.delete(token);
      return undefined;
    }

    return scope;
  }
}
