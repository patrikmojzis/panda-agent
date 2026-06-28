import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import type {ExecutionEnvironmentRecord} from "../../domain/execution-environments/types.js";
import {renderBashTargetsContext, type BashTargetContextItem} from "../../prompts/contexts/bash-targets.js";

export interface BashTargetsContextOptions {
  environments: Pick<ExecutionEnvironmentStore, "getEnvironment" | "listBindingsForSession">;
  sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function readTargetMetadata(environment: ExecutionEnvironmentRecord | undefined): Pick<BashTargetContextItem, "description" | "capabilities"> {
  const metadata = environment?.metadata;
  if (!isRecord(metadata)) {
    return {};
  }
  const targetMetadata = isRecord(metadata.executionTarget) ? metadata.executionTarget : metadata;
  const description = readString(targetMetadata.description);
  const capabilities = [
    ...readStringArray(targetMetadata.capabilities),
    ...readStringArray(targetMetadata.safeCapabilities),
  ];
  return {
    ...(description ? {description} : {}),
    ...(capabilities.length > 0 ? {capabilities} : {}),
  };
}

export class BashTargetsContext extends LlmContext {
  override name = "Bash Targets";

  private readonly environments: Pick<ExecutionEnvironmentStore, "getEnvironment" | "listBindingsForSession">;
  private readonly sessionId: string;

  constructor(options: BashTargetsContextOptions) {
    super();
    this.environments = options.environments;
    this.sessionId = options.sessionId;
  }

  async getContent(): Promise<string> {
    const bindings = await this.environments.listBindingsForSession(this.sessionId);
    const targets = await Promise.all(bindings.map(async (binding): Promise<BashTargetContextItem> => {
      let environment: ExecutionEnvironmentRecord | undefined;
      try {
        environment = await this.environments.getEnvironment(binding.environmentId);
      } catch {
        environment = undefined;
      }
      return {
        alias: binding.alias,
        ...(binding.isDefault ? {isDefaultBinding: true} : {}),
        ...(binding.toolPolicy.allowedTools?.length ? {allowedTools: binding.toolPolicy.allowedTools} : {}),
        ...(environment?.networkPolicy ? {networkPolicy: environment.networkPolicy} : {}),
        ...readTargetMetadata(environment),
      };
    }));

    return renderBashTargetsContext(targets);
  }
}
