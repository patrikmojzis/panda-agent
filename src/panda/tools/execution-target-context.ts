import {ToolError} from "../../kernel/agent/exceptions.js";
import {
  DEFAULT_EXECUTION_TARGET_ALIAS,
  normalizeExecutionTargetAlias,
  type ResolvedExecutionEnvironment,
} from "../../domain/execution-environments/types.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";

export interface ResolvedExecutionTargetContext {
  context: DefaultAgentSessionContext | undefined;
  executionEnvironment?: ResolvedExecutionEnvironment;
  isDefaultTarget: boolean;
  targetAlias: string;
}

export async function resolveExecutionTargetContext(
  context: DefaultAgentSessionContext | undefined,
  target: string | undefined,
): Promise<ResolvedExecutionTargetContext> {
  let targetAlias: string;
  try {
    targetAlias = target === undefined ? DEFAULT_EXECUTION_TARGET_ALIAS : normalizeExecutionTargetAlias(target);
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : "Invalid execution target.");
  }
  if (targetAlias === DEFAULT_EXECUTION_TARGET_ALIAS) {
    return {
      context,
      executionEnvironment: context?.executionEnvironment,
      isDefaultTarget: true,
      targetAlias,
    };
  }

  if (!context?.resolveExecutionTarget) {
    throw new ToolError(`Execution target ${targetAlias} is not available in this runtime.`);
  }

  let executionEnvironment: ResolvedExecutionEnvironment;
  try {
    executionEnvironment = await context.resolveExecutionTarget(targetAlias);
  } catch {
    throw new ToolError(`Execution target ${targetAlias} is unavailable.`);
  }

  const shellSessions = context.shellSessions ?? {};
  context.shellSessions = shellSessions;

  return {
    context: {
      ...context,
      shellSessions,
      executionEnvironment,
    },
    executionEnvironment,
    isDefaultTarget: false,
    targetAlias,
  };
}
