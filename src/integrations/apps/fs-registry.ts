import path from "node:path";
import {access, readdir, readFile} from "node:fs/promises";

import {z} from "zod";

import {resolveAgentDir} from "../../app/runtime/data-dir.js";
import {normalizeAgentKey} from "../../domain/agents/types.js";
import {
  type AgentAppActionDefinition,
  type AgentAppActionInputSchema,
  type AgentAppCheckResult,
  type AgentAppDiagnosticIssue,
  type AgentAppDefinition,
  type AgentAppInputField,
  type AgentAppInspectionResult,
  type AgentAppManifest,
  type AgentAppViewDefinition,
  normalizeAgentAppEntryKey,
  normalizeAgentAppParamKey,
  normalizeAgentAppSlug,
} from "../../domain/apps/types.js";

const manifestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  identityScoped: z.boolean().optional(),
  publicDir: z.string().trim().min(1).optional(),
  entryHtml: z.string().trim().min(1).optional(),
  viewsPath: z.string().trim().min(1).optional(),
  actionsPath: z.string().trim().min(1).optional(),
  dbPath: z.string().trim().min(1).optional(),
}).passthrough() satisfies z.ZodType<AgentAppManifest>;

const paginationSchema = z.object({
  mode: z.literal("offset"),
  defaultPageSize: z.number().int().positive().optional(),
  maxPageSize: z.number().int().positive().optional(),
}).superRefine((value, ctx) => {
  if (
    value.defaultPageSize !== undefined
    && value.maxPageSize !== undefined
    && value.defaultPageSize > value.maxPageSize
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "pagination.defaultPageSize must be <= pagination.maxPageSize.",
    });
  }
});

const viewDefinitionSchema = z.object({
  description: z.string().trim().min(1).optional(),
  sql: z.string().trim().min(1),
  pagination: paginationSchema.optional(),
}).passthrough() satisfies z.ZodType<AgentAppViewDefinition>;

const viewsSchema = z.record(
  z.string().transform((value) => normalizeAgentAppEntryKey(value, "View name")),
  viewDefinitionSchema,
);

const stringInputFieldSchema = z.object({
  type: z.literal("string"),
  description: z.string().trim().min(1).optional(),
  enum: z.array(z.string()).min(1).optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
}).superRefine((value, ctx) => {
  if (
    value.minLength !== undefined
    && value.maxLength !== undefined
    && value.minLength > value.maxLength
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "string input field minLength must be <= maxLength.",
    });
  }
}) satisfies z.ZodType<AgentAppInputField>;

const integerInputFieldSchema = z.object({
  type: z.literal("integer"),
  description: z.string().trim().min(1).optional(),
  enum: z.array(z.number().int()).min(1).optional(),
  minimum: z.number().int().optional(),
  maximum: z.number().int().optional(),
}).superRefine((value, ctx) => {
  if (
    value.minimum !== undefined
    && value.maximum !== undefined
    && value.minimum > value.maximum
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "integer input field minimum must be <= maximum.",
    });
  }
}) satisfies z.ZodType<AgentAppInputField>;

const numberInputFieldSchema = z.object({
  type: z.literal("number"),
  description: z.string().trim().min(1).optional(),
  enum: z.array(z.number()).min(1).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
}).superRefine((value, ctx) => {
  if (
    value.minimum !== undefined
    && value.maximum !== undefined
    && value.minimum > value.maximum
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "number input field minimum must be <= maximum.",
    });
  }
}) satisfies z.ZodType<AgentAppInputField>;

const booleanInputFieldSchema = z.object({
  type: z.literal("boolean"),
  description: z.string().trim().min(1).optional(),
}) satisfies z.ZodType<AgentAppInputField>;

const scalarInputFieldSchema = z.union([
  stringInputFieldSchema,
  integerInputFieldSchema,
  numberInputFieldSchema,
  booleanInputFieldSchema,
]);

const arrayInputFieldSchema = z.object({
  type: z.literal("array"),
  description: z.string().trim().min(1).optional(),
  items: scalarInputFieldSchema,
  minItems: z.number().int().min(0).optional(),
  maxItems: z.number().int().min(0).optional(),
}).superRefine((value, ctx) => {
  if (
    value.minItems !== undefined
    && value.maxItems !== undefined
    && value.minItems > value.maxItems
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "array input field minItems must be <= maxItems.",
    });
  }
}) satisfies z.ZodType<AgentAppInputField>;

const inputFieldSchema = z.union([
  scalarInputFieldSchema,
  arrayInputFieldSchema,
]);

const actionInputSchema = z.object({
  type: z.literal("object"),
  description: z.string().trim().min(1).optional(),
  properties: z.record(
    z.string().transform((value) => normalizeAgentAppParamKey(value, "Input field name")),
    inputFieldSchema,
  ).optional(),
  required: z.array(
    z.string().transform((value) => normalizeAgentAppParamKey(value, "Required input key")),
  ).min(1).optional(),
  additionalProperties: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (!value.required?.length || !value.properties) {
    return;
  }

  const propertyNames = new Set(Object.keys(value.properties));
  for (const requiredKey of value.required) {
    if (propertyNames.has(requiredKey)) {
      continue;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `inputSchema.required key ${requiredKey} must exist in inputSchema.properties.`,
    });
  }
}) satisfies z.ZodType<AgentAppActionInputSchema>;

