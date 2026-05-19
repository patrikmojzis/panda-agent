import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import {readWorkerSessionMetadata} from "../../domain/sessions/worker-metadata.js";
import type {
  ExecutionEnvironmentRecord,
  SessionEnvironmentBindingRecord,
} from "../../domain/execution-environments/types.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/filesystem.js";
import {
  renderWorkersContext,
  type RenderWorkersContextEnvironment,
  type RenderWorkersContextWorker,
} from "../../prompts/contexts/workers.js";
import {resolveNow} from "./shared.js";

const STOPPED_WORKER_CONTEXT_TTL_MS = 60 * 60 * 1_000;
const MAX_RENDERED_ENVIRONMENTS = 12;
const MAX_RENDERED_WORKERS_PER_ENVIRONMENT = 8;
const CONTEXT_STATES = new Set(["provisioning", "ready", "stopping", "failed"]);

export interface WorkersContextOptions {
  sessions: Pick<SessionStore, "listAgentSessions">;
  environments: Pick<ExecutionEnvironmentStore, "listBindingsForEnvironments" | "listDisposableEnvironmentsByOwner">;
  agentKey: string;
  parentSessionId: string;
  stoppedTtlMs?: number;
  maxWorkersPerEnvironment?: number;
  now?: Date | (() => Date);
}

interface WorkerContextCandidate {
  session: SessionRecord;
  worker: RenderWorkersContextWorker;
}

interface AttachedWorkerCandidate extends WorkerContextCandidate {
  binding: SessionEnvironmentBindingRecord;
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

function resolveMaxWorkersPerEnvironment(maxWorkers: number | undefined): number {
  if (maxWorkers === undefined || !Number.isFinite(maxWorkers)) {
    return MAX_RENDERED_WORKERS_PER_ENVIRONMENT;
  }
  return Math.max(1, Math.floor(maxWorkers));
}

function compareAttachedWorkerCandidates(
  left: AttachedWorkerCandidate,
  right: AttachedWorkerCandidate,
): number {
  const bindingCreatedAtDelta = right.binding.createdAt - left.binding.createdAt;
  if (bindingCreatedAtDelta !== 0) {
    return bindingCreatedAtDelta;
  }

  const sessionCreatedAtDelta = right.session.createdAt - left.session.createdAt;
  if (sessionCreatedAtDelta !== 0) {
    return sessionCreatedAtDelta;
  }

  return left.session.id.localeCompare(right.session.id);
}

function selectRenderedWorkers(
  candidates: readonly AttachedWorkerCandidate[],
  maxWorkers: number,
): Pick<RenderWorkersContextEnvironment, "workers" | "omittedWorkerCount"> {
  if (candidates.length <= maxWorkers) {
    return {
      workers: candidates.map((candidate) => candidate.worker),
    };
  }

  const workers = [...candidates]
    .sort(compareAttachedWorkerCandidates)
    .slice(0, maxWorkers)
    .map((candidate) => candidate.worker);
  return {
    workers,
    omittedWorkerCount: candidates.length - workers.length,
  };
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
    const maxWorkersPerEnvironment = resolveMaxWorkersPerEnvironment(this.options.maxWorkersPerEnvironment);
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
    const workersBySessionId = new Map<string, WorkerContextCandidate>();

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
        .flatMap((binding): AttachedWorkerCandidate[] => {
          const worker = workersBySessionId.get(binding.sessionId);
          return worker ? [{...worker, binding}] : [];
        });
      renderedEnvironments.push({
        environmentId: environment.id,
        state: environment.state,
        startedAt: formatTimestamp(environment.createdAt),
        updatedAt: formatTimestamp(environment.updatedAt),
        ...readPathHints(environment),
        ...selectRenderedWorkers(attachedWorkers, maxWorkersPerEnvironment),
      });
    }

    return renderWorkersContext(renderedEnvironments.slice(-MAX_RENDERED_ENVIRONMENTS));
  }
}
