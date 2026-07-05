import type {JsonObject} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import type {ExecutionEnvironmentRecord} from "../execution-environments/types.js";
import type {SessionRecord} from "../sessions/types.js";
import type {ThreadRecord} from "../threads/runtime/types.js";
import {
  readSubagentSessionMetadata,
  type SubagentExecutionMode,
} from "./session-metadata.js";
import type {SubagentProfileStore} from "./store.js";
import {
  SUBAGENT_TOOL_GROUP_KEYS,
  type SubagentToolGroup,
} from "./tool-groups.js";
import {
  SUBAGENT_PROFILE_THINKING_LEVELS,
  type SubagentProfileRecord,
} from "./types.js";

export const SUBAGENT_SPAWN_COMMAND_NAME = "subagent.spawn";
export const SUBAGENT_PROFILE_LIST_COMMAND_NAME = "subagent.profile.list";
export const SUBAGENT_PROFILE_SHOW_COMMAND_NAME = "subagent.profile.show";
export const SUBAGENT_PROFILE_UPSERT_COMMAND_NAME = "subagent.profile.upsert";
export const SUBAGENT_PROFILE_ENABLE_COMMAND_NAME = "subagent.profile.enable";
export const SUBAGENT_PROFILE_DISABLE_COMMAND_NAME = "subagent.profile.disable";

export type SubagentProfileUpsertCommandStore = Pick<SubagentProfileStore, "upsertProfile">;
export type SubagentProfileListCommandStore = Pick<SubagentProfileStore, "listProfiles">;
export type SubagentProfileShowCommandStore = Pick<SubagentProfileStore, "getProfile">;
export type SubagentProfileStateCommandStore = Pick<SubagentProfileStore, "setProfileEnabled">;
export interface SubagentSpawnSessionCreator {
  createSubagentSession(input: {
    agentKey: string;
    parentSessionId: string;
    task: string;
    context?: string;
    profile?: string;
    toolGroups?: readonly SubagentToolGroup[];
    execution?: SubagentExecutionMode;
    environmentId?: string;
    credentialAllowlist?: readonly string[];
    createdByIdentityId?: string;
  }): Promise<{
    session: Pick<SessionRecord, "id" | "metadata">;
    thread: Pick<ThreadRecord, "id">;
    environment?: Pick<ExecutionEnvironmentRecord, "id">;
  }>;
}

const SPAWN_ALLOWED_INPUT_KEYS = new Set([
  "prompt",
  "profile",
  "context",
  "execution",
  "environmentId",
  "credentialAllowlist",
  "toolGroups",
]);
const UPSERT_PROFILE_ALLOWED_INPUT_KEYS = new Set([
  "slug",
  "description",
  "prompt",
  "toolGroups",
  "model",
  "thinking",
  "enabled",
]);
const LIST_PROFILE_ALLOWED_INPUT_KEYS = new Set(["includeDisabled"]);
const SHOW_PROFILE_ALLOWED_INPUT_KEYS = new Set(["slug", "includeDisabled"]);
const PROFILE_STATE_ALLOWED_INPUT_KEYS = new Set(["slug"]);

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return readRequiredString(value, label);
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }

  return value;
}

function readToolGroups(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("subagent.profile.upsert toolGroups must be an array.");
  }
  if (value.length === 0 || value.length > 20) {
    throw new Error("subagent.profile.upsert toolGroups must contain 1 to 20 entries.");
  }
  return value.map((entry, index) => readRequiredString(entry, `subagent.profile.upsert toolGroups[${index}]`));
}

function readSpawnToolGroups(value: unknown): SubagentToolGroup[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("subagent.spawn toolGroups must be an array.");
  }
  if (value.length === 0 || value.length > 20) {
    throw new Error("subagent.spawn toolGroups must contain 1 to 20 entries.");
  }
  return value.map((entry, index) => {
    const group = readRequiredString(entry, `subagent.spawn toolGroups[${index}]`);
    if (!SUBAGENT_TOOL_GROUP_KEYS.includes(group as SubagentToolGroup)) {
      throw new Error(`subagent.spawn toolGroups[${index}] must be a known subagent tool group.`);
    }
    return group as SubagentToolGroup;
  });
}

