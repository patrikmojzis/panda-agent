import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import {renderBashTargetsContext} from "../../prompts/contexts/bash-targets.js";

export interface BashTargetsContextOptions {
  environments: Pick<ExecutionEnvironmentStore, "listBindingsForSession">;
  sessionId: string;
}

export class BashTargetsContext extends LlmContext {
  override name = "Bash Targets";

  private readonly environments: Pick<ExecutionEnvironmentStore, "listBindingsForSession">;
  private readonly sessionId: string;

  constructor(options: BashTargetsContextOptions) {
    super();
    this.environments = options.environments;
    this.sessionId = options.sessionId;
  }

  async getContent(): Promise<string> {
    const bindings = await this.environments.listBindingsForSession(this.sessionId);
    const aliases = [...new Set(bindings.map((binding) => binding.alias))].sort((left, right) => left.localeCompare(right));
    return renderBashTargetsContext(aliases);
  }
}