const actionDefinitionSchema = z.object({
  description: z.string().trim().min(1).optional(),
  mode: z.enum(["native", "wake", "native+wake"]).optional(),
  sql: z.union([
    z.string().trim().min(1),
    z.array(z.string().trim().min(1)).min(1),
  ]),
  requiredInputKeys: z.array(
    z.string().transform((value) => normalizeAgentAppParamKey(value, "Required input key")),
  ).min(1).optional(),
  inputSchema: actionInputSchema.optional(),
  wakeMessage: z.string().trim().min(1).optional(),
}).passthrough() satisfies z.ZodType<AgentAppActionDefinition>;

const actionsSchema = z.record(
  z.string().transform((value) => normalizeAgentAppEntryKey(value, "Action name")),
  actionDefinitionSchema,
);

export class AgentAppDefinitionError extends Error {
  readonly issues: readonly AgentAppDiagnosticIssue[];

  constructor(message: string, issues: readonly AgentAppDiagnosticIssue[]) {
    super(message);
    this.name = "AgentAppDefinitionError";
    this.issues = issues;
  }
}

function ensureContainedPath(baseDir: string, relativePath: string, label: string): string {
  const resolved = path.resolve(baseDir, relativePath);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${baseDir}.`);
  }

  return resolved;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<TSchema extends z.ZodTypeAny>(
  filePath: string,
  schema: TSchema,
  label: string,
): Promise<z.output<TSchema>> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentAppDefinitionError(`${label} at ${filePath} must be valid JSON.`, [{
      file: filePath,
      message: `Must be valid JSON: ${message}`,
    }]);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = dedupeDiagnosticIssues(flattenZodIssues(result.error.issues).map((issue) => ({
      file: filePath,
      ...(issue.path ? {path: issue.path} : {}),
      message: issue.message,
    })));
    throw new AgentAppDefinitionError(
      `${label} at ${filePath} is invalid.`,
      issues,
    );
  }

  return result.data;
}

function renderIssuePath(path: readonly (string | number)[]): string | undefined {
  if (!path.length) {
    return undefined;
  }

  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      rendered += `[${segment}]`;
      continue;
    }

    rendered = rendered ? `${rendered}.${segment}` : segment;
  }

  return rendered || undefined;
}

function normalizeIssuePath(path: readonly PropertyKey[]): (string | number)[] {
  return path.filter((segment): segment is string | number =>
    typeof segment === "string" || typeof segment === "number",
  );
}

function tryFormatFriendlyUnionIssue(
  issue: z.ZodIssue,
  issuePath: readonly (string | number)[],
): AgentAppDiagnosticIssue | null {
  if (issue.code !== "invalid_union" || !("errors" in issue) || !Array.isArray(issue.errors)) {
    return null;
  }

  const nested = flattenZodIssues(issue.errors.flat(), issuePath);
  const expectedTypes = nested.flatMap((entry) => {
    const match = entry.message.match(/^Invalid input: expected "([^"]+)"$/);
    return match?.[1] ? [match[1]] : [];
  });
  const expectedTypeSet = new Set(expectedTypes);
  if (!expectedTypeSet.size) {
    return null;
  }

  const supportedTypes = ["string", "integer", "number", "boolean", "array"];
  if (!Array.from(expectedTypeSet).every((type) => supportedTypes.includes(type))) {
    return null;
  }

  return {
    file: "",
    ...(renderIssuePath(issuePath) ? {path: renderIssuePath(issuePath)} : {}),
    message: "Use exactly one field type here. Supported types are string, integer, number, boolean, or array. Union types like [\"string\", \"null\"] are not supported; omit optional fields instead of sending null.",
  };
}

function flattenZodIssues(
  issues: readonly z.ZodIssue[],
  inheritedPath: readonly (string | number)[] = [],
): AgentAppDiagnosticIssue[] {
  const flattened: AgentAppDiagnosticIssue[] = [];
  for (const issue of issues) {
    const issuePath = [
      ...inheritedPath,
      ...normalizeIssuePath(issue.path),
    ];
    const friendlyUnionIssue = tryFormatFriendlyUnionIssue(issue, issuePath);
    if (friendlyUnionIssue) {
      flattened.push(friendlyUnionIssue);
      continue;
    }

    if (issue.code === "invalid_union" && "errors" in issue && Array.isArray(issue.errors)) {
      flattened.push(...flattenZodIssues(issue.errors.flat(), issuePath));
      continue;
    }

    flattened.push({
      file: "",
      ...(renderIssuePath(issuePath) ? {path: renderIssuePath(issuePath)} : {}),
      message: issue.message,
    });
  }

  return flattened;
}

function dedupeDiagnosticIssues(issues: readonly AgentAppDiagnosticIssue[]): AgentAppDiagnosticIssue[] {
  const seen = new Set<string>();
  const deduped: AgentAppDiagnosticIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.file}\u0000${issue.path ?? ""}\u0000${issue.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(issue);
  }

  return deduped;
}

function buildAppCheckResult(
  appSlug: string,
  appDir: string,
  issues: readonly AgentAppDiagnosticIssue[],
): AgentAppCheckResult {
  return {
    appSlug,
    appDir,
    ok: issues.length === 0,
    errors: issues,
    warnings: [],
  };
}

function readDiagnosticAppSlug(rawAppSlug: string): string {
  try {
    return normalizeAgentAppSlug(rawAppSlug);
  } catch {
    return rawAppSlug.trim() || rawAppSlug;
  }
}

export interface FileSystemAgentAppRegistryOptions {
  env?: NodeJS.ProcessEnv;
}

export class FileSystemAgentAppRegistry {
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: FileSystemAgentAppRegistryOptions = {}) {
    this.env = options.env ?? process.env;
  }

  resolveAppsDir(agentKey: string): string {
    return path.join(resolveAgentDir(normalizeAgentKey(agentKey), this.env), "apps");
  }

  async listApps(agentKey: string): Promise<readonly AgentAppDefinition[]> {
    return (await this.inspectApps(agentKey)).apps;
  }

  async inspectApps(agentKey: string): Promise<AgentAppInspectionResult> {
    const normalizedAgentKey = normalizeAgentKey(agentKey);
    const appsDir = this.resolveAppsDir(normalizedAgentKey);
    if (!await pathExists(appsDir)) {
      return {
        apps: [],
        brokenApps: [],
      };
    }

    const entries = await readdir(appsDir, {withFileTypes: true});
    const apps: AgentAppDefinition[] = [];
    const brokenApps: AgentAppCheckResult[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        apps.push(await this.loadApp(normalizedAgentKey, entry.name));
      } catch (error) {
        brokenApps.push(buildAppCheckResult(
          readDiagnosticAppSlug(entry.name),
          path.join(appsDir, entry.name),
          error instanceof AgentAppDefinitionError
            ? error.issues
            : [{
              file: path.join(appsDir, entry.name),
              message: error instanceof Error ? error.message : String(error),
            }],
        ));
      }
    }

    apps.sort((left, right) => left.slug.localeCompare(right.slug));
    brokenApps.sort((left, right) => left.appSlug.localeCompare(right.appSlug));
    return {
      apps,
      brokenApps,
    };
  }

  async getApp(agentKey: string, appSlug: string): Promise<AgentAppDefinition> {
    return this.loadApp(normalizeAgentKey(agentKey), normalizeAgentAppSlug(appSlug));
  }

  private async loadApp(agentKey: string, rawAppSlug: string): Promise<AgentAppDefinition> {
    const appSlug = normalizeAgentAppSlug(rawAppSlug);
    const appDir = path.join(this.resolveAppsDir(agentKey), appSlug);
    const manifestPath = path.join(appDir, "manifest.json");
    if (!await pathExists(manifestPath)) {
      throw new AgentAppDefinitionError(
        `App ${appSlug} for ${agentKey} is missing manifest.json.`,
        [{
          file: manifestPath,
          message: "manifest.json is missing.",
        }],
      );
    }

    const manifest = await readJsonFile(manifestPath, manifestSchema, "App manifest");
    const entryHtmlRelative = manifest.entryHtml ?? path.join(manifest.publicDir ?? "public", "index.html");
    const publicDirRelative = manifest.publicDir ?? path.dirname(entryHtmlRelative);
    const viewsPath = ensureContainedPath(appDir, manifest.viewsPath ?? "views.json", "viewsPath");
    const actionsPath = ensureContainedPath(appDir, manifest.actionsPath ?? "actions.json", "actionsPath");
    const entryHtmlPath = ensureContainedPath(appDir, entryHtmlRelative, "entryHtml");
    const publicDir = ensureContainedPath(appDir, publicDirRelative, "publicDir");
    const dbPath = ensureContainedPath(appDir, manifest.dbPath ?? "data/app.sqlite", "dbPath");

    const views = await pathExists(viewsPath)
      ? await readJsonFile(viewsPath, viewsSchema, "App views")
      : {};
    const actions = await pathExists(actionsPath)
      ? await readJsonFile(actionsPath, actionsSchema, "App actions")
      : {};

    return {
      agentKey,
      slug: appSlug,
      name: manifest.name.trim(),
      ...(manifest.description ? {description: manifest.description.trim()} : {}),
      identityScoped: manifest.identityScoped ?? false,
      appDir,
      manifestPath,
      viewsPath,
      actionsPath,
      publicDir,
      entryHtmlPath,
      hasUi: await pathExists(entryHtmlPath),
      dbPath,
      views,
      actions,
    };
  }
}
