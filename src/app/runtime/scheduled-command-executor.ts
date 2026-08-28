import type {CredentialResolver} from "../../domain/credentials/resolver.js";
import type {ExecutionCredentialPolicy} from "../../domain/execution-environments/types.js";
import {isExecutionToolAllowedByPolicy} from "../../domain/execution-environments/policy.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {ScheduledCommandExecutor} from "../../domain/scheduling/scheduled-commands/runner.js";
import {ScheduledCommandExecutionError} from "../../domain/scheduling/scheduled-commands/runner.js";
import {RemoteShellExecutor} from "../../integrations/shell/bash-executor.js";
import {sanitizeBashOutputPreview} from "../../integrations/shell/bash-output.js";
import {resolveCommandCwd} from "../../integrations/shell/bash-session.js";
import {redactSecretsInString} from "../../integrations/shell/redaction.js";
import type {ExecutionEnvironmentResolver} from "./execution-environment-resolver.js";

const MAX_OUTPUT_CHARS = 16_000;

function assertCredentialsAllowed(policy: ExecutionCredentialPolicy, names: readonly string[]): void {
  if (names.length === 0 || policy.mode === "all_agent") return;
  const allowed = policy.mode === "allowlist" ? new Set(policy.envKeys) : new Set<string>();
  if (names.some((name) => !allowed.has(name))) {
    throw new ScheduledCommandExecutionError(
      "credential_denied",
      "A scheduled command credential is no longer allowed by the current execution environment.",
    );
  }
}

function safeOutput(value: string, secrets: readonly string[]): string {
  return sanitizeBashOutputPreview(redactSecretsInString(value, secrets));
}

export class RuntimeScheduledCommandExecutor implements ScheduledCommandExecutor {
  private readonly sessions: Pick<SessionStore, "getSession">;
  private readonly environments: Pick<ExecutionEnvironmentResolver, "resolveDefault">;
  private readonly credentials: Pick<CredentialResolver, "resolveCredential">;
  private readonly remote: RemoteShellExecutor;
  private readonly baseCwd: string;

  constructor(options: {
    sessions: Pick<SessionStore, "getSession">;
    environments: Pick<ExecutionEnvironmentResolver, "resolveDefault">;
    credentials: Pick<CredentialResolver, "resolveCredential">;
    env?: NodeJS.ProcessEnv;
    baseCwd?: string;
    fetchImpl?: typeof fetch;
  }) {
    const env = options.env ?? process.env;
    this.sessions = options.sessions;
    this.environments = options.environments;
    this.credentials = options.credentials;
    this.remote = new RemoteShellExecutor({env, fetchImpl: options.fetchImpl});
    this.baseCwd = options.baseCwd ?? process.cwd();
  }

  async execute(input: Parameters<ScheduledCommandExecutor["execute"]>[0]) {
    const session = await this.sessions.getSession(input.command.sessionId);
    if (session.archivedAt !== undefined) {
      throw new ScheduledCommandExecutionError("session_archived", "The owning session is archived.");
    }
    const environment = await this.environments.resolveDefault(session);
    if (environment.executionMode !== "remote") {
      throw new ScheduledCommandExecutionError(
        "environment_not_isolated",
        "Mechanical scheduled commands require a remote agent execution environment.",
      );
    }
    if (environment.kind !== "persistent_agent_runner") {
      throw new ScheduledCommandExecutionError(
        "environment_not_supported",
        "Mechanical scheduled commands require the persistent agent runner; disposable environments carry interactive command access.",
      );
    }
    if (environment.agentKey !== session.agentKey) {
      throw new ScheduledCommandExecutionError(
        "environment_owner_mismatch",
        "The resolved execution environment does not belong to the scheduled command's agent.",
      );
    }
    if (!isExecutionToolAllowedByPolicy(environment.toolPolicy, "bash")) {
      throw new ScheduledCommandExecutionError("bash_denied", "Bash is no longer allowed in the current execution environment.");
    }
    assertCredentialsAllowed(environment.credentialPolicy, input.command.credentialNames);
    const resolvedEnv: Record<string, string> = {};
    for (const name of input.command.credentialNames) {
      const credential = await this.credentials.resolveCredential(name, {agentKey: session.agentKey});
      if (!credential) {
        throw new ScheduledCommandExecutionError("credential_missing", `Scheduled command credential ${name} is not configured.`);
      }
      resolvedEnv[name] = credential.value;
    }
    const secrets = Object.values(resolvedEnv).filter(Boolean).sort((a, b) => b.length - a.length);
    const cwd = resolveCommandCwd(input.command.cwd, environment.initialCwd ?? this.baseCwd);
    try {
      await input.onPrepared({environmentId: environment.id, cwd});
      const result = await this.remote.execute({
        command: input.command.command,
        cwd,
        timeoutMs: input.command.timeoutMs,
        trackedEnvKeys: [],
        progressIntervalMs: 5_000,
        progressTailChars: 2_000,
        maxOutputChars: MAX_OUTPUT_CHARS,
        persistOutputThresholdChars: MAX_OUTPUT_CHARS,
        persistOutputFiles: false,
        redactionValues: secrets,
        outputDirectory: "/tmp",
        resolvedEnv,
        env: {
          PANDA_CRON_ID: input.command.commandId,
          PANDA_CRON_RUN_ID: input.run.id,
          PANDA_CRON_SCHEDULED_FOR: new Date(input.run.scheduledFor).toISOString(),
        },
        executionEnvironment: environment,
        run: {
          context: {agentKey: session.agentKey, executionEnvironment: environment},
          signal: input.signal,
          emitToolProgress: () => {},
        },
      });
      return {
        resolvedEnvironmentId: environment.id,
        resolvedCwd: result.finalCwd,
        ...(result.exitCode === null ? {} : {exitCode: result.exitCode}),
        timedOut: result.timedOut,
        stdout: safeOutput(result.stdout, secrets),
        stderr: safeOutput(result.stderr, secrets),
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      };
    } catch (error) {
      if (input.signal.aborted) throw error;
      const message = safeOutput(error instanceof Error ? error.message : String(error), secrets);
      throw new ScheduledCommandExecutionError("execution_unavailable", message, {cause: error});
    }
  }

}
