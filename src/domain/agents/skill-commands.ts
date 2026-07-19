import type {JsonObject} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {commandScopeDenied} from "../commands/errors.js";
import type {AgentSkillOperation, ExecutionSkillPolicy} from "../execution-environments/types.js";
import {
  isExecutionSkillAllowed,
  normalizeAgentSkillOperations,
} from "../execution-environments/policy.js";
import type {CommandDescriptor, CommandRequest, CommandScope, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import type {AgentStore} from "./store.js";
import {
  AgentSkillNotEditableError,
  MAX_AGENT_SKILL_CONTENT_CHARS,
  MAX_AGENT_SKILL_DESCRIPTION_CHARS,
  MAX_AGENT_SKILL_TAG_CHARS,
  MAX_AGENT_SKILL_TAGS,
  normalizeAgentSkillContent,
  normalizeAgentSkillDescription,
  normalizeAgentSkillTags,
  normalizeSkillKey,
  type AgentSkillRecord,
} from "./types.js";

export const SKILL_LIST_COMMAND_NAME = "skill.list";
export const SKILL_SHOW_COMMAND_NAME = "skill.show";
export const SKILL_LOAD_COMMAND_NAME = "skill.load";
export const SKILL_SET_COMMAND_NAME = "skill.set";
export const SKILL_PATCH_COMMAND_NAME = "skill.patch";
export const SKILL_DELETE_COMMAND_NAME = "skill.delete";

export type AgentSkillCommandStore = Pick<
  AgentStore,
  | "deleteAgentSkillAsAgent"
  | "listAgentSkills"
  | "loadAgentSkill"
  | "readAgentSkill"
  | "setAgentSkillAsAgent"
  | "updateAgentSkillDescriptionAsAgent"
>;

const SKILL_KEY_POSITIONAL_ARGUMENT = {
  name: "skill-key",
  description: "Stable slug-style skill key, for example calendar or trip_planner.",
  required: true,
  kind: "positional" as const,
  valueType: "string" as const,
  valueName: "skill-key",
};

const SKILL_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing skillKey.",
  valueType: "json" as const,
};

const SKILL_DESCRIPTION_OPTION_ARGUMENT = {
  name: "description",
  description: `Short injected summary. Max ${MAX_AGENT_SKILL_DESCRIPTION_CHARS} characters.`,
  required: true,
  valueType: "string" as const,
  valueName: "text|@file|@-",
  valueSources: ["literal", "file", "stdin"] as const,
};

const SKILL_CONTENT_OPTION_ARGUMENT = {
  name: "content",
  description: `Full markdown skill body. Max ${MAX_AGENT_SKILL_CONTENT_CHARS} characters.`,
  required: true,
  valueType: "string" as const,
  valueName: "text|@file|@-",
  valueSources: ["literal", "file", "stdin"] as const,
};

const SKILL_TAG_OPTION_ARGUMENT = {
  name: "tag",
  description: `Repeatable lowercase discovery tag. Max ${MAX_AGENT_SKILL_TAGS} tags, ${MAX_AGENT_SKILL_TAG_CHARS} chars each.`,
  valueType: "string" as const,
  valueName: "tag",
  repeatable: true,
};

function requireCommandJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function rejectUnknownKeys(input: Record<string, unknown>, commandName: string, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`${commandName} does not accept ${key}.`);
    }
  }
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value;
}

function readSkillKey(value: unknown, commandName: string): string {
  return normalizeSkillKey(readRequiredString(value, `${commandName} skillKey`));
}

function parseLoadInput(input: unknown, commandName: string) {
  if (!isRecord(input)) {
    throw new Error(`${commandName} input must be a JSON object.`);
  }
  rejectUnknownKeys(input, commandName, ["skillKey"]);

  return {
    skillKey: readSkillKey(input.skillKey, commandName),
  };
}

function parseListInput(input: unknown, commandName: string) {
  if (!isRecord(input)) {
    throw new Error(`${commandName} input must be a JSON object.`);
  }
  rejectUnknownKeys(input, commandName, ["tag", "tags"]);

  const rawTags = Array.isArray(input.tags)
    ? input.tags
    : input.tag === undefined
      ? []
      : [input.tag];

  return {
    tags: normalizeAgentSkillTags(rawTags),
  };
}

