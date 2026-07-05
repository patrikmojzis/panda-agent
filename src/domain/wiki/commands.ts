import type {JsonObject} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {CommandFileResolver} from "../commands/files.js";
import type {
  CommandArtifactDescriptor,
  CommandDescriptor,
  CommandRequest,
  CommandSuccess,
  RegisteredCommand,
} from "../commands/types.js";

export const WIKI_READ_COMMAND_NAME = "wiki.read";
export const WIKI_SEARCH_COMMAND_NAME = "wiki.search";
export const WIKI_LIST_COMMAND_NAME = "wiki.list";
export const WIKI_DIFF_COMMAND_NAME = "wiki.diff";
export const WIKI_WRITE_COMMAND_NAME = "wiki.write";
export const WIKI_WRITE_SECTION_COMMAND_NAME = "wiki.write.section";
export const WIKI_MOVE_COMMAND_NAME = "wiki.move";
export const WIKI_ARCHIVE_COMMAND_NAME = "wiki.archive";
export const WIKI_RESTORE_COMMAND_NAME = "wiki.restore";
export const WIKI_ATTACH_IMAGE_COMMAND_NAME = "wiki.attach.image";
export const WIKI_FETCH_ASSET_COMMAND_NAME = "wiki.fetch.asset";
export const WIKI_DELETE_ASSET_COMMAND_NAME = "wiki.delete.asset";

type WikiReadFormat = "json" | "markdown";

export interface WikiReadCommandInput {
  path: string;
  locale?: string;
  format?: WikiReadFormat;
}

export interface WikiSearchCommandInput {
  query: string;
  path?: string;
  locale?: string;
  limit?: number;
}

export interface WikiListCommandInput {
  path?: string;
  locale?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface WikiDiffCommandInput {
  leftPath: string;
  rightPath: string;
  locale?: string;
  contextLines?: number;
}

export interface WikiWriteCommandInput {
  path: string;
  locale?: string;
  title?: string;
  description?: string;
  content: string;
  tags?: readonly string[];
  isPublished?: boolean;
  isPrivate?: boolean;
  createIfMissing?: boolean;
  baseUpdatedAt?: string;
}

export interface WikiWriteSectionCommandInput {
  path: string;
  locale?: string;
  section: string;
  content: string;
  title?: string;
  createIfMissing?: boolean;
  baseUpdatedAt?: string;
}

export interface WikiMoveCommandInput {
  path: string;
  locale?: string;
  destinationPath: string;
  rewriteLinks?: boolean;
  baseUpdatedAt?: string;
}

export interface WikiArchiveCommandInput {
  path: string;
  locale?: string;
  baseUpdatedAt?: string;
}

export interface WikiRestoreCommandInput {
  path: string;
  destinationPath: string;
  locale?: string;
  baseUpdatedAt?: string;
}

export interface WikiAttachImageCommandInput {
  path: string;
  locale?: string;
  section: string;
  slot: string;
  sourcePath: string;
  alt: string;
  caption?: string;
  title?: string;
  createIfMissing?: boolean;
  baseUpdatedAt?: string;
}

export interface WikiAttachImageResolvedCommandInput extends WikiAttachImageCommandInput {
  resolvedSourcePath: string;
}

export interface WikiFetchAssetCommandInput {
  assetPath: string;
}

export interface WikiDeleteAssetCommandInput {
  assetPath: string;
}

export interface WikiFetchAssetCommandResult {
  output: JsonObject;
  artifact: CommandArtifactDescriptor;
}

export interface WikiCommandService {
  readPage(agentKey: string, input: WikiReadCommandInput): Promise<JsonObject>;
  searchPages(agentKey: string, input: WikiSearchCommandInput): Promise<JsonObject>;
  listPages(agentKey: string, input: WikiListCommandInput): Promise<JsonObject>;
  diffPages(agentKey: string, input: WikiDiffCommandInput): Promise<JsonObject>;
  writePage(agentKey: string, input: WikiWriteCommandInput): Promise<JsonObject>;
  writeSection(agentKey: string, input: WikiWriteSectionCommandInput): Promise<JsonObject>;
  movePage(agentKey: string, input: WikiMoveCommandInput): Promise<JsonObject>;
  archivePage(agentKey: string, input: WikiArchiveCommandInput): Promise<JsonObject>;
  restorePage(agentKey: string, input: WikiRestoreCommandInput): Promise<JsonObject>;
  attachImage(agentKey: string, input: WikiAttachImageResolvedCommandInput): Promise<JsonObject>;
  fetchAsset(agentKey: string, input: WikiFetchAssetCommandInput): Promise<WikiFetchAssetCommandResult>;
  deleteAsset(agentKey: string, input: WikiDeleteAssetCommandInput): Promise<JsonObject>;
}

const WIKI_PATH_ARGUMENT = {
  name: "path",
  description: "Wiki page path inside the agent namespace.",
  required: true,
  kind: "positional" as const,
  valueType: "string" as const,
  valueName: "path",
};

const WIKI_LOCALE_ARGUMENT = {
  name: "locale",
  description: "Optional Wiki.js locale.",
  valueType: "string" as const,
  valueName: "locale",
};

const WIKI_CONTENT_ARGUMENT = {
  name: "content",
  description: "Markdown content. Use @file or @- for multiline content.",
  required: true,
  valueType: "string" as const,
  valueName: "text|@file|@-",
  valueSources: ["literal", "file", "stdin"] as const,
};

const WIKI_SECTION_ARGUMENT = {
  name: "section",
  description: "Markdown section heading to update.",
  required: true,
  kind: "positional" as const,
  valueType: "string" as const,
  valueName: "section",
};

const WIKI_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object for this command.",
  valueType: "json" as const,
};

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

