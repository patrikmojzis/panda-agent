import type {SessionRecord} from "../../domain/sessions/types.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import type {
  ExecutionCredentialPolicy,
  ExecutionEnvironmentRecord,
  ExecutionSkillPolicy,
  ExecutionToolPolicy,
  ResolvedExecutionEnvironment,
  SessionEnvironmentBindingRecord,
} from "../../domain/execution-environments/types.js";
import {readSubagentSessionMetadata} from "../../domain/subagents/session-metadata.js";
import {
  resolveBashExecutionMode,
  resolveRunnerCwd,
  resolveRunnerCwdTemplate,
  resolveRunnerUrl,
  resolveRunnerUrlTemplate,
} from "../../integrations/shell/bash-executor.js";

type ExecutionEnvironmentResolverStore = Pick<ExecutionEnvironmentStore, "getDefaultBinding" | "getEnvironment">;

type ResolverSession = Pick<SessionRecord, "id" | "agentKey" | "kind" | "metadata">;

export interface ExecutionEnvironmentResolverOptions {
  store: ExecutionEnvironmentResolverStore;
  lifecycle?: {
    ensureBoundEnvironmentReady(input: {
      session: Pick<SessionRecord, "id" | "agentKey">;
      binding: SessionEnvironmentBindingRecord;
    }): Promise<ExecutionEnvironmentRecord>;
  };
  env?: NodeJS.ProcessEnv;
}

function resolveExecutionMode(environment: Pick<ExecutionEnvironmentRecord, "kind">): "local" | "remote" {
  return environment.kind === "local" ? "local" : "remote";
}

function defaultPersistentCredentialPolicy(session: Pick<SessionRecord, "kind">): ExecutionCredentialPolicy {
  return session.kind === "worker" || session.kind === "subagent" ? {mode: "allowlist", envKeys: []} : {mode: "all_agent"};
}

function defaultPersistentSkillPolicy(session: Pick<SessionRecord, "kind">): ExecutionSkillPolicy {
  return session.kind === "worker" ? {mode: "allowlist", skillKeys: []} : {mode: "all_agent"};
}

function resolveFallbackEnvironment(
  session: Pick<SessionRecord, "agentKey" | "kind">,
  env: NodeJS.ProcessEnv,
  policies: {
    credentialPolicy?: ExecutionCredentialPolicy;
    skillPolicy?: ExecutionSkillPolicy;
    toolPolicy?: ExecutionToolPolicy;
  } = {},
): ResolvedExecutionEnvironment {
  const executionMode = resolveBashExecutionMode(env);
  const runnerUrlTemplate = resolveRunnerUrlTemplate(env);
  const runnerCwdTemplate = resolveRunnerCwdTemplate(env);
  const runnerUrl = executionMode === "remote" && runnerUrlTemplate
    ? resolveRunnerUrl(runnerUrlTemplate, session.agentKey)
    : undefined;
  const initialCwd = executionMode === "remote" && runnerCwdTemplate
    ? resolveRunnerCwd(runnerCwdTemplate, session.agentKey)
    : undefined;

  return {
    id: executionMode === "remote"
      ? `persistent_agent_runner:${session.agentKey}`
      : `local:${session.agentKey}`,
    agentKey: session.agentKey,
    kind: executionMode === "remote" ? "persistent_agent_runner" : "local",
    state: "ready",
    executionMode,
    ...(runnerUrl ? {runnerUrl} : {}),
    ...(initialCwd ? {initialCwd} : {}),
    credentialPolicy: policies.credentialPolicy ?? defaultPersistentCredentialPolicy(session),
    skillPolicy: policies.skillPolicy ?? defaultPersistentSkillPolicy(session),
    toolPolicy: policies.toolPolicy ?? {},
    source: "fallback",
  };
}