function parseSetInput(input: unknown, commandName: string) {
  if (!isRecord(input)) {
    throw new Error(`${commandName} input must be a JSON object.`);
  }
  rejectUnknownKeys(input, commandName, ["skillKey", "description", "content", "tags"]);

  return {
    skillKey: readSkillKey(input.skillKey, commandName),
    description: normalizeAgentSkillDescription(readRequiredString(input.description, `${commandName} description`)),
    content: normalizeAgentSkillContent(readRequiredString(input.content, `${commandName} content`)),
    tags: normalizeAgentSkillTags(Array.isArray(input.tags) ? input.tags : []),
  };
}

function parsePatchInput(input: unknown, commandName: string) {
  if (!isRecord(input)) {
    throw new Error(`${commandName} input must be a JSON object.`);
  }
  rejectUnknownKeys(input, commandName, ["skillKey", "description", "patch"]);
  const description = isRecord(input.patch)
    ? input.patch.description
    : input.description;

  return {
    skillKey: readSkillKey(input.skillKey, commandName),
    description: normalizeAgentSkillDescription(readRequiredString(description, `${commandName} description`)),
  };
}

function parseDeleteInput(input: unknown, commandName: string) {
  if (!isRecord(input)) {
    throw new Error(`${commandName} input must be a JSON object.`);
  }
  rejectUnknownKeys(input, commandName, ["skillKey"]);

  return {
    skillKey: readSkillKey(input.skillKey, commandName),
  };
}

function readSkillPolicy(scope: CommandScope): ExecutionSkillPolicy {
  return scope.skillPolicy ?? {mode: "all_agent"};
}

function isSkillVisible(scope: CommandScope, skillKey: string): boolean {
  return isExecutionSkillAllowed(readSkillPolicy(scope), skillKey);
}

function assertSkillAllowed(scope: CommandScope, skillKey: string): void {
  if (isSkillVisible(scope, skillKey)) {
    return;
  }

  throw commandScopeDenied(
    "The requested skill is not allowed in this execution environment.",
    "resource_scope_denied",
    "The current command lease does not permit access to that skill.",
  );
}

function assertAgentSkillOperationAllowed(scope: CommandScope, operation: AgentSkillOperation): void {
  const allowedOperations = scope.agentSkillAllowedOperations === undefined
    ? undefined
    : normalizeAgentSkillOperations(scope.agentSkillAllowedOperations);
  if (allowedOperations === undefined || allowedOperations.includes(operation)) {
    return;
  }

  throw commandScopeDenied(
    `skill.${operation} is not allowed in this execution environment.`,
    "command_scope_denied",
    "The current command lease does not permit this skill operation.",
  );
}

function assertMutationAllowed(scope: CommandScope): void {
  if (readSkillPolicy(scope).mode === "all_agent") {
    return;
  }

  throw commandScopeDenied(
    "Skill mutation is not allowed in this execution environment.",
    "command_scope_denied",
    "The current command lease does not permit skill mutation.",
  );
}

async function mutateAgentSkill<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentSkillNotEditableError) {
      throw new Error(error.message);
    }

    throw error;
  }
}

function serializeLoadedSkill(agentKey: string, skillKey: string, record: AgentSkillRecord | null): JsonObject {
  if (!record) {
    return requireCommandJsonObject({
      operation: "load",
      agentKey,
      skillKey,
      found: false,
    }, "skill.load result");
  }

  return requireCommandJsonObject({
    operation: "load",
    agentKey,
    skillKey: record.skillKey,
    found: true,
    description: record.description,
    content: record.content,
    contentBytes: Buffer.byteLength(record.content, "utf8"),
    loadCount: record.loadCount,
    ...(record.lastLoadedAt !== undefined ? {lastLoadedAt: record.lastLoadedAt} : {}),
    tags: [...record.tags],
  }, "skill.load result");
}

function serializeSkillSummary(record: AgentSkillRecord): JsonObject {
  return requireCommandJsonObject({
    skillKey: record.skillKey,
    description: record.description,
    contentBytes: Buffer.byteLength(record.content, "utf8"),
    loadCount: record.loadCount,
    ...(record.lastLoadedAt !== undefined ? {lastLoadedAt: record.lastLoadedAt} : {}),
    tags: [...record.tags],
    updatedAt: record.updatedAt,
  }, "skill summary");
}

function serializeSkillList(agentKey: string, records: readonly AgentSkillRecord[]): JsonObject {
  return requireCommandJsonObject({
    operation: "list",
    agentKey,
    count: records.length,
    skills: records.map(serializeSkillSummary),
  }, "skill.list result");
}