function readCredentialAllowlist(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("subagent.spawn credentialAllowlist must be an array.");
  }
  if (value.length > 50) {
    throw new Error("subagent.spawn credentialAllowlist must contain at most 50 entries.");
  }
  return value.map((entry, index) => readRequiredString(entry, `subagent.spawn credentialAllowlist[${index}]`));
}

function readSpawnExecution(value: unknown): SubagentExecutionMode | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "agent_workspace" || value === "isolated_environment") {
    return value;
  }

  throw new Error("subagent.spawn execution must be agent_workspace or isolated_environment.");
}

function readThinking(value: unknown): "low" | "medium" | "high" | "xhigh" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && SUBAGENT_PROFILE_THINKING_LEVELS.includes(value as never)) {
    return value as "low" | "medium" | "high" | "xhigh";
  }

  throw new Error("subagent.profile.upsert thinking must be low, medium, high, or xhigh.");
}

function parseUpsertProfileInput(input: unknown) {
  if (!isRecord(input)) {
    throw new Error("subagent.profile.upsert input must be a JSON object.");
  }
  for (const key of Object.keys(input)) {
    if (!UPSERT_PROFILE_ALLOWED_INPUT_KEYS.has(key)) {
      throw new Error(`subagent.profile.upsert does not accept ${key}.`);
    }
  }

  const model = readOptionalString(input.model, "subagent.profile.upsert model");
  const thinking = readThinking(input.thinking);
  const enabled = readOptionalBoolean(input.enabled, "subagent.profile.upsert enabled");
  return {
    slug: readRequiredString(input.slug, "subagent.profile.upsert slug"),
    description: readRequiredString(input.description, "subagent.profile.upsert description"),
    prompt: readRequiredString(input.prompt, "subagent.profile.upsert prompt"),
    toolGroups: readToolGroups(input.toolGroups),
    ...(model ? {model} : {}),
    ...(thinking ? {thinking} : {}),
    ...(enabled === undefined ? {} : {enabled}),
  };
}

