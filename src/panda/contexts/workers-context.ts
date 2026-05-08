import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {SessionStore} from "../../domain/sessions/index.js";
import {readWorkerSessionMetadata} from "../../domain/sessions/worker-metadata.js";
import type {
    ExecutionEnvironmentRecord,
    ExecutionEnvironmentStore,
} from "../../domain/execution-environments/index.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/index.js";
import {renderWorkersContext, type RenderWorkersContextWorker} from "../../prompts/contexts/workers.js";

const STOPPED_WORKER_CONTEXT_TTL_MS = 60 * 60 * 1_000;
const MAX_RENDERED_WORKERS = 12;
const CONTEXT_STATES = new Set(["provisioning", "ready", "stopping", "failed"]);

export interface WorkersContextOptions {
  sessions: Pick<SessionStore, "listAgentSessions">;
  environments: Pick<ExecutionEnvironmentStore, "getDefaultBinding" | "getEnvironment">;
  agentKey: string;
  parentSessionId: string;
  stoppedTtlMs?: number;
  now?: Date | (() => Date);
}

function resolveNow(now?: Date | (() => Date)): Date {
  if (typeof now === "function") {
    return now();
  }

  return now ?? new Date();
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function shouldRenderEnvironment(environment: ExecutionEnvironmentRecord | null, now: number, stoppedTtlMs: number): boolean {
  if (!environment) {
    return true;
  }
  if (CONTEXT_STATES.has(environment.state)) {
    return true;
  }
  return environment.state === "stopped" && environment.updatedAt >= now - stoppedTtlMs;
}

function readPathHints(environment: ExecutionEnvironmentRecord | null): Pick<
  RenderWorkersContextWorker,
  "workspacePath" | "inboxPath" | "artifactsPath"
> {
  if (!environment) {
    return {};
  }

  const filesystem = readExecutionEnvironmentFilesystemMetadata(environment.metadata);
  return {
    ...(filesystem?.workspace.parentRunnerPath ? {workspacePath: filesystem.workspace.parentRunnerPath} : {}),
    ...(filesystem?.inbox.parentRunnerPath ? {inboxPath: filesystem.inbox.parentRunnerPath} : {}),
    ...(filesystem?.artifacts.parentRunnerPath ? {artifactsPath: filesystem.artifacts.parentRunnerPath} : {}),
  };
}

export class WorkersContext extends LlmContext {
  override name = "Workers";

  private readonly options: WorkersContextOptions;

  constructor(options: WorkersContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const now = resolveNow(this.options.now).getTime();
    const stoppedTtlMs = this.options.stoppedTtlMs ?? STOPPED_WORKER_CONTEXT_TTL_MS;
    const sessions = await this.options.sessions.listAgentSessions(this.options.agentKey);
    const workers: RenderWorkersContextWorker[] = [];

    for (const session of sessions) {
      if (session.kind !== "worker") {
        continue;
      }

      const metadata = readWorkerSessionMetadata(session.metadata);
      if (metadata?.parentSessionId !== this.options.parentSessionId) {
        continue;
      }

      const binding = await this.options.environments.getDefaultBinding(session.id);
      const environment = binding
        ? await this.options.environments.getEnvironment(binding.environmentId).catch(() => null)
        : null;
      if (!shouldRenderEnvironment(environment, now, stoppedTtlMs)) {
        continue;
      }

      workers.push({
        sessionId: session.id,
        ...(environment ? {environmentId: environment.id} : {}),
        role: metadata.role,
        state: environment?.state ?? "unbound",
        startedAt: formatTimestamp(session.createdAt),
        ...readPathHints(environment),
      });
    }

    return renderWorkersContext(workers.slice(-MAX_RENDERED_WORKERS));
  }
}