function serializeShownSkill(agentKey: string, skillKey: string, record: AgentSkillRecord | null): JsonObject {
  if (!record) {
    return requireCommandJsonObject({
      operation: "show",
      agentKey,
      skillKey,
      found: false,
    }, "skill.show result");
  }

  return requireCommandJsonObject({
    operation: "show",
    agentKey,
    skillKey: record.skillKey,
    found: true,
    description: record.description,
    content: record.content,
    contentBytes: Buffer.byteLength(record.content, "utf8"),
    loadCount: record.loadCount,
    ...(record.lastLoadedAt !== undefined ? {lastLoadedAt: record.lastLoadedAt} : {}),
    tags: [...record.tags],
    updatedAt: record.updatedAt,
  }, "skill.show result");
}

function serializeMutatedSkill(
  operation: "set" | "patch",
  agentKey: string,
  record: AgentSkillRecord,
): JsonObject {
  return requireCommandJsonObject({
    operation,
    agentKey,
    skillKey: record.skillKey,
    description: record.description,
    contentBytes: Buffer.byteLength(record.content, "utf8"),
    tags: [...record.tags],
  }, `skill.${operation} result`);
}

export const skillLoadCommandDescriptor: CommandDescriptor = {
  name: SKILL_LOAD_COMMAND_NAME,
  summary: "Load a stored skill body for the current agent.",
  description: "Loads a full agent-scoped skill body when the injected skill summary is not enough. Scope supplies the agent key.",
  usage: "panda skill load <skill-key>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [SKILL_KEY_POSITIONAL_ARGUMENT, SKILL_JSON_ARGUMENT],
  examples: [{
    description: "Load the calendar skill",
    command: "panda skill load calendar",
  }, {
    description: "Use JSON input",
    command: "panda skill load --json '{\"skillKey\":\"calendar\"}'",
  }],
  requiredCapabilities: [SKILL_LOAD_COMMAND_NAME],
  resultShape: {
    operation: "load",
    agentKey: "string",
    skillKey: "string",
    found: "boolean",
  },
};

export const skillSetCommandDescriptor: CommandDescriptor = {
  name: SKILL_SET_COMMAND_NAME,
  summary: "Create or replace a stored skill for the current agent.",
  description: "Creates or replaces an agent-scoped markdown skill. Scope supplies the agent key and skill mutation policy.",
  usage: "panda skill set <skill-key> --description <text|@file|@-> --content <text|@file|@-> [--tag <tag>...]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    SKILL_KEY_POSITIONAL_ARGUMENT,
    SKILL_DESCRIPTION_OPTION_ARGUMENT,
    SKILL_CONTENT_OPTION_ARGUMENT,
    SKILL_TAG_OPTION_ARGUMENT,
    SKILL_JSON_ARGUMENT,
  ],
  examples: [{
    description: "Store a calendar skill",
    command: "panda skill set calendar --description \"Use this for calendar work.\" --content @SKILL.md --tag calendar",
  }, {
    description: "Read skill body from stdin",
    command: "cat SKILL.md | panda skill set calendar --description \"Use this for calendar work.\" --content @-",
  }],
  requiredCapabilities: [SKILL_SET_COMMAND_NAME],
  resultShape: {
    operation: "set",
    agentKey: "string",
    skillKey: "string",
    description: "string",
    contentBytes: "number",
    tags: ["string"],
  },
};

export const skillPatchCommandDescriptor: CommandDescriptor = {
  name: SKILL_PATCH_COMMAND_NAME,
  summary: "Patch supported metadata for a stored skill.",
  description: "Updates a skill's injected description without changing the skill body or tags. Scope supplies the agent key and skill mutation policy.",
  usage: "panda skill patch <skill-key> --description <text|@file|@->",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    SKILL_KEY_POSITIONAL_ARGUMENT,
    SKILL_DESCRIPTION_OPTION_ARGUMENT,
    SKILL_JSON_ARGUMENT,
  ],
  examples: [{
    description: "Patch a skill summary",
    command: "panda skill patch calendar --description \"Use this for calendar work.\"",
  }],
  requiredCapabilities: [SKILL_PATCH_COMMAND_NAME],
  resultShape: {
    operation: "patch",
    agentKey: "string",
    skillKey: "string",
    description: "string",
    contentBytes: "number",
    tags: ["string"],
  },
};

