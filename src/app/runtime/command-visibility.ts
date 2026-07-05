import type {CommandCatalog} from "../../domain/commands/modules.js";
import type {CommandDescriptor, CommandScope} from "../../domain/commands/types.js";
import {resolveCommandLeaseAuthority} from "../../domain/execution-environments/command-authority.js";
import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/types.js";
import type {SessionRecord} from "../../domain/sessions/types.js";

export interface CommandDescriptorSource {
  listCommands(scope?: CommandScope): Promise<readonly CommandDescriptor[]> | readonly CommandDescriptor[];
}

export interface ResolveVisibleCommandDescriptorsInput {
  commandCatalog: Pick<CommandCatalog, "modules">;
  commandExecutor: CommandDescriptorSource;
  session: Pick<SessionRecord, "agentKey" | "id">;
  executionEnvironment: Pick<ResolvedExecutionEnvironment, "id" | "skillPolicy" | "source" | "toolPolicy">;
  readonlyPostgresCommandAllowed?: boolean;
  identityId?: string;
  inputMessageId?: string;
}

export async function resolveVisibleCommandDescriptors(
  input: ResolveVisibleCommandDescriptorsInput,
): Promise<readonly CommandDescriptor[]> {
  const credentialMutationAllowed = input.executionEnvironment.source === "fallback";
  const allowedCommands = resolveCommandLeaseAuthority({
    commandCatalog: input.commandCatalog,
    toolPolicy: input.executionEnvironment.toolPolicy,
    credentialMutationAllowed,
    readonlyPostgresCommandAllowed: input.readonlyPostgresCommandAllowed === true,
    identityScoped: Boolean(input.identityId),
  });
  if (allowedCommands.length === 0) {
    return [];
  }

  return input.commandExecutor.listCommands({
    agentKey: input.session.agentKey,
    sessionId: input.session.id,
    ...(input.executionEnvironment.source === "binding" ? {environmentId: input.executionEnvironment.id} : {}),
    ...(input.identityId ? {identityId: input.identityId} : {}),
    ...(input.inputMessageId ? {inputMessageId: input.inputMessageId} : {}),
    allowedCommands,
    credentialMutationAllowed,
    skillPolicy: input.executionEnvironment.skillPolicy,
  });
}
