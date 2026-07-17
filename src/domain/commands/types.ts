import type {JsonObject, JsonValue} from "../../lib/json.js";
import type {AgentSkillOperation, ExecutionCredentialPolicy, ExecutionEnvironmentKind, ExecutionEnvironmentState, ExecutionSkillPolicy} from "../execution-environments/types.js";

export type CommandName = `${string}.${string}`;
export type CommandOutputMode = "text" | "json";
export type CommandInputMode = "flags" | "json" | "stdin" | "file";
export type CommandArgumentValueSource = "literal" | "file" | "stdin";

export interface CommandArgumentDescriptor {
  name: string;
  description: string;
  required?: boolean;
  kind?: "option" | "positional";
  valueType: "string" | "number" | "boolean" | "json";
  valueName?: string;
  enumValues?: readonly string[];
  valueSources?: readonly CommandArgumentValueSource[];
  repeatable?: boolean;
  conflictsWith?: readonly string[];
  requires?: readonly string[];
  defaultValue?: string | number | boolean;
}

export interface CommandExample {
  description: string;
  command: string;
}

export interface CommandDescriptor {
  name: CommandName;
  summary: string;
  description: string;
  usage: string;
  inputModes: readonly CommandInputMode[];
  outputModes: readonly CommandOutputMode[];
  arguments: readonly CommandArgumentDescriptor[];
  examples: readonly CommandExample[];
  requiredCapabilities?: readonly string[];
  resultShape?: JsonObject;
  schemaCatalog?: JsonObject;
}

export interface CommandRouteDescriptor {
  helpArgv: readonly string[];
  jsonArgv: readonly string[];
}

export type CommandRegistrationPhase =
  | "runtime"
  | "runtime.subagent"
  | "daemon.channel"
  | "daemon.a2a";

export interface CommandRegistrationDescriptor {
  phase: CommandRegistrationPhase;
}

export interface CommandPolicyDescriptor {
  capability?: CommandName;
  toolGroups?: readonly string[];
  requiresIdentity?: boolean;
  requiresCredentialMutation?: boolean;
  requiresReadonlyPostgres?: boolean;
  requiredAgentSkillOperation?: AgentSkillOperation;
}

export interface CommandScope {
  agentKey: string;
  sessionId: string;
  threadId?: string;
  runId?: string;
  identityId?: string;
  inputMessageId?: string;
  environmentId?: string;
  allowedCommands?: readonly CommandName[];
  expiresAt?: string;
  credentialMutationAllowed?: boolean;
  credentialPolicy?: ExecutionCredentialPolicy;
  skillPolicy?: ExecutionSkillPolicy;
  agentSkillAllowedOperations?: readonly AgentSkillOperation[];
  executionEnvironment?: {
    id: string;
    agentKey: string;
    kind: ExecutionEnvironmentKind;
    state: ExecutionEnvironmentState;
    source: "binding" | "fallback";
    metadata?: JsonValue;
  };
}

export interface CommandRequest<TInput extends JsonObject = JsonObject> {
  command: CommandName;
  input: TInput;
  scope: CommandScope;
  outputMode?: CommandOutputMode;
  dryRun?: boolean;
  workingDirectory?: string;
}

export interface CommandError {
  code: "unknown_command" | "unauthorized" | "forbidden" | "invalid_input" | "command_failed";
  message: string;
  details?: JsonObject;
}

export interface CommandArtifactDescriptor {
  kind: "image" | "pdf";
  source: "browser" | "view_media" | "image_generate";
  path: string;
  storagePath?: string;
  mimeType: string;
  bytes?: number;
  width?: number;
  height?: number;
  originalPath?: string;
  preview?: {
    kind: "image";
    path: string;
    mimeType: string;
    bytes?: number;
    width?: number;
    height?: number;
  };
}

export interface CommandSuccess<TOutput extends JsonValue = JsonObject> {
  ok: true;
  command: CommandName;
  output: TOutput;
  summary?: string;
  artifact?: CommandArtifactDescriptor;
}

export interface CommandFailure {
  ok: false;
  command: CommandName;
  error: CommandError;
}

export type CommandResult<TOutput extends JsonValue = JsonObject> =
  | CommandSuccess<TOutput>
  | CommandFailure;

export interface RegisteredCommand<TInput extends JsonObject = JsonObject, TOutput extends JsonValue = JsonObject> {
  descriptor: CommandDescriptor;
  execute(request: CommandRequest<TInput>): Promise<CommandSuccess<TOutput>>;
}

export interface CommandModule<TDeps = unknown> {
  descriptor: CommandDescriptor;
  route?: CommandRouteDescriptor;
  policy?: CommandPolicyDescriptor;
  registration?: CommandRegistrationDescriptor;
  createCommand?: (dependencies: TDeps) => RegisteredCommand | null;
}

export interface CommandCatalogModule<TDeps = unknown> extends CommandModule<TDeps> {
  route: CommandRouteDescriptor;
  policy: CommandPolicyDescriptor;
}

export interface CommandPolicyModule {
  descriptor: Pick<CommandDescriptor, "name">;
  policy?: CommandPolicyDescriptor;
}

export interface CommandExecutor {
  execute<TOutput extends JsonValue = JsonObject>(request: CommandRequest): Promise<CommandResult<TOutput>>;
  listCommands?(scope?: CommandScope): Promise<readonly CommandDescriptor[]>;
  getCommand?(name: CommandName): Promise<CommandDescriptor | undefined>;
}