export const skillDeleteCommandDescriptor: CommandDescriptor = {
  name: SKILL_DELETE_COMMAND_NAME,
  summary: "Delete a stored skill for the current agent.",
  description: "Deletes an agent-scoped skill by key. Scope supplies the agent key and skill mutation policy.",
  usage: "panda skill delete <skill-key> --yes",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    SKILL_KEY_POSITIONAL_ARGUMENT,
    {
      name: "yes",
      description: "Confirm deletion in non-interactive CLI usage.",
      required: true,
      valueType: "boolean",
    },
    SKILL_JSON_ARGUMENT,
  ],
  examples: [{
    description: "Delete the calendar skill",
    command: "panda skill delete calendar --yes",
  }, {
    description: "Use JSON input",
    command: "panda skill delete --json '{\"skillKey\":\"calendar\"}'",
  }],
  requiredCapabilities: [SKILL_DELETE_COMMAND_NAME],
  resultShape: {
    operation: "delete",
    agentKey: "string",
    skillKey: "string",
    deleted: "boolean",
  },
};

export const skillListCommandDescriptor: CommandDescriptor = {
  name: SKILL_LIST_COMMAND_NAME,
  summary: "List stored skills available to the current agent.",
  description: "Lists agent-scoped skill summaries visible in the current execution environment. Full bodies stay out of list output; use panda skill show <skill-key> when needed.",
  usage: "panda skill list [--tag <tag>...] [--output keys|json|table]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      ...SKILL_TAG_OPTION_ARGUMENT,
      description: "Optional repeatable tag filter. A listed skill must contain every supplied tag.",
    },
    {
      name: "output",
      description: "CLI output format. This controls only native stdout and is not sent to skill.list.",
      valueType: "string",
      enumValues: ["keys", "json", "table"],
      defaultValue: "keys",
    },
    {
      name: "json",
      description: "Structured JSON object containing optional tag or tags.",
      valueType: "json",
    },
  ],
  examples: [{
    description: "List available skills",
    command: "panda skill list",
  }, {
    description: "Filter by tag",
    command: "panda skill list --tag calendar",
  }, {
    description: "Print the complete structured result",
    command: "panda skill list --output json",
  }],
  requiredCapabilities: [SKILL_LIST_COMMAND_NAME],
  resultShape: {
    operation: "list",
    agentKey: "string",
    count: "number",
    skills: [{
      skillKey: "string",
      description: "string",
      contentBytes: "number",
      tags: ["string"],
    }],
  },
};

export const skillShowCommandDescriptor: CommandDescriptor = {
  name: SKILL_SHOW_COMMAND_NAME,
  summary: "Show a stored skill without incrementing its load counter.",
  description: "Reads an agent-scoped skill body and metadata without recording a runtime load. Use panda skill load when the agent is actively loading the skill into its working context.",
  usage: "panda skill show <skill-key>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [SKILL_KEY_POSITIONAL_ARGUMENT, SKILL_JSON_ARGUMENT],
  examples: [{
    description: "Show the calendar skill",
    command: "panda skill show calendar",
  }, {
    description: "Use JSON input",
    command: "panda skill show --json '{\"skillKey\":\"calendar\"}'",
  }],
  requiredCapabilities: [SKILL_SHOW_COMMAND_NAME],
  resultShape: {
    operation: "show",
    agentKey: "string",
    skillKey: "string",
    found: "boolean",
  },
};

function skillMatchesTags(record: AgentSkillRecord, tags: readonly string[]): boolean {
  return tags.every((tag) => record.tags.includes(tag));
}

