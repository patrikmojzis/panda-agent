import type {JsonObject} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {commandScopeDenied} from "../commands/errors.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import type {CredentialService} from "./resolver.js";

export const ENV_SET_COMMAND_NAME = "env.set";
export const ENV_CLEAR_COMMAND_NAME = "env.clear";
export const ENV_LIST_COMMAND_NAME = "env.list";

export type EnvCommandService = Pick<CredentialService, "setCredential" | "clearCredential" | "listCredentialMetadata">;

const ENV_KEY_POSITIONAL_ARGUMENT = {
  name: "key",
  description: "Shell env key to store or clear, for example GITHUB_TOKEN.",
  required: true,
  kind: "positional" as const,
  valueType: "string" as const,
  valueName: "key",
};

const ENV_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object for this env command.",
  valueType: "json" as const,
};

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
}

function parseSetEnvInput(input: unknown): {key: string; value: string} {
  if (!isRecord(input)) {
    throw new Error("env.set input must be a JSON object.");
  }

  const value = input.value;
  if (typeof value !== "string") {
    throw new Error("env.set value must be a string.");
  }

  return {
    key: readRequiredString(input.key, "env.set key"),
    value,
  };
}

function parseClearEnvInput(input: unknown): {key: string} {
  if (!isRecord(input)) {
    throw new Error("env.clear input must be a JSON object.");
  }

  return {
    key: readRequiredString(input.key, "env.clear key"),
  };
}

function parseListEnvInput(input: unknown): {prefix?: string} {
  if (!isRecord(input)) {
    throw new Error("env.list input must be a JSON object.");
  }

  const prefix = input.prefix;
  if (prefix === undefined || prefix === null) {
    return {};
  }
  if (typeof prefix !== "string") {
    throw new Error("env.list prefix must be a string.");
  }

  const trimmed = prefix.trim();
  if (!trimmed) {
    return {};
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error("env.list prefix must be shell-safe, for example OPENAI or GITHUB_.");
  }

  return {prefix: trimmed};
}

function assertCredentialMutationAllowed(request: CommandRequest): void {
  if (request.scope.credentialMutationAllowed !== true) {
    throw commandScopeDenied(
      "Credential mutation is not allowed in this execution environment.",
      "command_scope_denied",
      "The current command lease does not permit credential mutation.",
    );
  }
}

function requireCommandJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

export const envSetCommandDescriptor: CommandDescriptor = {
  name: ENV_SET_COMMAND_NAME,
  summary: "Store an agent env secret.",
  description: "Persists a secret env value for future bash calls owned by the current agent.",
  usage: "panda env set <key> (--stdin|--from-file <path>)",
  inputModes: ["flags", "stdin", "json", "file"],
  outputModes: ["json", "text"],
  arguments: [
    ENV_KEY_POSITIONAL_ARGUMENT,
    {
      name: "stdin",
      description: "Read the secret value from stdin. JSON input may also provide key and value.",
      valueType: "boolean",
    },
    {
      name: "from-file",
      description: "Read the secret value from a local file path.",
      valueType: "string",
      valueName: "path",
    },
    ENV_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Store a secret from stdin",
      command: "printf '%s' \"$GITHUB_TOKEN\" | panda env set GITHUB_TOKEN --stdin",
    },
    {
      description: "Store a secret from a file",
      command: "panda env set OPENAI_API_KEY --from-file ./openai.key",
    },
    {
      description: "Store a secret from JSON",
      command: "panda env set --json @payload.json",
    },
  ],
  requiredCapabilities: ["env.set"],
  resultShape: {
    ok: "boolean",
    envKey: "string",
    valueLength: "number",
  },
};