function rejectUnexpectedProfileKeys(
  input: Record<string, unknown>,
  commandName: string,
  allowedKeys: ReadonlySet<string>,
): void {
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${commandName} does not accept ${key}.`);
    }
  }
}

function parseListProfilesInput(input: unknown) {
  if (!isRecord(input)) {
    throw new Error(`${SUBAGENT_PROFILE_LIST_COMMAND_NAME} input must be a JSON object.`);
  }
  rejectUnexpectedProfileKeys(input, SUBAGENT_PROFILE_LIST_COMMAND_NAME, LIST_PROFILE_ALLOWED_INPUT_KEYS);

  return {
    includeDisabled: readOptionalBoolean(input.includeDisabled, "subagent.profile.list includeDisabled") ?? false,
  };
}

function parseShowProfileInput(input: unknown) {
  if (!isRecord(input)) {
    throw new Error(`${SUBAGENT_PROFILE_SHOW_COMMAND_NAME} input must be a JSON object.`);
  }
  rejectUnexpectedProfileKeys(input, SUBAGENT_PROFILE_SHOW_COMMAND_NAME, SHOW_PROFILE_ALLOWED_INPUT_KEYS);

  return {
    slug: readRequiredString(input.slug, "subagent.profile.show slug"),
    includeDisabled: readOptionalBoolean(input.includeDisabled, "subagent.profile.show includeDisabled") ?? false,
  };
}

function parseProfileStateInput(input: unknown, commandName: string) {
  if (!isRecord(input)) {
    throw new Error(`${commandName} input must be a JSON object.`);
  }
  rejectUnexpectedProfileKeys(input, commandName, PROFILE_STATE_ALLOWED_INPUT_KEYS);

  return {
    slug: readRequiredString(input.slug, `${commandName} slug`),
  };
}

function parseSpawnInput(input: unknown) {
  if (!isRecord(input)) {
    throw new Error("subagent.spawn input must be a JSON object.");
  }
  for (const key of Object.keys(input)) {
    if (!SPAWN_ALLOWED_INPUT_KEYS.has(key)) {
      throw new Error(`subagent.spawn does not accept ${key}.`);
    }
  }

  const profile = readOptionalString(input.profile, "subagent.spawn profile");
  const context = readOptionalString(input.context, "subagent.spawn context");
  const execution = readSpawnExecution(input.execution);
  const environmentId = readOptionalString(input.environmentId, "subagent.spawn environmentId");
  const credentialAllowlist = readCredentialAllowlist(input.credentialAllowlist);
  const toolGroups = readSpawnToolGroups(input.toolGroups);

  return {
    prompt: readRequiredString(input.prompt, "subagent.spawn prompt"),
    ...(profile ? {profile} : {}),
    ...(context ? {context} : {}),
    ...(execution ? {execution} : {}),
    ...(environmentId ? {environmentId} : {}),
    credentialAllowlist: credentialAllowlist ?? [],
    ...(toolGroups ? {toolGroups} : {}),
  };
}

function serializeProfile(profile: SubagentProfileRecord, options: {includePrompt?: boolean} = {}): JsonObject {
  return {
    slug: profile.slug,
    source: profile.source,
    ...(profile.agentKey !== undefined ? {agentKey: profile.agentKey} : {}),
    description: profile.description,
    ...(options.includePrompt === true ? {prompt: profile.prompt} : {}),
    toolGroups: [...profile.toolGroups],
    ...(profile.model !== undefined ? {model: profile.model} : {}),
    ...(profile.thinking !== undefined ? {thinking: profile.thinking} : {}),
    enabled: profile.enabled,
  };
}

export const subagentProfileListCommandDescriptor: CommandDescriptor = {
  name: SUBAGENT_PROFILE_LIST_COMMAND_NAME,
  summary: "List visible subagent profiles.",
  description: "Lists built-in and current-agent custom subagent profiles. Prompts are omitted; use subagent.profile.show for the full prompt.",
  usage: "panda subagent profile list [--include-disabled]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "include-disabled",
      description: "Include disabled custom profiles.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "Structured JSON object containing optional includeDisabled.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List active profiles",
      command: "panda subagent profile list",
    },
    {
      description: "Include disabled profiles",
      command: "panda subagent profile list --include-disabled",
    },
  ],
  requiredCapabilities: [SUBAGENT_PROFILE_LIST_COMMAND_NAME],
  resultShape: {
    count: "number",
    profiles: ["object"],
  },
};

export const subagentProfileShowCommandDescriptor: CommandDescriptor = {
  name: SUBAGENT_PROFILE_SHOW_COMMAND_NAME,
  summary: "Show a subagent profile.",
  description: "Shows one built-in or current-agent custom subagent profile, including its prompt.",
  usage: "panda subagent profile show <slug> [--include-disabled]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "slug",
      description: "Subagent profile slug.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "slug",
    },
    {
      name: "include-disabled",
      description: "Allow disabled custom profiles to be shown.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "Structured JSON object containing slug and optional includeDisabled.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Show a profile",
      command: "panda subagent profile show reviewer",
    },
  ],
  requiredCapabilities: [SUBAGENT_PROFILE_SHOW_COMMAND_NAME],
  resultShape: {
    slug: "string",
    source: "builtin|custom",
    prompt: "string",
    toolGroups: ["string"],
    enabled: "boolean",
  },
};

function requireCommandJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

export const subagentProfileUpsertCommandDescriptor: CommandDescriptor = {
  name: SUBAGENT_PROFILE_UPSERT_COMMAND_NAME,
  summary: "Create or update a custom subagent profile.",
  description: "Creates or updates a custom subagent profile scoped to the current agent. Spawn-time fields, credentials, environments, raw tools, and skills are not accepted.",
  usage: "panda subagent profile upsert <slug> --description <text|@file|@-> --prompt <text|@file|@-> --tool-group <group>... [--model <model>] [--thinking low|medium|high|xhigh] [--enabled|--disabled]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "slug",
      description: "Custom subagent profile slug.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "slug",
    },
    {
      name: "description",
      description: "Short profile description. Use @file or @- for generated descriptions.",
      required: true,
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "prompt",
      description: "Profile system prompt. Use @file or @- for multiline prompts.",
      required: true,
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "tool-group",
      description: "Repeatable tool group granted to the profile.",
      required: true,
      valueType: "string",
      valueName: "group",
      enumValues: SUBAGENT_TOOL_GROUP_KEYS,
      repeatable: true,
    },
    {
      name: "model",
      description: "Optional model selector for sessions spawned from this profile.",
      valueType: "string",
      valueName: "model",
    },
    {
      name: "thinking",
      description: "Optional thinking level for sessions spawned from this profile.",
      valueType: "string",
      valueName: "low|medium|high|xhigh",
      enumValues: SUBAGENT_PROFILE_THINKING_LEVELS,
    },
    {
      name: "enabled",
      description: "Create or update the profile as enabled.",
      valueType: "boolean",
      conflictsWith: ["disabled"],
    },
    {
      name: "disabled",
      description: "Create or update the profile as disabled.",
      valueType: "boolean",
      conflictsWith: ["enabled"],
    },
    {
      name: "json",
      description: "Structured JSON object containing slug, description, prompt, toolGroups, and optional model, thinking, enabled.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Upsert a custom reviewer profile",
      command: "panda subagent profile upsert reviewer --description \"Review code.\" --prompt @reviewer.md --tool-group core",
    },
    {
      description: "Use JSON input",
      command: "panda subagent profile upsert --json '{\"slug\":\"reviewer\",\"description\":\"Review code.\",\"prompt\":\"Inspect changes.\",\"toolGroups\":[\"core\"]}'",
    },
  ],
  requiredCapabilities: ["subagent.profile.upsert"],
  resultShape: {
    slug: "string",
    source: "custom",
    agentKey: "string",
    description: "string",
    toolGroups: ["string"],
    enabled: "boolean",
  },
};

export const subagentProfileEnableCommandDescriptor: CommandDescriptor = {
  name: SUBAGENT_PROFILE_ENABLE_COMMAND_NAME,
  summary: "Enable a custom subagent profile.",
  description: "Enables a current-agent custom subagent profile. Built-in profiles are already globally managed and cannot be mutated here.",
  usage: "panda subagent profile enable <slug>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "slug",
      description: "Custom subagent profile slug.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "slug",
    },
    {
      name: "json",
      description: "Structured JSON object containing slug.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Enable a profile",
      command: "panda subagent profile enable reviewer",
    },
  ],
  requiredCapabilities: [SUBAGENT_PROFILE_ENABLE_COMMAND_NAME],
  resultShape: {
    slug: "string",
    source: "custom",
    enabled: true,
  },
};

export const subagentProfileDisableCommandDescriptor: CommandDescriptor = {
  name: SUBAGENT_PROFILE_DISABLE_COMMAND_NAME,
  summary: "Disable a custom subagent profile.",
  description: "Disables a current-agent custom subagent profile without deleting its definition. Built-in profiles cannot be disabled here.",
  usage: "panda subagent profile disable <slug>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "slug",
      description: "Custom subagent profile slug.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "slug",
    },
    {
      name: "json",
      description: "Structured JSON object containing slug.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Disable a profile",
      command: "panda subagent profile disable reviewer",
    },
  ],
  requiredCapabilities: [SUBAGENT_PROFILE_DISABLE_COMMAND_NAME],
  resultShape: {
    slug: "string",
    source: "custom",
    enabled: false,
  },
};

export const subagentSpawnCommandDescriptor: CommandDescriptor = {
  name: SUBAGENT_SPAWN_COMMAND_NAME,
  summary: "Create a durable subagent session.",
  description: "Creates a durable subagent session and hands off work immediately. Progress and completion arrive through A2A commands, not background-job polling.",
  usage: "panda subagent spawn (<task|@file|@->|--prompt <text|@file|@->) [--profile <slug>|--tool-group <group>...] [--context <text|@file|@->] [(--environment <environment-id> [--isolated]|--agent-workspace)] [--credential <env-key>...]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "task",
      description: "Task or handoff prompt for the subagent. Use @file or @- for longer prompts.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "prompt",
      description: "Alternative task input when the prompt is better passed as a flag.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "profile",
      description: "Subagent profile slug.",
      valueType: "string",
      valueName: "slug",
      conflictsWith: ["tool-group"],
    },
    {
      name: "context",
      description: "Optional extra handoff context. Use @file or @- for multiline context.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "isolated",
      description: "Run in an isolated execution environment. Requires --environment unless --environment already implies it.",
      valueType: "boolean",
      conflictsWith: ["agent-workspace"],
    },
    {
      name: "agent-workspace",
      description: "Run in the parent agent workspace.",
      valueType: "boolean",
      conflictsWith: ["isolated", "environment"],
    },
    {
      name: "environment",
      description: "Execution environment id. Implies isolated execution.",
      valueType: "string",
      valueName: "environment-id",
      conflictsWith: ["agent-workspace"],
    },
    {
      name: "tool-group",
      description: "Repeatable ad-hoc tool group. Omit --profile when using ad-hoc tool groups.",
      valueType: "string",
      valueName: "group",
      enumValues: SUBAGENT_TOOL_GROUP_KEYS,
      repeatable: true,
      conflictsWith: ["profile"],
    },
    {
      name: "credential",
      description: "Repeatable credential env key to allowlist for the subagent.",
      valueType: "string",
      valueName: "env-key",
      repeatable: true,
    },
    {
      name: "json",
      description: "Structured JSON object containing prompt, plus optional profile, context, execution, environmentId, credentialAllowlist, and toolGroups.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Spawn a reviewer subagent",
      command: "panda subagent spawn \"Inspect the runtime wiring.\" --profile workspace",
    },
    {
      description: "Spawn an isolated subagent in an existing environment",
      command: "panda subagent spawn @task.md --context @context.md --environment env_123",
    },
    {
      description: "Use JSON input",
      command: "panda subagent spawn --json '{\"profile\":\"workspace\",\"prompt\":\"Inspect the runtime wiring.\"}'",
    },
  ],
  requiredCapabilities: [SUBAGENT_SPAWN_COMMAND_NAME],
  resultShape: {
    status: "spawned",
    sessionId: "string",
    threadId: "string",
    profile: "string",
    profileSource: "builtin|custom|ad_hoc",
    execution: "agent_workspace|isolated_environment",
    environmentId: "string|null",
    note: "string",
  },
};

export function createSubagentProfileUpsertCommand(
  store: SubagentProfileUpsertCommandStore,
): RegisteredCommand {
  return {
    descriptor: subagentProfileUpsertCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseUpsertProfileInput(request.input);
      const profile = await store.upsertProfile({
        ...input,
        source: "custom",
        agentKey: request.scope.agentKey,
        createdByAgentKey: request.scope.agentKey,
        transcriptMode: "none",
      });
      const output = requireCommandJsonObject(
        serializeProfile(profile),
        "subagent.profile.upsert result",
      );

      return {
        ok: true,
        command: SUBAGENT_PROFILE_UPSERT_COMMAND_NAME,
        output,
        summary: `Upserted subagent profile ${profile.slug}.`,
      };
    },
  };
}

export function createSubagentProfileListCommand(
  store: SubagentProfileListCommandStore,
): RegisteredCommand {
  return {
    descriptor: subagentProfileListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseListProfilesInput(request.input);
      const profiles = await store.listProfiles({
        agentKey: request.scope.agentKey,
        includeDisabled: input.includeDisabled,
      });
      const output = requireCommandJsonObject({
        count: profiles.length,
        profiles: profiles.map((profile) => serializeProfile(profile)),
      }, "subagent.profile.list result");

      return {
        ok: true,
        command: SUBAGENT_PROFILE_LIST_COMMAND_NAME,
        output,
        summary: `Found ${profiles.length} subagent profile${profiles.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

export function createSubagentProfileShowCommand(
  store: SubagentProfileShowCommandStore,
): RegisteredCommand {
  return {
    descriptor: subagentProfileShowCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseShowProfileInput(request.input);
      const profile = await store.getProfile({
        slug: input.slug,
        agentKey: request.scope.agentKey,
        includeDisabled: input.includeDisabled,
      });
      if (!profile) {
        throw new Error(`Subagent profile ${input.slug} was not found.`);
      }
      const output = requireCommandJsonObject(
        serializeProfile(profile, {includePrompt: true}),
        "subagent.profile.show result",
      );

      return {
        ok: true,
        command: SUBAGENT_PROFILE_SHOW_COMMAND_NAME,
        output,
        summary: `Loaded subagent profile ${profile.slug}.`,
      };
    },
  };
}

function createSubagentProfileStateCommand(
  store: SubagentProfileStateCommandStore,
  options: {
    descriptor: CommandDescriptor;
    commandName: typeof SUBAGENT_PROFILE_ENABLE_COMMAND_NAME | typeof SUBAGENT_PROFILE_DISABLE_COMMAND_NAME;
    enabled: boolean;
  },
): RegisteredCommand {
  return {
    descriptor: options.descriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseProfileStateInput(request.input, options.commandName);
      const profile = await store.setProfileEnabled({
        slug: input.slug,
        agentKey: request.scope.agentKey,
        enabled: options.enabled,
      });
      const output = requireCommandJsonObject(
        serializeProfile(profile),
        `${options.commandName} result`,
      );

      return {
        ok: true,
        command: options.commandName,
        output,
        summary: `${options.enabled ? "Enabled" : "Disabled"} subagent profile ${profile.slug}.`,
      };
    },
  };
}

