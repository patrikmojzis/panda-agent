import type {CommandScope} from "../../domain/commands/types.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import type {SessionStore} from "../../domain/sessions/store.js";

export interface ResolveRuntimeCommandScopeOptions {
  sessions: Pick<SessionStore, "getSession">;
  executionEnvironments: Pick<ExecutionEnvironmentStore, "getEnvironment" | "listBindingsForSession">;
  now?: () => number;
}

export async function resolveRuntimeCommandScope(
  scope: CommandScope,
  options: ResolveRuntimeCommandScopeOptions,
): Promise<CommandScope> {
  const session = await options.sessions.getSession(scope.sessionId);
  if (session.agentKey !== scope.agentKey) {
    throw new Error("Panda command session does not belong to the requested agent.");
  }

  let executionEnvironment: CommandScope["executionEnvironment"] | undefined;
  if (scope.environmentId) {
    const bindings = await options.executionEnvironments.listBindingsForSession(session.id);
    if (!bindings.some((binding) => binding.environmentId === scope.environmentId)) {
      throw new Error("Panda command execution environment is not bound to the requested session.");
    }
    const environment = await options.executionEnvironments.getEnvironment(scope.environmentId);
    if (environment.agentKey !== scope.agentKey) {
      throw new Error("Panda command execution environment does not belong to the requested agent.");
    }
    if (environment.state !== "ready") {
      throw new Error(`Panda command execution environment is ${environment.state}.`);
    }
    if (environment.expiresAt !== undefined && environment.expiresAt <= (options.now?.() ?? Date.now())) {
      throw new Error("Panda command execution environment is expired.");
    }
    executionEnvironment = {
      id: environment.id,
      agentKey: environment.agentKey,
      kind: environment.kind,
      state: environment.state,
      source: "binding",
      ...(environment.metadata === undefined ? {} : {metadata: environment.metadata}),
    };
  }

  return {
    ...scope,
    threadId: session.currentThreadId,
    ...(executionEnvironment ? {executionEnvironment} : {}),
  };
}