export const envClearCommandDescriptor: CommandDescriptor = {
  name: ENV_CLEAR_COMMAND_NAME,
  summary: "Clear an agent env secret.",
  description: "Deletes a stored secret env value owned by the current agent.",
  usage: "panda env clear <key>",
  inputModes: ["flags", "json", "file"],
  outputModes: ["json", "text"],
  arguments: [
    ENV_KEY_POSITIONAL_ARGUMENT,
    ENV_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Clear a secret",
      command: "panda env clear GITHUB_TOKEN",
    },
    {
      description: "Clear a secret from JSON",
      command: "panda env clear --json '{\"key\":\"GITHUB_TOKEN\"}'",
    },
  ],
  requiredCapabilities: ["env.clear"],
  resultShape: {
    ok: "boolean",
    action: "clear",
    envKey: "string",
    deleted: "boolean",
  },
};

export const envListCommandDescriptor: CommandDescriptor = {
  name: ENV_LIST_COMMAND_NAME,
  summary: "List stored env secret names.",
  description: "Lists metadata for stored env secrets owned by the current agent without revealing values.",
  usage: "panda env list [--prefix <prefix>]",
  inputModes: ["flags", "json", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "prefix",
      description: "Only show env keys beginning with this shell-safe prefix.",
      valueType: "string",
      valueName: "prefix",
    },
    ENV_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "List stored env keys",
      command: "panda env list",
    },
    {
      description: "List matching env keys",
      command: "panda env list --prefix OPENAI_",
    },
  ],
  requiredCapabilities: ["env.list"],
  resultShape: {
    ok: "boolean",
    count: "number",
    prefix: "string|null",
    credentials: [{
      envKey: "string",
      keyVersion: "number",
      createdAt: "number",
      updatedAt: "number",
    }],
  },
};

export function createSetEnvValueCommand(service: EnvCommandService): RegisteredCommand {
  return {
    descriptor: envSetCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      assertCredentialMutationAllowed(request);
      const input = parseSetEnvInput(request.input);
      const record = await service.setCredential({
        envKey: input.key,
        value: input.value,
        agentKey: request.scope.agentKey,
      });
      const output = requireCommandJsonObject({
        ok: true,
        envKey: record.envKey,
        valueLength: record.value.length,
      }, "env.set result");

      return {
        ok: true,
        command: ENV_SET_COMMAND_NAME,
        output,
        summary: `Stored env value ${record.envKey}.`,
      };
    },
  };
}

export function createListEnvValuesCommand(service: EnvCommandService): RegisteredCommand {
  return {
    descriptor: envListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseListEnvInput(request.input);
      const credentials = await service.listCredentialMetadata({
        agentKey: request.scope.agentKey,
      });
      const filtered = credentials
        .filter((credential) => input.prefix === undefined || credential.envKey.startsWith(input.prefix))
        .map((credential) => ({
          envKey: credential.envKey,
          keyVersion: credential.keyVersion,
          createdAt: credential.createdAt,
          updatedAt: credential.updatedAt,
        }));
      const output = requireCommandJsonObject({
        ok: true,
        count: filtered.length,
        prefix: input.prefix ?? null,
        credentials: filtered,
      }, "env.list result");

      return {
        ok: true,
        command: ENV_LIST_COMMAND_NAME,
        output,
        summary: `Listed ${filtered.length} env value${filtered.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

export function createClearEnvValueCommand(service: EnvCommandService): RegisteredCommand {
  return {
    descriptor: envClearCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      assertCredentialMutationAllowed(request);
      const input = parseClearEnvInput(request.input);
      const deleted = await service.clearCredential({
        envKey: input.key,
        agentKey: request.scope.agentKey,
      });
      const output = requireCommandJsonObject({
        ok: true,
        action: "clear",
        envKey: input.key,
        agentKey: request.scope.agentKey,
        deleted,
      }, "env.clear result");

      return {
        ok: true,
        command: ENV_CLEAR_COMMAND_NAME,
        output,
        summary: deleted ? `Cleared env value ${input.key}.` : `No env value cleared for ${input.key}.`,
      };
    },
  };
}