export class ExecutionEnvironmentResolver {
  private readonly store: ExecutionEnvironmentResolverStore;
  private readonly lifecycle?: NonNullable<ExecutionEnvironmentResolverOptions["lifecycle"]>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ExecutionEnvironmentResolverOptions) {
    this.store = options.store;
    this.lifecycle = options.lifecycle;
    this.env = options.env ?? process.env;
  }

  async resolveDefault(
    session: ResolverSession,
  ): Promise<ResolvedExecutionEnvironment> {
    const binding = await this.store.getDefaultBinding(session.id);
    if (!binding) {
      if (session.kind === "worker") {
        throw new Error(`Worker session ${session.id} has no default execution environment binding.`);
      }
      if (session.kind === "subagent") {
        const subagent = readSubagentSessionMetadata(session.metadata);
        if (!subagent) {
          throw new Error(`Subagent session ${session.id} is missing subagent metadata.`);
        }
        if (subagent.execution === "isolated_environment") {
          throw new Error(`Isolated subagent session ${session.id} has no default execution environment binding.`);
        }
        return resolveFallbackEnvironment(session, this.env, {
          credentialPolicy: subagent.resolved.credentialPolicy,
          skillPolicy: subagent.resolved.skillPolicy,
          toolPolicy: subagent.resolved.toolPolicy,
        });
      }
      return resolveFallbackEnvironment(session, this.env);
    }

    return this.resolveBinding(session, binding);
  }

  private async resolveBinding(
    session: ResolverSession,
    binding: SessionEnvironmentBindingRecord,
  ): Promise<ResolvedExecutionEnvironment> {
    const subagent = session.kind === "subagent"
      ? readSubagentSessionMetadata(session.metadata)
      : null;
    if (session.kind === "subagent" && !subagent) {
      throw new Error(`Subagent session ${session.id} is missing subagent metadata.`);
    }

    const isIsolatedSubagent = session.kind === "subagent" && subagent?.execution === "isolated_environment";
    if (isIsolatedSubagent && binding.environmentId !== subagent.environmentId) {
      throw new Error(
        `Isolated subagent session ${session.id} is bound to environment ${binding.environmentId}, but metadata requires ${subagent.environmentId}.`,
      );
    }

    const environment = isIsolatedSubagent
      ? await this.store.getEnvironment(binding.environmentId)
      : this.lifecycle
        ? await this.lifecycle.ensureBoundEnvironmentReady({session, binding})
        : await this.store.getEnvironment(binding.environmentId);
    if (isIsolatedSubagent && environment.kind !== "disposable_container") {
      throw new Error(
        `Isolated subagent session ${session.id} requires a disposable execution environment, got ${environment.kind}.`,
      );
    }
    if (environment.agentKey !== session.agentKey) {
      throw new Error(`Execution environment ${environment.id} does not belong to agent ${session.agentKey}.`);
    }
    if (environment.state !== "ready") {
      throw new Error(`Execution environment ${environment.id} is ${environment.state}.`);
    }
    if (environment.expiresAt !== undefined && environment.expiresAt <= Date.now()) {
      throw new Error(`Execution environment ${environment.id} is expired.`);
    }

    const executionMode = resolveExecutionMode(environment);
    if (executionMode === "remote" && !environment.runnerUrl) {
      throw new Error(`Remote execution environment ${environment.id} is missing runnerUrl.`);
    }

    return {
      id: environment.id,
      agentKey: environment.agentKey,
      kind: environment.kind,
      state: environment.state,
      executionMode,
      ...(environment.runnerUrl ? {runnerUrl: environment.runnerUrl} : {}),
      ...(environment.runnerCwd ? {initialCwd: environment.runnerCwd} : {}),
      ...(environment.rootPath ? {rootPath: environment.rootPath} : {}),
      ...(environment.metadata !== undefined ? {metadata: environment.metadata} : {}),
      alias: binding.alias,
      credentialPolicy: binding.credentialPolicy,
      skillPolicy: binding.skillPolicy,
      toolPolicy: binding.toolPolicy,
      source: "binding",
    };
  }
}
