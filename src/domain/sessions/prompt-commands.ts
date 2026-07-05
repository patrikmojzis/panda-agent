import type {JsonObject} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import type {SessionStore} from "./store.js";
import {validateSessionPromptTransformExpression} from "./prompt-transform.js";
import {
  SESSION_PROMPT_SLUGS,
  normalizeSessionPromptSlug,
  type SessionPromptRecord,
  type SessionPromptSlug,
} from "./types.js";

export const SESSION_PROMPT_READ_COMMAND_NAME = "session.prompt.read";
export const SESSION_PROMPT_SET_COMMAND_NAME = "session.prompt.set";
export const SESSION_PROMPT_TRANSFORM_COMMAND_NAME = "session.prompt.transform";

export type SessionPromptCommandStore = Pick<
  SessionStore,
  "readSessionPrompt" | "setSessionPrompt" | "transformSessionPrompt"
>;

const SESSION_PROMPT_SLUG_ARGUMENT = {
  name: "slug",
  description: "Prompt slug: brief, memory, or heartbeat.",
  required: true,
  valueType: "string" as const,
  enumValues: SESSION_PROMPT_SLUGS,
};

const SESSION_PROMPT_SLUG_POSITIONAL_ARGUMENT = {
  ...SESSION_PROMPT_SLUG_ARGUMENT,
  kind: "positional" as const,
  valueName: "brief|memory|heartbeat",
};

const SESSION_PROMPT_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing slug, plus content or expression when required.",
  valueType: "json" as const,
};

const SESSION_PROMPT_CONTENT_ARGUMENT = {
  name: "content",
  description: "Replacement prompt content. Use @file or @- for multiline content.",
  required: true,
  valueType: "string" as const,
  valueName: "text|@file|@-",
  valueSources: ["literal", "file", "stdin"] as const,
};

function requireCommandJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
}

function readSessionPromptSlug(value: unknown, commandName: string): SessionPromptSlug {
  return normalizeSessionPromptSlug(readRequiredString(value, `${commandName} slug`));
}

function rejectUnknownKeys(input: Record<string, unknown>, commandName: string, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`${commandName} does not accept ${key}.`);
    }
  }
}

function parseSessionPromptReadInput(input: unknown) {
  if (!isRecord(input)) {
    throw new Error("session.prompt.read input must be a JSON object.");
  }
  rejectUnknownKeys(input, SESSION_PROMPT_READ_COMMAND_NAME, ["slug", "raw"]);

  return {
    slug: readSessionPromptSlug(input.slug, SESSION_PROMPT_READ_COMMAND_NAME),
  };
}

function unwrapSessionPromptContent(content: string, slug: SessionPromptSlug): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return content;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return content;
  }

  if (!isRecord(parsed)) {
    return content;
  }
  if (parsed.slug !== slug || typeof parsed.content !== "string") {
    return content;
  }
  if (
    parsed.operation !== "read"
    && parsed.operation !== "set"
    && parsed.operation !== "transform"
  ) {
    return content;
  }

  return parsed.content;
}

function parseSessionPromptSetInput(input: unknown) {
  if (!isRecord(input)) {
    throw new Error("session.prompt.set input must be a JSON object.");
  }
  rejectUnknownKeys(input, SESSION_PROMPT_SET_COMMAND_NAME, ["slug", "content"]);
  const slug = readSessionPromptSlug(input.slug, SESSION_PROMPT_SET_COMMAND_NAME);

  return {
    slug,
    content: unwrapSessionPromptContent(
      readRequiredString(input.content, "session.prompt.set content"),
      slug,
    ),
  };
}

function parseSessionPromptTransformInput(input: unknown) {
  if (!isRecord(input)) {
    throw new Error("session.prompt.transform input must be a JSON object.");
  }
  rejectUnknownKeys(input, SESSION_PROMPT_TRANSFORM_COMMAND_NAME, ["slug", "expression"]);

  return {
    slug: readSessionPromptSlug(input.slug, SESSION_PROMPT_TRANSFORM_COMMAND_NAME),
    expression: validateSessionPromptTransformExpression(
      readRequiredString(input.expression, "session.prompt.transform expression"),
    ),
  };
}

function serializeSessionPromptResult(
  sessionId: string,
  slug: SessionPromptSlug,
  operation: "read" | "set" | "transform",
  record: SessionPromptRecord | null,
): JsonObject {
  return requireCommandJsonObject({
    sessionId,
    slug,
    operation,
    exists: record !== null,
    content: record?.content ?? "",
    ...(record ? {updatedAt: record.updatedAt} : {}),
  }, `session.prompt.${operation} result`);
}

export const sessionPromptReadCommandDescriptor: CommandDescriptor = {
  name: SESSION_PROMPT_READ_COMMAND_NAME,
  summary: "Read a prompt for the current session.",
  description: "Reads one durable prompt slot for the current runtime session. Scope supplies the session id; do not pass one. Use --raw when piping content into set.",
  usage: "panda session prompt current read <brief|memory|heartbeat> [--raw]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    SESSION_PROMPT_SLUG_POSITIONAL_ARGUMENT,
    {
      name: "raw",
      description: "Print only the prompt content in native CLI mode; useful before piping into set --content @-.",
      valueType: "boolean",
    },
    SESSION_PROMPT_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Read the session brief prompt",
      command: "panda session prompt current read brief",
    },
    {
      description: "Read raw content for editing",
      command: "panda session prompt current read brief --raw > brief.md",
    },
    {
      description: "Use JSON input",
      command: "panda session prompt current read --json '{\"slug\":\"brief\"}'",
    },
  ],
  requiredCapabilities: [SESSION_PROMPT_READ_COMMAND_NAME],
  resultShape: {
    sessionId: "string",
    slug: "string",
    operation: "read",
    exists: "boolean",
    content: "string",
  },
};