export function createSkillListCommand(store: AgentSkillCommandStore): RegisteredCommand {
  return {
    descriptor: skillListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseListInput(request.input, SKILL_LIST_COMMAND_NAME);
      assertAgentSkillOperationAllowed(request.scope, "load");
      const records = (await store.listAgentSkills(request.scope.agentKey))
        .filter((record) => isSkillVisible(request.scope, record.skillKey))
        .filter((record) => skillMatchesTags(record, input.tags));

      return {
        ok: true,
        command: SKILL_LIST_COMMAND_NAME,
        output: serializeSkillList(request.scope.agentKey, records),
        summary: `Listed ${records.length} skill${records.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

export function createSkillShowCommand(store: AgentSkillCommandStore): RegisteredCommand {
  return {
    descriptor: skillShowCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseLoadInput(request.input, SKILL_SHOW_COMMAND_NAME);
      assertAgentSkillOperationAllowed(request.scope, "load");
      assertSkillAllowed(request.scope, input.skillKey);
      const record = await store.readAgentSkill(request.scope.agentKey, input.skillKey);

      return {
        ok: true,
        command: SKILL_SHOW_COMMAND_NAME,
        output: serializeShownSkill(request.scope.agentKey, input.skillKey, record),
        summary: record ? `Showed skill ${input.skillKey}.` : `Skill ${input.skillKey} was not found.`,
      };
    },
  };
}

function createSkillLoadCommandWithDescriptor(
  store: AgentSkillCommandStore,
  commandName: typeof SKILL_LOAD_COMMAND_NAME,
  descriptor: CommandDescriptor,
): RegisteredCommand {
  return {
    descriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseLoadInput(request.input, commandName);
      assertAgentSkillOperationAllowed(request.scope, "load");
      assertSkillAllowed(request.scope, input.skillKey);
      const record = await store.loadAgentSkill(request.scope.agentKey, input.skillKey);

      return {
        ok: true,
        command: commandName,
        output: serializeLoadedSkill(request.scope.agentKey, input.skillKey, record),
        summary: record ? `Loaded skill ${input.skillKey}.` : `Skill ${input.skillKey} was not found.`,
      };
    },
  };
}

function createSkillSetCommandWithDescriptor(
  store: AgentSkillCommandStore,
  commandName: typeof SKILL_SET_COMMAND_NAME,
  descriptor: CommandDescriptor,
): RegisteredCommand {
  return {
    descriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseSetInput(request.input, commandName);
      assertAgentSkillOperationAllowed(request.scope, "set");
      assertSkillAllowed(request.scope, input.skillKey);
      assertMutationAllowed(request.scope);
      const record = await mutateAgentSkill(() => store.setAgentSkillAsAgent(
        request.scope.agentKey,
        input.skillKey,
        input.description,
        input.content,
        input.tags,
      ));

      return {
        ok: true,
        command: commandName,
        output: serializeMutatedSkill("set", request.scope.agentKey, record),
        summary: `Set skill ${input.skillKey}.`,
      };
    },
  };
}

function createSkillPatchCommandWithDescriptor(
  store: AgentSkillCommandStore,
  commandName: typeof SKILL_PATCH_COMMAND_NAME,
  descriptor: CommandDescriptor,
): RegisteredCommand {
  return {
    descriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parsePatchInput(request.input, commandName);
      assertAgentSkillOperationAllowed(request.scope, "patch");
      assertSkillAllowed(request.scope, input.skillKey);
      assertMutationAllowed(request.scope);
      const record = await mutateAgentSkill(() => store.updateAgentSkillDescriptionAsAgent(
        request.scope.agentKey,
        input.skillKey,
        input.description,
      ));
      if (!record) {
        throw new Error(`Skill ${input.skillKey} does not exist.`);
      }

      return {
        ok: true,
        command: commandName,
        output: serializeMutatedSkill("patch", request.scope.agentKey, record),
        summary: `Patched skill ${input.skillKey}.`,
      };
    },
  };
}

function createSkillDeleteCommandWithDescriptor(
  store: AgentSkillCommandStore,
  commandName: typeof SKILL_DELETE_COMMAND_NAME,
  descriptor: CommandDescriptor,
): RegisteredCommand {
  return {
    descriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseDeleteInput(request.input, commandName);
      assertAgentSkillOperationAllowed(request.scope, "delete");
      assertSkillAllowed(request.scope, input.skillKey);
      assertMutationAllowed(request.scope);
      const deleted = await mutateAgentSkill(() => store.deleteAgentSkillAsAgent(
        request.scope.agentKey,
        input.skillKey,
      ));

      return {
        ok: true,
        command: commandName,
        output: requireCommandJsonObject({
          operation: "delete",
          agentKey: request.scope.agentKey,
          skillKey: input.skillKey,
          deleted,
        }, "skill.delete result"),
        summary: deleted ? `Deleted skill ${input.skillKey}.` : `Skill ${input.skillKey} was not found.`,
      };
    },
  };
}

export function createSkillLoadCommand(store: AgentSkillCommandStore): RegisteredCommand {
  return createSkillLoadCommandWithDescriptor(store, SKILL_LOAD_COMMAND_NAME, skillLoadCommandDescriptor);
}

export function createSkillSetCommand(store: AgentSkillCommandStore): RegisteredCommand {
  return createSkillSetCommandWithDescriptor(store, SKILL_SET_COMMAND_NAME, skillSetCommandDescriptor);
}

export function createSkillPatchCommand(store: AgentSkillCommandStore): RegisteredCommand {
  return createSkillPatchCommandWithDescriptor(store, SKILL_PATCH_COMMAND_NAME, skillPatchCommandDescriptor);
}

export function createSkillDeleteCommand(store: AgentSkillCommandStore): RegisteredCommand {
  return createSkillDeleteCommandWithDescriptor(store, SKILL_DELETE_COMMAND_NAME, skillDeleteCommandDescriptor);
}