export function createSubagentProfileEnableCommand(
  store: SubagentProfileStateCommandStore,
): RegisteredCommand {
  return createSubagentProfileStateCommand(store, {
    descriptor: subagentProfileEnableCommandDescriptor,
    commandName: SUBAGENT_PROFILE_ENABLE_COMMAND_NAME,
    enabled: true,
  });
}

export function createSubagentProfileDisableCommand(
  store: SubagentProfileStateCommandStore,
): RegisteredCommand {
  return createSubagentProfileStateCommand(store, {
    descriptor: subagentProfileDisableCommandDescriptor,
    commandName: SUBAGENT_PROFILE_DISABLE_COMMAND_NAME,
    enabled: false,
  });
}

export function createSubagentSpawnCommand(
  subagentSessions: SubagentSpawnSessionCreator,
): RegisteredCommand {
  return {
    descriptor: subagentSpawnCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseSpawnInput(request.input);
      const created = await subagentSessions.createSubagentSession({
        agentKey: request.scope.agentKey,
        parentSessionId: request.scope.sessionId,
        task: input.prompt,
        ...(input.context !== undefined ? {context: input.context} : {}),
        ...(input.profile !== undefined ? {profile: input.profile} : {}),
        ...(input.toolGroups !== undefined ? {toolGroups: input.toolGroups} : {}),
        ...(input.execution !== undefined ? {execution: input.execution} : {}),
        ...(input.environmentId !== undefined ? {environmentId: input.environmentId} : {}),
        credentialAllowlist: input.credentialAllowlist,
        ...(request.scope.identityId ? {createdByIdentityId: request.scope.identityId} : {}),
      });

      const metadata = readSubagentSessionMetadata(created.session.metadata);
      if (!metadata) {
        throw new Error("Subagent session service returned a session without subagent metadata.");
      }

      const output = requireCommandJsonObject({
        status: "spawned",
        sessionId: created.session.id,
        threadId: created.thread.id,
        profile: metadata.profile.slug,
        profileSource: metadata.profile.source,
        execution: metadata.execution,
        ...(created.environment?.id ? {environmentId: created.environment.id} : {}),
        note: "Progress and completion will arrive through A2A commands, not a background job.",
      }, "subagent.spawn result");

      return {
        ok: true,
        command: SUBAGENT_SPAWN_COMMAND_NAME,
        output,
        summary: `Spawned subagent session ${created.session.id}.`,
      };
    },
  };
}
