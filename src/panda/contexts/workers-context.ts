import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {SessionRecord, SessionStore} from "../../domain/sessions/index.js";
import {readWorkerSessionMetadata} from "../../domain/sessions/worker-metadata.js";
import type {
  ExecutionEnvironmentRecord,
  ExecutionEnvironmentStore,
  SessionEnvironmentBindingRecord,
} from "../../domain/execution-environments/index.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/index.js";
import {
  renderWorkersContext,
  type RenderWorkersContextEnvironment,
  type RenderWorkersContextWorker,
} from "../../prompts/contexts/workers.js";

const STOPPED_WORKER_CONTEXT_TTL_MS = 60 * 60 * 1_000;
const MAX_RENDERED_ENVIRONMENTS = 12;
const CONTEXT_STATES = new Set(["provisioning", "ready", "stopping", "failed"]);

export interface WorkersContextOptions {
  sessions: Pick<SessionStore, "listAgentSessions">;
  environments: Pick<ExecutionEnvironmentStore, "listBindingsForEnvironments" | "listDisposableEnvironmentsByOwner">;
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

function shouldRenderEnvironment(environment: ExecutionEnvironmentRecord, now: number, stoppedTtlMs: number): boolean {
  if (CONTEXT_STATES.has(environment.state)) {
    return true;
  }
  return environment.state === "stopped" && environment.updatedAt >= now - stoppedTtlMs;
}

function readPathHints(environment: ExecutionEnvironmentRecord): Pick<
  RenderWorkersContextEnvironment,
  "workspacePath" | "inboxPath" | "artifactsPath"
> {
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
    const [sessions, environments] = await Promise.all([
      this.options.sessions.listAgentSessions(this.options.agentKey),
      this.options.environments.listDisposableEnvironmentsByOwner({
        agentKey: this.options.agentKey,
        createdBySessionId: this.options.parentSessionId,
      }),
    ]);
    const renderedEnvironments: RenderWorkersContextEnvironment[] = [];
    const visibleEnvironments = environments.filter((environment) => (
      shouldRenderEnvironment(environment, now, stoppedTtlMs)
    ));
    const bindings = await this.options.environments.listBindingsForEnvironments(
      visibleEnvironments.map((environment) => environment.id),
    );
    const workersBySessionId = new Map<string, {session: SessionRecord; worker: RenderWorkersContextWorker}>();

    for (const session of sessions) {
      if (session.kind !== "worker") {
        continue;
      }
      const metadata = readWorkerSessionMetadata(session.metadata);
      if (metadata?.parentSessionId !== this.options.parentSessionId) {
        continue;
      }
      workersBySessionId.set(session.id, {
        session,
        worker: {
          sessionId: session.id,
          role: metadata.role,
          startedAt: formatTimestamp(session.createdAt),
        },
      });
    }

    for (const environment of visibleEnvironments) {
      const attachedWorkers = bindings
        .filter((binding: SessionEnvironmentBindingRecord) => binding.environmentId === environment.id)
        .flatMap((binding) => {
          const worker = workersBySessionId.get(binding.sessionId)?.worker;
          return worker ? [worker] : [];
        });
      renderedEnvironments.push({
        environmentId: environment.id,
        state: environment.state,
        startedAt: formatTimestamp(environment.createdAt),
        updatedAt: formatTimestamp(environment.updatedAt),
        ...readPathHints(environment),
        workers: attachedWorkers,
      });
    }

    return renderWorkersContext(renderedEnvironments.slice(-MAX_RENDERED_ENVIRONMENTS));
  }
}
