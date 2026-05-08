import type {SessionRecord} from "../../domain/sessions/index.js";
import type {
    ExecutionCredentialPolicy,
    ExecutionEnvironmentRecord,
    ExecutionEnvironmentStore,
    ExecutionSkillPolicy,
    ResolvedExecutionEnvironment,
    SessionEnvironmentBindingRecord
} from "../../domain/execution-environments/index.js";
import {
    resolveBashExecutionMode,
    resolveRunnerCwd,
    resolveRunnerCwdTemplate,
    resolveRunnerUrl,
    resolveRunnerUrlTemplate,
} from "../../integrations/shell/bash-executor.js";

export interface ExecutionEnvironmentResolverOptions {
  store: ExecutionEnvironmentStore;
  env?: NodeJS.ProcessEnv;
}

function resolveExecutionMode(environment: Pick<ExecutionEnvironmentRecord, "kind">): "local" | "remote" {
  return environment.kind === "local" ? "local" : "remote";
}

function defaultPersistentCredentialPolicy(session: Pick<SessionRecord, "kind">): ExecutionCredentialPolicy {
  return session.kind === "worker" ? {mode: "allowlist", envKeys: []} : {mode: "all_agent"};
}

function defaultPersistentSkillPolicy(session: Pick<SessionRecord, "kind">): ExecutionSkillPolicy {
  return session.kind === "worker" ? {mode: "allowlist", skillKeys: []} : {mode: "all_agent"};
}

function resolveFallbackEnvironment(
  session: Pick<SessionRecord, "agentKey" | "kind">,
  env: NodeJS.ProcessEnv,
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
    credentialPolicy: defaultPersistentCredentialPolicy(session),
    skillPolicy: defaultPersistentSkillPolicy(session),
    toolPolicy: {},
    source: "fallback",
  };
}

export class ExecutionEnvironmentResolver {
  private readonly store: ExecutionEnvironmentStore;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ExecutionEnvironmentResolverOptions) {
    this.store = options.store;
    this.env = options.env ?? process.env;
  }

  async resolveDefault(
    session: Pick<SessionRecord, "id" | "agentKey" | "kind">,
  ): Promise<ResolvedExecutionEnvironment> {
    const binding = await this.store.getDefaultBinding(session.id);
    if (!binding) {
      if (session.kind === "worker") {
        throw new Error(`Worker session ${session.id} has no default execution environment binding.`);
      }
      return resolveFallbackEnvironment(session, this.env);
    }

    return this.resolveBinding(session, binding);
  }

  private async resolveBinding(
    session: Pick<SessionRecord, "id" | "agentKey" | "kind">,
    binding: SessionEnvironmentBindingRecord,
  ): Promise<ResolvedExecutionEnvironment> {
    const environment = await this.store.getEnvironment(binding.environmentId);
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