function readOptionalWikiReadFormat(value: unknown): WikiReadFormat | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "json" || value === "markdown") {
    return value;
  }

  throw new Error("wiki.read format must be json or markdown.");
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function readOptionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return value;
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

function readOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }

  return value.map((entry, index) => readRequiredString(entry, `${label}[${index}]`));
}

function requireInputObject(input: unknown, label: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(`${label} input must be a JSON object.`);
  }

  return input;
}

function requireCommandJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} result must be a JSON object.`);
  }

  return value;
}

function formatWikiReadOutput(output: JsonObject, input: WikiReadCommandInput): JsonObject {
  if (input.format !== "markdown") {
    return output;
  }

  if (output.found === false) {
    const path = readOptionalString(output.path, "wiki.read output path") ?? input.path;
    const locale = readOptionalString(output.locale, "wiki.read output locale") ?? input.locale;

    return {
      operation: "read",
      format: "markdown",
      found: false,
      path,
      ...(locale ? {locale} : {}),
    };
  }

  const path = readOptionalString(output.path, "wiki.read output path") ?? input.path;
  const locale = readOptionalString(output.locale, "wiki.read output locale") ?? input.locale;
  const title = readOptionalString(output.title, "wiki.read output title");
  const updatedAt = readOptionalString(output.updatedAt, "wiki.read output updatedAt");

  return {
    operation: "read",
    format: "markdown",
    found: true,
    path,
    ...(locale ? {locale} : {}),
    ...(title ? {title} : {}),
    ...(updatedAt ? {updatedAt} : {}),
    content: readRequiredString(output.content, "wiki.read output content"),
  };
}

function parseWikiReadInput(input: unknown): WikiReadCommandInput {
  const object = requireInputObject(input, WIKI_READ_COMMAND_NAME);
  const locale = readOptionalString(object.locale, "wiki.read locale");
  const format = readOptionalWikiReadFormat(object.format);

  return {
    path: readRequiredString(object.path, "wiki.read path"),
    ...(locale ? {locale} : {}),
    ...(format ? {format} : {}),
  };
}

function parseWikiSearchInput(input: unknown): WikiSearchCommandInput {
  const object = requireInputObject(input, WIKI_SEARCH_COMMAND_NAME);
  const path = readOptionalString(object.path, "wiki.search path");
  const locale = readOptionalString(object.locale, "wiki.search locale");
  const limit = readOptionalPositiveInteger(object.limit, "wiki.search limit");

  return {
    query: readRequiredString(object.query, "wiki.search query"),
    ...(path ? {path} : {}),
    ...(locale ? {locale} : {}),
    ...(limit === undefined ? {} : {limit}),
  };
}

function parseWikiListInput(input: unknown): WikiListCommandInput {
  const object = requireInputObject(input, WIKI_LIST_COMMAND_NAME);
  const path = readOptionalString(object.path, "wiki.list path");
  const locale = readOptionalString(object.locale, "wiki.list locale");
  const limit = readOptionalPositiveInteger(object.limit, "wiki.list limit");
  const includeArchived = readOptionalBoolean(object.includeArchived, "wiki.list includeArchived");

  return {
    ...(path ? {path} : {}),
    ...(locale ? {locale} : {}),
    ...(limit === undefined ? {} : {limit}),
    ...(includeArchived === undefined ? {} : {includeArchived}),
  };
}

function parseWikiDiffInput(input: unknown): WikiDiffCommandInput {
  const object = requireInputObject(input, WIKI_DIFF_COMMAND_NAME);
  const locale = readOptionalString(object.locale, "wiki.diff locale");
  const contextLines = readOptionalNonNegativeInteger(object.contextLines, "wiki.diff contextLines");

  return {
    leftPath: readRequiredString(object.leftPath, "wiki.diff leftPath"),
    rightPath: readRequiredString(object.rightPath, "wiki.diff rightPath"),
    ...(locale ? {locale} : {}),
    ...(contextLines === undefined ? {} : {contextLines}),
  };
}

function parseWikiWriteInput(input: unknown): WikiWriteCommandInput {
  const object = requireInputObject(input, WIKI_WRITE_COMMAND_NAME);
  const locale = readOptionalString(object.locale, "wiki.write locale");
  const title = readOptionalString(object.title, "wiki.write title");
  const description = readOptionalString(object.description, "wiki.write description");
  const tags = readOptionalStringArray(object.tags, "wiki.write tags");
  const isPublished = readOptionalBoolean(object.isPublished, "wiki.write isPublished");
  const isPrivate = readOptionalBoolean(object.isPrivate, "wiki.write isPrivate");
  const createIfMissing = readOptionalBoolean(object.createIfMissing, "wiki.write createIfMissing");
  const baseUpdatedAt = readOptionalString(object.baseUpdatedAt, "wiki.write baseUpdatedAt");

  return {
    path: readRequiredString(object.path, "wiki.write path"),
    ...(locale ? {locale} : {}),
    ...(title ? {title} : {}),
    ...(description ? {description} : {}),
    content: readRequiredString(object.content, "wiki.write content"),
    ...(tags ? {tags} : {}),
    ...(isPublished === undefined ? {} : {isPublished}),
    ...(isPrivate === undefined ? {} : {isPrivate}),
    ...(createIfMissing === undefined ? {} : {createIfMissing}),
    ...(baseUpdatedAt ? {baseUpdatedAt} : {}),
  };
}

function parseWikiWriteSectionInput(input: unknown): WikiWriteSectionCommandInput {
  const object = requireInputObject(input, WIKI_WRITE_SECTION_COMMAND_NAME);
  const locale = readOptionalString(object.locale, "wiki.write.section locale");
  const title = readOptionalString(object.title, "wiki.write.section title");
  const createIfMissing = readOptionalBoolean(object.createIfMissing, "wiki.write.section createIfMissing");
  const baseUpdatedAt = readOptionalString(object.baseUpdatedAt, "wiki.write.section baseUpdatedAt");

  return {
    path: readRequiredString(object.path, "wiki.write.section path"),
    ...(locale ? {locale} : {}),
    section: readRequiredString(object.section, "wiki.write.section section"),
    content: readRequiredString(object.content, "wiki.write.section content"),
    ...(title ? {title} : {}),
    ...(createIfMissing === undefined ? {} : {createIfMissing}),
    ...(baseUpdatedAt ? {baseUpdatedAt} : {}),
  };
}

function parseWikiMoveInput(input: unknown): WikiMoveCommandInput {
  const object = requireInputObject(input, WIKI_MOVE_COMMAND_NAME);
  const locale = readOptionalString(object.locale, "wiki.move locale");
  const rewriteLinks = readOptionalBoolean(object.rewriteLinks, "wiki.move rewriteLinks");
  const baseUpdatedAt = readOptionalString(object.baseUpdatedAt, "wiki.move baseUpdatedAt");

  return {
    path: readRequiredString(object.path, "wiki.move path"),
    ...(locale ? {locale} : {}),
    destinationPath: readRequiredString(object.destinationPath, "wiki.move destinationPath"),
    ...(rewriteLinks === undefined ? {} : {rewriteLinks}),
    ...(baseUpdatedAt ? {baseUpdatedAt} : {}),
  };
}

function parseWikiArchiveInput(input: unknown): WikiArchiveCommandInput {
  const object = requireInputObject(input, WIKI_ARCHIVE_COMMAND_NAME);
  const locale = readOptionalString(object.locale, "wiki.archive locale");
  const baseUpdatedAt = readOptionalString(object.baseUpdatedAt, "wiki.archive baseUpdatedAt");

  return {
    path: readRequiredString(object.path, "wiki.archive path"),
    ...(locale ? {locale} : {}),
    ...(baseUpdatedAt ? {baseUpdatedAt} : {}),
  };
}

function parseWikiRestoreInput(input: unknown): WikiRestoreCommandInput {
  const object = requireInputObject(input, WIKI_RESTORE_COMMAND_NAME);
  const locale = readOptionalString(object.locale, "wiki.restore locale");
  const baseUpdatedAt = readOptionalString(object.baseUpdatedAt, "wiki.restore baseUpdatedAt");

  return {
    path: readRequiredString(object.path, "wiki.restore path"),
    destinationPath: readRequiredString(object.destinationPath, "wiki.restore destinationPath"),
    ...(locale ? {locale} : {}),
    ...(baseUpdatedAt ? {baseUpdatedAt} : {}),
  };
}

function parseWikiAttachImageInput(input: unknown): WikiAttachImageCommandInput {
  const object = requireInputObject(input, WIKI_ATTACH_IMAGE_COMMAND_NAME);
  const locale = readOptionalString(object.locale, "wiki.attach.image locale");
  const caption = readOptionalString(object.caption, "wiki.attach.image caption");
  const title = readOptionalString(object.title, "wiki.attach.image title");
  const createIfMissing = readOptionalBoolean(object.createIfMissing, "wiki.attach.image createIfMissing");
  const baseUpdatedAt = readOptionalString(object.baseUpdatedAt, "wiki.attach.image baseUpdatedAt");

  return {
    path: readRequiredString(object.path, "wiki.attach.image path"),
    ...(locale ? {locale} : {}),
    section: readRequiredString(object.section, "wiki.attach.image section"),
    slot: readRequiredString(object.slot, "wiki.attach.image slot"),
    sourcePath: readRequiredString(object.sourcePath, "wiki.attach.image sourcePath"),
    alt: readRequiredString(object.alt, "wiki.attach.image alt"),
    ...(caption ? {caption} : {}),
    ...(title ? {title} : {}),
    ...(createIfMissing === undefined ? {} : {createIfMissing}),
    ...(baseUpdatedAt ? {baseUpdatedAt} : {}),
  };
}

function parseWikiFetchAssetInput(input: unknown): WikiFetchAssetCommandInput {
  const object = requireInputObject(input, WIKI_FETCH_ASSET_COMMAND_NAME);

  return {
    assetPath: readRequiredString(object.assetPath, "wiki.fetch.asset assetPath"),
  };
}

function parseWikiDeleteAssetInput(input: unknown): WikiDeleteAssetCommandInput {
  const object = requireInputObject(input, WIKI_DELETE_ASSET_COMMAND_NAME);

  return {
    assetPath: readRequiredString(object.assetPath, "wiki.delete.asset assetPath"),
  };
}

export const wikiReadCommandDescriptor: CommandDescriptor = {
  name: WIKI_READ_COMMAND_NAME,
  summary: "Read one agent-owned wiki page.",
  description: "Reads one Wiki.js page scoped to the current agent namespace.",
  usage: "panda wiki read <path> [--locale <locale>] [--format json|markdown]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    WIKI_PATH_ARGUMENT,
    WIKI_LOCALE_ARGUMENT,
    {
      name: "format",
      description: "Output contract. json returns the full page object; markdown returns a compact content envelope.",
      valueType: "string",
      valueName: "json|markdown",
    },
    {
      name: "json",
      description: "Structured JSON object containing path and optional locale and format.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Read a page",
      command: "panda wiki read agents/panda/profile",
    },
    {
      description: "Read page markdown with compact metadata",
      command: "panda wiki read agents/panda/profile --format markdown",
    },
    {
      description: "Use JSON input",
      command: "panda wiki read --json '{\"path\":\"agents/panda/profile\"}'",
    },
  ],
  requiredCapabilities: ["wiki.read"],
  resultShape: {
    operation: "read",
    found: "boolean",
    path: "string",
    locale: "string",
    content: "string|absent when not found",
  },
};

export const wikiSearchCommandDescriptor: CommandDescriptor = {
  name: WIKI_SEARCH_COMMAND_NAME,
  summary: "Search agent-owned wiki pages.",
  description: "Searches Wiki.js and filters results to the current agent namespace in Panda.",
  usage: "panda wiki search <query> [--path <path>] [--locale <locale>] [--limit <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "query",
      description: "Search query.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "query",
    },
    {
      name: "path",
      description: "Optional subtree path to scope the search.",
      valueType: "string",
      valueName: "path",
    },
    {
      name: "locale",
      description: "Optional Wiki.js locale.",
      valueType: "string",
      valueName: "locale",
    },
    {
      name: "limit",
      description: "Maximum number of scoped results to return.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "json",
      description: "Structured JSON object containing query, optional path scope, locale, and limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Search the current namespace",
      command: "panda wiki search profile",
    },
    {
      description: "Search one subtree",
      command: "panda wiki search profile --path agents/panda/notes --limit 10",
    },
    {
      description: "Use JSON input",
      command: "panda wiki search --json '{\"query\":\"profile\"}'",
    },
  ],
  requiredCapabilities: ["wiki.search"],
  resultShape: {
    operation: "search",
    query: "string",
    path: "string",
    totalHits: "number",
    count: "number",
    truncated: "boolean",
    results: ["object"],
  },
};

export const wikiListCommandDescriptor: CommandDescriptor = {
  name: WIKI_LIST_COMMAND_NAME,
  summary: "List agent-owned wiki pages.",
  description: "Lists Wiki.js pages under a namespace subtree and hides archived pages by default.",
  usage: "panda wiki list [path] [--limit <n>] [--include-archived] [--locale <locale>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "path",
      description: "Optional subtree path to list.",
      kind: "positional",
      valueType: "string",
      valueName: "path",
    },
    {
      name: "limit",
      description: "Optional positive result limit.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "include-archived",
      description: "Include archived pages.",
      valueType: "boolean",
    },
    {
      name: "locale",
      description: "Optional Wiki.js locale.",
      valueType: "string",
      valueName: "locale",
    },
    {
      name: "json",
      description: "Structured JSON object containing optional path, locale, limit, and includeArchived.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List the current namespace",
      command: "panda wiki list",
    },
    {
      description: "List one subtree",
      command: "panda wiki list agents/panda/notes --limit 20",
    },
    {
      description: "Use JSON input",
      command: "panda wiki list --json '{\"path\":\"agents/panda/notes\",\"limit\":20}'",
    },
  ],
  requiredCapabilities: ["wiki.list"],
  resultShape: {
    operation: "list",
    path: "string",
    locale: "string",
    count: "number",
    pages: ["object"],
  },
};

export const wikiDiffCommandDescriptor: CommandDescriptor = {
  name: WIKI_DIFF_COMMAND_NAME,
  summary: "Diff two agent-owned wiki pages.",
  description: "Compares markdown content from two Wiki.js pages scoped to the current agent namespace. Use this before restoring or overwriting archived pages.",
  usage: "panda wiki diff <left-path> <right-path> [--locale <locale>] [--context <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "left-path",
      description: "Left/source wiki page path inside the agent namespace.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "left-path",
    },
    {
      name: "right-path",
      description: "Right/target wiki page path inside the agent namespace.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "right-path",
    },
    {
      name: "context",
      description: "Number of unchanged context lines around each change. Defaults to 3.",
      valueType: "number",
      valueName: "n",
      defaultValue: 3,
    },
    WIKI_LOCALE_ARGUMENT,
    {
      name: "json",
      description: "Structured JSON object containing leftPath, rightPath, optional locale, and optional contextLines.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Compare an archived page to the live page",
      command: "panda wiki diff agents/panda/_archive/2026/06/profile-20260625t120000z agents/panda/profile",
    },
    {
      description: "Show tighter diff context",
      command: "panda wiki diff agents/panda/old agents/panda/new --context 1",
    },
    {
      description: "Use JSON input",
      command: "panda wiki diff --json '{\"leftPath\":\"agents/panda/old\",\"rightPath\":\"agents/panda/new\"}'",
    },
  ],
  requiredCapabilities: ["wiki.diff"],
  resultShape: {
    operation: "diff",
    equal: "boolean",
    left: "object",
    right: "object",
    stats: "object",
    hunks: ["object"],
    truncated: "boolean",
  },
};

export const wikiWriteCommandDescriptor: CommandDescriptor = {
  name: WIKI_WRITE_COMMAND_NAME,
  summary: "Create or replace one agent-owned wiki page.",
  description: "Creates or updates a Wiki.js markdown page inside the current agent namespace.",
  usage: "panda wiki write page <path> --content <text|@file|@-> [--title <text|@file|@->] [--description <text|@file|@->] [--tag <tag>...] [--published|--draft] [--private|--public] [--create|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    WIKI_PATH_ARGUMENT,
    WIKI_CONTENT_ARGUMENT,
    {
      name: "title",
      description: "Page title. Required by Wiki.js when creating a new page.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "description",
      description: "Optional page description.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "tag",
      description: "Repeatable page tag.",
      valueType: "string",
    },
    {
      name: "published",
      description: "Mark the page published.",
      valueType: "boolean",
    },
    {
      name: "draft",
      description: "Mark the page unpublished.",
      valueType: "boolean",
    },
    {
      name: "private",
      description: "Mark the page private.",
      valueType: "boolean",
    },
    {
      name: "public",
      description: "Mark the page public.",
      valueType: "boolean",
    },
    {
      name: "create",
      description: "Allow creating the page when missing.",
      valueType: "boolean",
    },
    {
      name: "no-create",
      description: "Fail when the page is missing.",
      valueType: "boolean",
    },
    {
      name: "base-updated-at",
      description: "Expected updatedAt value for optimistic concurrency.",
      valueType: "string",
      valueName: "timestamp",
    },
    WIKI_LOCALE_ARGUMENT,
    WIKI_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Write a page from a markdown file",
      command: "panda wiki write page agents/panda/profile --title Profile --content @profile.md",
    },
    {
      description: "Use JSON input",
      command: "panda wiki write page --json '{\"path\":\"agents/panda/profile\",\"title\":\"Profile\",\"content\":\"# Profile\"}'",
    },
  ],
  requiredCapabilities: ["wiki.write"],
  resultShape: {
    operation: "write",
    action: "created|updated",
    page: {
      id: "number",
      path: "string",
      locale: "string",
      title: "string",
      updatedAt: "string",
    },
  },
};

export const wikiWriteSectionCommandDescriptor: CommandDescriptor = {
  name: WIKI_WRITE_SECTION_COMMAND_NAME,
  summary: "Create or replace one markdown section in a wiki page.",
  description: "Updates a ## section inside an agent-owned Wiki.js page, creating the page when allowed.",
  usage: "panda wiki write section <path> <section> --content <text|@file|@-> [--title <text|@file|@->] [--create|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    WIKI_PATH_ARGUMENT,
    {
      name: "section",
      description: "Markdown section heading to create or replace.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "section",
    },
    WIKI_CONTENT_ARGUMENT,
    {
      name: "title",
      description: "Page title. Required when creating a missing page.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "create",
      description: "Allow creating the page when missing.",
      valueType: "boolean",
    },
    {
      name: "no-create",
      description: "Fail when the page is missing.",
      valueType: "boolean",
    },
    {
      name: "base-updated-at",
      description: "Expected updatedAt value for optimistic concurrency.",
      valueType: "string",
      valueName: "timestamp",
    },
    WIKI_LOCALE_ARGUMENT,
    WIKI_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Write one section from stdin",
      command: "cat facts.md | panda wiki write section agents/panda/profile Facts --content @-",
    },
    {
      description: "Use JSON input",
      command: "panda wiki write section --json '{\"path\":\"agents/panda/profile\",\"section\":\"Facts\",\"content\":\"- useful\"}'",
    },
  ],
  requiredCapabilities: ["wiki.write.section"],
  resultShape: {
    operation: "write_section",
    action: "created|updated",
    section: {
      title: "string",
      action: "created|replaced|appended",
    },
    page: {
      id: "number",
      path: "string",
      locale: "string",
      title: "string",
      updatedAt: "string",
    },
  },
};

export const wikiMoveCommandDescriptor: CommandDescriptor = {
  name: WIKI_MOVE_COMMAND_NAME,
  summary: "Move one live wiki page inside the agent namespace.",
  description: "Moves a Wiki.js page and can rewrite affected internal links.",
  usage: "panda wiki move <path> <destination-path> [--rewrite-links] [--locale <locale>] [--base-updated-at <timestamp>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    WIKI_PATH_ARGUMENT,
    {
      name: "destination-path",
      description: "Destination wiki page path inside the agent namespace.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "destination-path",
    },
    {
      name: "rewrite-links",
      description: "Rewrite affected internal wiki links.",
      valueType: "boolean",
    },
    {
      name: "base-updated-at",
      description: "Expected updatedAt value for optimistic concurrency.",
      valueType: "string",
      valueName: "timestamp",
    },
    WIKI_LOCALE_ARGUMENT,
    WIKI_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Move a page",
      command: "panda wiki move agents/panda/old agents/panda/new --rewrite-links",
    },
    {
      description: "Use JSON input",
      command: "panda wiki move --json '{\"path\":\"agents/panda/old\",\"destinationPath\":\"agents/panda/new\"}'",
    },
  ],
  requiredCapabilities: ["wiki.move"],
  resultShape: {
    operation: "move",
    movedFrom: "string",
    movedTo: "string",
    rewriteLinks: "boolean",
    linkRewrite: "object",
    page: {
      id: "number",
      path: "string",
      locale: "string",
      title: "string",
      updatedAt: "string",
    },
  },
};

export const wikiArchiveCommandDescriptor: CommandDescriptor = {
  name: WIKI_ARCHIVE_COMMAND_NAME,
  summary: "Archive one wiki page.",
  description: "Moves a live Wiki.js page into the agent namespace _archive tree.",
  usage: "panda wiki archive <path> [--locale <locale>] [--base-updated-at <timestamp>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    WIKI_PATH_ARGUMENT,
    {
      name: "base-updated-at",
      description: "Expected updatedAt value for optimistic concurrency.",
      valueType: "string",
      valueName: "timestamp",
    },
    WIKI_LOCALE_ARGUMENT,
    WIKI_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Archive a page",
      command: "panda wiki archive agents/panda/old-note",
    },
    {
      description: "Use JSON input",
      command: "panda wiki archive --json '{\"path\":\"agents/panda/old-note\"}'",
    },
  ],
  requiredCapabilities: ["wiki.archive"],
  resultShape: {
    operation: "archive",
    archivedFrom: "string",
    archivedTo: "string",
    page: {
      id: "number",
      path: "string",
      locale: "string",
      title: "string",
      updatedAt: "string",
    },
  },
};

export const wikiRestoreCommandDescriptor: CommandDescriptor = {
  name: WIKI_RESTORE_COMMAND_NAME,
  summary: "Restore one archived wiki page.",
  description: "Moves one archived Wiki.js page back to a live path inside the current agent namespace.",
  usage: "panda wiki restore <archived-path> <destination-path> [--locale <locale>] [--base-updated-at <timestamp>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "archived-path",
      description: "Archived wiki page path under the agent _archive tree.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "archived-path",
    },
    {
      name: "destination-path",
      description: "Live destination wiki page path inside the agent namespace.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "destination-path",
    },
    {
      name: "base-updated-at",
      description: "Expected archived page updatedAt value for optimistic concurrency.",
      valueType: "string",
      valueName: "timestamp",
    },
    WIKI_LOCALE_ARGUMENT,
    WIKI_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Restore an archived page to a live path",
      command: "panda wiki restore agents/panda/_archive/2026/06/profile-20260625t120000z agents/panda/profile",
    },
    {
      description: "Use JSON input",
      command: "panda wiki restore --json '{\"path\":\"agents/panda/_archive/2026/06/profile-20260625t120000z\",\"destinationPath\":\"agents/panda/profile\"}'",
    },
  ],
  requiredCapabilities: ["wiki.restore"],
  resultShape: {
    operation: "restore",
    restoredFrom: "string",
    restoredTo: "string",
    page: {
      id: "number",
      path: "string",
      locale: "string",
      title: "string",
      updatedAt: "string",
    },
  },
};

export const wikiAttachImageCommandDescriptor: CommandDescriptor = {
  name: WIKI_ATTACH_IMAGE_COMMAND_NAME,
  summary: "Attach one image to a wiki page section.",
  description: "Uploads a local image to the page-scoped Wiki.js asset folder and inserts or replaces one managed markdown image slot.",
  usage: "panda wiki attach image <path> <section> --slot <slot> --source <image-path> --alt <text|@file|@-> [--caption <text|@file|@->] [--title <text|@file|@->] [--create|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    WIKI_PATH_ARGUMENT,
    WIKI_SECTION_ARGUMENT,
    {
      name: "slot",
      description: "Stable managed image slot in the section.",
      required: true,
      valueType: "string",
      valueName: "slot",
    },
    {
      name: "source",
      description: "Local image path to upload.",
      required: true,
      valueType: "string",
      valueName: "image-path",
    },
    {
      name: "alt",
      description: "Image alt text. Use @file or @- for multiline text.",
      required: true,
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "caption",
      description: "Optional image caption. Use @file or @- for multiline text.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "title",
      description: "Page title. Required when creating a missing page.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "create",
      description: "Allow creating the page when missing.",
      valueType: "boolean",
    },
    {
      name: "no-create",
      description: "Fail when the page is missing.",
      valueType: "boolean",
    },
    {
      name: "base-updated-at",
      description: "Expected updatedAt value for optimistic concurrency.",
      valueType: "string",
      valueName: "timestamp",
    },
    WIKI_LOCALE_ARGUMENT,
    {
      name: "json",
      description: "Structured JSON object containing path, section, slot, sourcePath, alt, and optional caption/title/concurrency fields.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Attach a local image",
      command: "panda wiki attach image agents/panda/profile Facts --slot profile-photo --source ./profile.png --alt 'Profile photo'",
    },
    {
      description: "Use JSON input",
      command: "panda wiki attach image --json '{\"path\":\"agents/panda/profile\",\"section\":\"Facts\",\"slot\":\"profile-photo\",\"sourcePath\":\"./profile.png\",\"alt\":\"Profile photo\"}'",
    },
  ],
  requiredCapabilities: ["wiki.attach.image"],
  resultShape: {
    operation: "attach_image",
    action: "created|updated|unchanged",
    upload: "uploaded",
    assetPath: "string",
    slot: "string",
    page: {
      id: "number",
      path: "string",
      locale: "string",
      title: "string",
      updatedAt: "string",
    },
  },
};

export const wikiFetchAssetCommandDescriptor: CommandDescriptor = {
  name: WIKI_FETCH_ASSET_COMMAND_NAME,
  summary: "Fetch one viewable wiki asset into Panda media storage.",
  description: "Downloads a namespace-scoped Wiki.js image or PDF asset and returns a local artifact path suitable for view_media.",
  usage: "panda wiki fetch asset <asset-path>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "asset-path",
      description: "Namespace-scoped Wiki.js image or PDF asset path.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "asset-path",
    },
    WIKI_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Fetch a stored image asset",
      command: "panda wiki fetch asset agents/panda/_assets/profile/photo.png",
    },
    {
      description: "Use JSON input",
      command: "panda wiki fetch asset --json '{\"assetPath\":\"agents/panda/_assets/profile/photo.png\"}'",
    },
  ],
  requiredCapabilities: ["wiki.fetch.asset"],
  resultShape: {
    operation: "fetch_asset",
    assetPath: "string",
    localPath: "string",
    mimeType: "string",
    sizeBytes: "number",
    artifact: {
      kind: "image|pdf",
      source: "view_media",
      path: "string",
      mimeType: "string",
    },
  },
};

export const wikiDeleteAssetCommandDescriptor: CommandDescriptor = {
  name: WIKI_DELETE_ASSET_COMMAND_NAME,
  summary: "Delete one wiki asset.",
  description: "Deletes one namespace-scoped Wiki.js asset by path. This does not rewrite pages that reference the asset.",
  usage: "panda wiki delete asset <asset-path> --yes",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "asset-path",
      description: "Namespace-scoped Wiki.js asset path under the agent _assets tree.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "asset-path",
    },
    {
      name: "yes",
      description: "Confirm deletion in native CLI mode.",
      valueType: "boolean",
    },
    WIKI_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Delete a stored image asset",
      command: "panda wiki delete asset agents/panda/_assets/profile/photo.png --yes",
    },
    {
      description: "Use JSON input",
      command: "panda wiki delete asset --json '{\"assetPath\":\"agents/panda/_assets/profile/photo.png\"}'",
    },
  ],
  requiredCapabilities: ["wiki.delete.asset"],
  resultShape: {
    operation: "delete_asset",
    assetPath: "string",
    assetId: "number",
    filename: "string",
    deleted: true,
  },
};

export function createWikiReadCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiReadCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiReadInput(request.input);
      const output = requireCommandJsonObject(
        await service.readPage(request.scope.agentKey, input),
        WIKI_READ_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_READ_COMMAND_NAME,
        output: formatWikiReadOutput(output, input),
        summary: `Read wiki page ${input.path}.`,
      };
    },
  };
}

export function createWikiSearchCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiSearchInput(request.input);
      const output = requireCommandJsonObject(
        await service.searchPages(request.scope.agentKey, input),
        WIKI_SEARCH_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_SEARCH_COMMAND_NAME,
        output,
        summary: `Searched wiki for ${input.query}.`,
      };
    },
  };
}

export function createWikiListCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiListInput(request.input);
      const output = requireCommandJsonObject(
        await service.listPages(request.scope.agentKey, input),
        WIKI_LIST_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_LIST_COMMAND_NAME,
        output,
        summary: "Listed wiki pages.",
      };
    },
  };
}

export function createWikiDiffCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiDiffCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiDiffInput(request.input);
      const output = requireCommandJsonObject(
        await service.diffPages(request.scope.agentKey, input),
        WIKI_DIFF_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_DIFF_COMMAND_NAME,
        output,
        summary: `Diffed wiki pages ${input.leftPath} and ${input.rightPath}.`,
      };
    },
  };
}

export function createWikiWriteCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiWriteCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiWriteInput(request.input);
      const output = requireCommandJsonObject(
        await service.writePage(request.scope.agentKey, input),
        WIKI_WRITE_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_WRITE_COMMAND_NAME,
        output,
        summary: `Wrote wiki page ${input.path}.`,
      };
    },
  };
}

export function createWikiWriteSectionCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiWriteSectionCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiWriteSectionInput(request.input);
      const output = requireCommandJsonObject(
        await service.writeSection(request.scope.agentKey, input),
        WIKI_WRITE_SECTION_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_WRITE_SECTION_COMMAND_NAME,
        output,
        summary: `Wrote wiki section ${input.section} in ${input.path}.`,
      };
    },
  };
}

export function createWikiMoveCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiMoveCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiMoveInput(request.input);
      const output = requireCommandJsonObject(
        await service.movePage(request.scope.agentKey, input),
        WIKI_MOVE_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_MOVE_COMMAND_NAME,
        output,
        summary: `Moved wiki page ${input.path} to ${input.destinationPath}.`,
      };
    },
  };
}

export function createWikiArchiveCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiArchiveCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiArchiveInput(request.input);
      const output = requireCommandJsonObject(
        await service.archivePage(request.scope.agentKey, input),
        WIKI_ARCHIVE_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_ARCHIVE_COMMAND_NAME,
        output,
        summary: `Archived wiki page ${input.path}.`,
      };
    },
  };
}

export function createWikiRestoreCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiRestoreCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiRestoreInput(request.input);
      const output = requireCommandJsonObject(
        await service.restorePage(request.scope.agentKey, input),
        WIKI_RESTORE_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_RESTORE_COMMAND_NAME,
        output,
        summary: `Restored wiki page ${input.path} to ${input.destinationPath}.`,
      };
    },
  };
}

export function createWikiAttachImageCommand(
  service: WikiCommandService,
  fileResolver: CommandFileResolver,
): RegisteredCommand {
  return {
    descriptor: wikiAttachImageCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiAttachImageInput(request.input);
      const resolved = await fileResolver.resolveReadablePath({
        request,
        file: {
          path: input.sourcePath,
        },
      });
      const output = requireCommandJsonObject(
        await service.attachImage(request.scope.agentKey, {
          ...input,
          resolvedSourcePath: resolved.path,
        }),
        WIKI_ATTACH_IMAGE_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_ATTACH_IMAGE_COMMAND_NAME,
        output,
        summary: `Attached wiki image ${input.slot} to ${input.path}.`,
      };
    },
  };
}

export function createWikiFetchAssetCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiFetchAssetCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiFetchAssetInput(request.input);
      const result = await service.fetchAsset(request.scope.agentKey, input);
      const output = requireCommandJsonObject(result.output, WIKI_FETCH_ASSET_COMMAND_NAME);

      return {
        ok: true,
        command: WIKI_FETCH_ASSET_COMMAND_NAME,
        output,
        artifact: result.artifact,
        summary: `Fetched wiki asset ${input.assetPath}.`,
      };
    },
  };
}

export function createWikiDeleteAssetCommand(service: WikiCommandService): RegisteredCommand {
  return {
    descriptor: wikiDeleteAssetCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseWikiDeleteAssetInput(request.input);
      const output = requireCommandJsonObject(
        await service.deleteAsset(request.scope.agentKey, input),
        WIKI_DELETE_ASSET_COMMAND_NAME,
      );

      return {
        ok: true,
        command: WIKI_DELETE_ASSET_COMMAND_NAME,
        output,
        summary: `Deleted wiki asset ${input.assetPath}.`,
      };
    },
  };
}
