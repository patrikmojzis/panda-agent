import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {JsonValue} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";
import {
    readExecutionEnvironmentFilesystemMetadata,
    type ResolvedExecutionEnvironment,
} from "../../domain/execution-environments/index.js";
import {renderWorkerRuntimeContext, type WorkerRuntimeContextInput,} from "../../prompts/contexts/worker-runtime.js";

export interface WorkerRuntimeContextOptions {
  worker?: JsonValue;
  executionEnvironment?: ResolvedExecutionEnvironment;
}

function readWorkerField(worker: JsonValue | undefined, field: string): string | undefined {
  if (!isRecord(worker)) {
    return undefined;
  }

  return trimToUndefined(worker[field]);
}

export class WorkerRuntimeContext extends LlmContext {
  override name = "Worker Runtime Context";

  private readonly options: WorkerRuntimeContextOptions;

  constructor(options: WorkerRuntimeContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const filesystem = readExecutionEnvironmentFilesystemMetadata(this.options.executionEnvironment?.metadata);
    const input: WorkerRuntimeContextInput = {
      role: readWorkerField(this.options.worker, "role"),
      task: readWorkerField(this.options.worker, "task"),
      context: readWorkerField(this.options.worker, "context"),
      parentSessionId: readWorkerField(this.options.worker, "parentSessionId"),
      workspacePath: filesystem?.workspace.workerPath,
      inboxPath: filesystem?.inbox.workerPath,
      artifactsPath: filesystem?.artifacts.workerPath,
      parentVisibleRoot: filesystem?.root.parentRunnerPath,
    };

    return renderWorkerRuntimeContext(input);
  }
}
