import {LlmContext} from "../../kernel/agent/llm-context.js";
import {
    readExecutionEnvironmentFilesystemMetadata,
} from "../../domain/execution-environments/filesystem.js";
import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/types.js";
import type {SubagentSessionMetadata} from "../../domain/subagents/session-metadata.js";
import {renderSubagentRuntimeContext} from "../../prompts/contexts/subagent-runtime.js";

export interface SubagentRuntimeContextOptions {
  subagent: SubagentSessionMetadata;
  executionEnvironment?: ResolvedExecutionEnvironment;
}

export class SubagentRuntimeContext extends LlmContext {
  override name = "Subagent Runtime Context";

  private readonly options: SubagentRuntimeContextOptions;

  constructor(options: SubagentRuntimeContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const filesystem = readExecutionEnvironmentFilesystemMetadata(this.options.executionEnvironment?.metadata);
    return renderSubagentRuntimeContext({
      role: this.options.subagent.role,
      task: this.options.subagent.task,
      context: this.options.subagent.context,
      parentSessionId: this.options.subagent.parentSessionId,
      execution: this.options.subagent.execution,
      environmentId: this.options.subagent.environmentId,
      workspacePath: filesystem?.workspace.workerPath,
      inboxPath: filesystem?.inbox.workerPath,
      artifactsPath: filesystem?.artifacts.workerPath,
      parentVisibleRoot: filesystem?.root.parentRunnerPath,
    });
  }
}
