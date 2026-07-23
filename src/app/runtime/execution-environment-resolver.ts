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
import {
  DEFAULT_EXECUTION_TARGET_ALIAS,
  normalizeExecutionTargetAlias,
} from "../../domain/execution-environments/types.js";
import {readSubagentSessionMetadata} from "../../domain/subagents/session-metadata.js";
import {
  resolveBashExecutionMode,
  resolveRunnerCwd,
  resolveRunnerCwdTemplate,
  resolveRunnerUrl,
  resolveRunnerUrlTemplate,
} from "../../integrations/shell/bash-executor.js";

type ExecutionEnvironmentResolverStore = Pick<ExecutionEnvironmentStore, "getDefaultBinding" | "getBindingByAlias" | "getEnvironment">;

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
  return session.kind === "subagent" ? {mode: "allowlist", envKeys: []} : {mode: "all_agent"};
}

function defaultPersistentSkillPolicy(_session: Pick<SessionRecord, "kind">): ExecutionSkillPolicy {
  return {mode: "all_agent"};
}

function defaultPersistentToolPolicy(session: Pick<SessionRecord, "kind">): ExecutionToolPolicy {
  if (session.kind === "subagent") {
    return {};
  }

  return {
    allowedTools: [
      "a2a.history",
      "a2a.inspect",
      "a2a.send",
      "skill.list",
      "skill.show",
      "skill.load",
      "skill.set",
      "skill.patch",
      "skill.delete",
      "bash",
      "background_job_cancel",
      "background_job_status",
      "background_job_wait",
      "brave.web.search",
      "brave.news.search",
      "brave.video.search",
      "brave.image.search",
      "brave.llm.context",
      "brave.place.search",
      "brave.place.poi",
      "brave.place.description",
      "mcp.*",
      "time.now",
      "email.account.list",
      "email.list",
      "email.read",
      "email.search",
      "email.attachments.fetch",
      "email.send",
      "environment.create",
      "environment.list",
      "environment.show",
      "environment.logs",
      "environment.stop",
      "image.generate",
      "micro-app.action",
      "micro-app.check",
      "micro-app.create",
      "micro-app.link.create",
      "micro-app.list",
      "micro-app.view",
      "telegram.chat.list",
      "telegram.chat.info",
      "telegram.history",
      "telegram.media.fetch",
      "telegram.send",
      "telegram.edit",
      "telegram.delete",
      "telegram.pin",
      "telegram.unpin",
      "telegram.sticker.send",
      "telegram.sticker.inspect",
      "telegram.sticker.save",
      "telegram.sticker.list",
      "telegram.sticker.set.show",
      "telegram.sticker.set.save",
      "discord.channel.list",
      "discord.history",
      "discord.send",
      "whatsapp.chat.list",
      "whatsapp.history",
      "whatsapp.send",
      "postgres.readonly.query",
      "schedule.cancel",
      "schedule.create",
      "schedule.list",
      "schedule.runs",
      "schedule.show",
      "schedule.update",
      "session.prompt.read",
      "session.prompt.set",
      "session.prompt.transform",
      "env.clear",
      "env.list",
      "subagent.spawn",
      "env.set",
      "telegram.react",
      "todo.add",
      "todo.list",
      "todo.show",
      "todo.done",
      "todo.block",
      "todo.clear",
      "subagent.profile.list",
      "subagent.profile.show",
      "subagent.profile.upsert",
      "subagent.profile.enable",
      "subagent.profile.disable",
      "vent.send",
      "view_media",
      "watch.create",
      "watch.disable",
      "watch.list",
      "watch.runs",
      "watch.show",
      "watch.update",
      "web.fetch",
      "openai.web_research",
      "whisper.transcribe",
      "whisper.translate",
      "wiki.read",
      "wiki.search",
      "wiki.list",
      "wiki.diff",
      "wiki.write",
      "wiki.write.section",
      "wiki.move",
      "wiki.archive",
      "wiki.restore",
      "wiki.attach.image",
      "wiki.fetch.asset",
      "wiki.delete.asset",
    ],
    agentSkill: {
      allowedOperations: ["load", "set", "patch", "delete"],
    },
    bash: {
      allowed: true,
    },
    postgresReadonly: {
      allowed: true,
    },
  };
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
    toolPolicy: policies.toolPolicy ?? defaultPersistentToolPolicy(session),
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

  async resolve(
    session: ResolverSession,
    target?: string,
  ): Promise<ResolvedExecutionEnvironment> {
    const normalizedTarget = target === undefined ? DEFAULT_EXECUTION_TARGET_ALIAS : normalizeExecutionTargetAlias(target);
    if (normalizedTarget === DEFAULT_EXECUTION_TARGET_ALIAS) {
      return this.resolveDefault(session);
    }

    if (session.kind === "worker") {
      throw new Error(`Legacy worker session ${session.id} is not supported after the subagent hard cut.`);
    }
    const binding = await this.store.getBindingByAlias(session.id, normalizedTarget);
    if (!binding) {
      throw new Error(`Execution target ${normalizedTarget} is not bound to session ${session.id}.`);
    }
    return this.resolveBinding(session, binding);
  }

  async resolveDefault(
    session: ResolverSession,
  ): Promise<ResolvedExecutionEnvironment> {
    if (session.kind === "worker") {
      throw new Error(`Legacy worker session ${session.id} is not supported after the subagent hard cut.`);
    }
    const binding = await this.store.getDefaultBinding(session.id);
    if (!binding) {
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
    if (session.kind === "worker") {
      throw new Error(`Legacy worker session ${session.id} is not supported after the subagent hard cut.`);
    }

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