export const sessionPromptSetCommandDescriptor: CommandDescriptor = {
  name: SESSION_PROMPT_SET_COMMAND_NAME,
  summary: "Replace a prompt for the current session.",
  description: "Replaces one durable prompt slot for the current runtime session. Scope supplies the session id; do not pass one. If content is accidentally passed as this command's read envelope, Panda unwraps the nested content for the same slug.",
  usage: "panda session prompt current set <brief|memory|heartbeat> --content <text|@file|@->",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    SESSION_PROMPT_SLUG_POSITIONAL_ARGUMENT,
    SESSION_PROMPT_CONTENT_ARGUMENT,
    SESSION_PROMPT_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Replace the session memory prompt from a file",
      command: "panda session prompt current set memory --content @memory.md",
    },
    {
      description: "Replace the session brief prompt from stdin",
      command: "cat brief.md | panda session prompt current set brief --content @-",
    },
    {
      description: "Replace the session memory prompt",
      command: "panda session prompt current set --json '{\"slug\":\"memory\",\"content\":\"Remember this.\"}'",
    },
  ],
  requiredCapabilities: [SESSION_PROMPT_SET_COMMAND_NAME],
  resultShape: {
    sessionId: "string",
    slug: "string",
    operation: "set",
    exists: true,
    content: "string",
    updatedAt: "number",
  },
};

export const sessionPromptTransformCommandDescriptor: CommandDescriptor = {
  name: SESSION_PROMPT_TRANSFORM_COMMAND_NAME,
  summary: "Transform a prompt for the current session.",
  description: "Transforms one durable prompt slot with safe append/prepend/replace shorthands, or a restricted SQL-ish expression over the current content value. Scope supplies the session id; do not pass one.",
  usage: "panda session prompt current transform <brief|memory|heartbeat> (--append <text|@file|@->|--prepend <text|@file|@->|--replace <pattern> --with <text|@file|@->|--expression <expr|@file|@->)",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    SESSION_PROMPT_SLUG_POSITIONAL_ARGUMENT,
    {
      name: "append",
      description: "Text to append to the current prompt. Use @file or @- for multiline content.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "prepend",
      description: "Text to prepend to the current prompt. Use @file or @- for multiline content.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "replace",
      description: "Literal text to replace in the current prompt.",
      valueType: "string",
      valueName: "pattern",
    },
    {
      name: "with",
      description: "Replacement text for --replace. Use @file or @- for multiline content.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "expression",
      description: "Advanced restricted SQL-ish expression over content.",
      valueType: "string",
      valueName: "expr|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    SESSION_PROMPT_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Append a line to the heartbeat prompt",
      command: "printf '\\nCheck timers.' | panda session prompt current transform heartbeat --append @-",
    },
    {
      description: "Replace literal text in the memory prompt",
      command: "panda session prompt current transform memory --replace old --with new",
    },
    {
      description: "Use JSON input",
      command: "panda session prompt current transform --json '{\"slug\":\"heartbeat\",\"expression\":\"content || ''\\nCheck timers.''\"}'",
    },
  ],
  requiredCapabilities: [SESSION_PROMPT_TRANSFORM_COMMAND_NAME],
  resultShape: {
    sessionId: "string",
    slug: "string",
    operation: "transform",
    exists: "boolean",
    content: "string",
  },
};

export function createSessionPromptReadCommand(store: SessionPromptCommandStore): RegisteredCommand {
  return {
    descriptor: sessionPromptReadCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseSessionPromptReadInput(request.input);
      const record = await store.readSessionPrompt(request.scope.sessionId, input.slug);

      return {
        ok: true,
        command: SESSION_PROMPT_READ_COMMAND_NAME,
        output: serializeSessionPromptResult(request.scope.sessionId, input.slug, "read", record),
        summary: record ? `Read session prompt ${input.slug}.` : `Session prompt ${input.slug} is empty.`,
      };
    },
  };
}

export function createSessionPromptSetCommand(store: SessionPromptCommandStore): RegisteredCommand {
  return {
    descriptor: sessionPromptSetCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseSessionPromptSetInput(request.input);
      const record = await store.setSessionPrompt({
        sessionId: request.scope.sessionId,
        slug: input.slug,
        content: input.content,
      });

      return {
        ok: true,
        command: SESSION_PROMPT_SET_COMMAND_NAME,
        output: serializeSessionPromptResult(request.scope.sessionId, input.slug, "set", record),
        summary: `Set session prompt ${input.slug}.`,
      };
    },
  };
}

export function createSessionPromptTransformCommand(store: SessionPromptCommandStore): RegisteredCommand {
  return {
    descriptor: sessionPromptTransformCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseSessionPromptTransformInput(request.input);
      const record = await store.transformSessionPrompt({
        sessionId: request.scope.sessionId,
        slug: input.slug,
        expression: input.expression,
      });

      return {
        ok: true,
        command: SESSION_PROMPT_TRANSFORM_COMMAND_NAME,
        output: serializeSessionPromptResult(request.scope.sessionId, input.slug, "transform", record),
        summary: record ? `Transformed session prompt ${input.slug}.` : `Cleared session prompt ${input.slug}.`,
      };
    },
  };
}
