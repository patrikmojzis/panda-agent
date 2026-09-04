import {createDefaultExecutionToolPolicy} from "../../panda/commands/agent-command-policy.js";
import type {CommandCatalog} from "../../domain/commands/modules.js";
import {isExecutionToolAllowedByPolicy} from "../../domain/execution-environments/policy.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/types.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import {resolveVisibleCommandDescriptors, type CommandDescriptorSource} from "./command-visibility.js";
import {ExecutionEnvironmentResolver} from "./execution-environment-resolver.js";

/** Resolves heartbeat guidance without provisioning or recovering execution environments. */
export function createHeartbeatPromptContextResolver(options: {
  sessions: Pick<SessionStore, "readSessionPrompt">;
  executionEnvironments: Pick<ExecutionEnvironmentStore, "getDefaultBinding" | "getBindingByAlias" | "getEnvironment">;
  commandCatalog: Pick<CommandCatalog, "modules">;
  commandExecutor: CommandDescriptorSource;
  env?: NodeJS.ProcessEnv;
}) {
  const environments = new ExecutionEnvironmentResolver({
    defaultToolPolicy: createDefaultExecutionToolPolicy(options.commandCatalog),
    store: options.executionEnvironments,
    env: options.env,
  });

  return async (session: SessionRecord): Promise<{guidance: string | null; canConfigureCadence: boolean}> => {
    const heartbeatDoc = await options.sessions.readSessionPrompt(session.id, "heartbeat");
    const guidance = heartbeatDoc?.content.trim() || null;
    let environment: ResolvedExecutionEnvironment;
    try {
      environment = await environments.resolveDefault(session);
    } catch {
      return {guidance, canConfigureCadence: false};
    }
    if (!isExecutionToolAllowedByPolicy(environment.toolPolicy, "bash")) {
      return {guidance, canConfigureCadence: false};
    }

    const commands = await resolveVisibleCommandDescriptors({
      commandCatalog: options.commandCatalog,
      commandExecutor: options.commandExecutor,
      session,
      executionEnvironment: environment,
    });
    return {guidance, canConfigureCadence: commands.some((command) => command.name === "heartbeat.set")};
  };
}
