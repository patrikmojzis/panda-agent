import path from "node:path";
import {access, mkdir, rm, writeFile} from "node:fs/promises";
import {DatabaseSync, type StatementSync} from "node:sqlite";

import type {
    AgentAppActionDefinition,
    AgentAppActionInputSchema,
    AgentAppActionMode,
    AgentAppActionResult,
    AgentAppCheckResult,
    AgentAppDefinition,
    AgentAppDiagnosticIssue,
    AgentAppInputField,
    AgentAppInspectionResult,
    AgentAppScalarInputField,
    AgentAppViewResult,
} from "../../domain/apps/types.js";
import {normalizeAgentAppSlug, readAgentAppRequiredInputKeys} from "../../domain/apps/types.js";
import {
    AgentAppDefinitionError,
    FileSystemAgentAppRegistry,
    type FileSystemAgentAppRegistryOptions,
} from "./fs-registry.js";

const RESERVED_PARAM_KEYS = new Set([
  "agentKey",
  "appSlug",
  "identityId",
  "sessionId",
  "now",
]);

type SqlBoundValue = string | number | bigint | Uint8Array | null;

function toSqlBoundValue(value: unknown): SqlBoundValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value;
  }

  return JSON.stringify(value);
}

function normalizeSqlValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeSqlValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, normalizeSqlValue(entryValue)]),
    );
  }

  return value;
}

function normalizeRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => normalizeSqlValue(row) as Record<string, unknown>);
}

function getPathValue(
  value: unknown,
  path: readonly string[],
): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function formatWakeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatWakeValue(item)).filter(Boolean).join(", ");
  }

  if (typeof value === "object") {
    return JSON.stringify(normalizeSqlValue(value));
  }

  return String(normalizeSqlValue(value));
}

function formatWakeInputLines(input: Record<string, unknown> | undefined): string[] {
  if (!input) {
    return [];
  }

  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null && formatWakeValue(value).trim())
    .map(([key, value]) => `- ${key}: ${formatWakeValue(value)}`);
}

function renderWakeTemplate(
  template: string,
  context: Record<string, unknown>,
): string {
  return template.replaceAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, rawPath: string) => {
    const resolved = getPathValue(context, rawPath.split("."));
    return formatWakeValue(resolved);
  }).trim();
}

function buildBoundParams(input: {
  params?: Record<string, unknown>;
  identityId?: string;
  sessionId?: string;
  app: AgentAppDefinition;
}): Record<string, SqlBoundValue> {
  const params = input.params ? {...input.params} : {};
  for (const key of Object.keys(params)) {
    if (RESERVED_PARAM_KEYS.has(key)) {
      throw new Error(`App params must not override reserved key ${key}.`);
    }
  }

  return Object.fromEntries([
    ...Object.entries(params).map(([key, value]) => [key, toSqlBoundValue(value)]),
    ["agentKey", input.app.agentKey],
    ["appSlug", input.app.slug],
    ["identityId", input.identityId ?? null],
    ["sessionId", input.sessionId ?? null],
    ["now", new Date().toISOString()],
  ]);
}

function readActionStatements(definition: AgentAppActionDefinition): readonly string[] {
  const {sql} = definition;
  return typeof sql === "string" ? [sql] : Array.from(sql);
}

function validateRequiredInputKeys(
  definition: AgentAppActionDefinition,
  input: Record<string, unknown> | undefined,
  app: AgentAppDefinition,
  actionName: string,
): void {
  const requiredInputKeys = readAgentAppRequiredInputKeys(definition);
  if (!requiredInputKeys?.length) {
    return;
  }

  const missing = requiredInputKeys.filter((key) => {
    const value = input?.[key];
    return value === undefined || value === null;
  });
  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `App action ${actionName} in ${app.slug} requires input keys: ${missing.join(", ")}.`,
  );
}

function validateScalarInputField(
  field: AgentAppScalarInputField,
  value: unknown,
  path: string,
): void {
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") {
        throw new Error(`${path} must be a string.`);
      }
      if (field.minLength !== undefined && value.length < field.minLength) {
        throw new Error(`${path} must be at least ${field.minLength} characters.`);
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        throw new Error(`${path} must be at most ${field.maxLength} characters.`);
      }
      if (field.enum?.length && !field.enum.includes(value)) {
        throw new Error(`${path} must be one of: ${field.enum.join(", ")}.`);
      }
      return;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`${path} must be an integer.`);
      }
      if (field.minimum !== undefined && value < field.minimum) {
        throw new Error(`${path} must be >= ${field.minimum}.`);
      }
      if (field.maximum !== undefined && value > field.maximum) {
        throw new Error(`${path} must be <= ${field.maximum}.`);
      }
      if (field.enum?.length && !field.enum.includes(value)) {
        throw new Error(`${path} must be one of: ${field.enum.join(", ")}.`);
      }
      return;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${path} must be a number.`);
      }
      if (field.minimum !== undefined && value < field.minimum) {
        throw new Error(`${path} must be >= ${field.minimum}.`);
      }
      if (field.maximum !== undefined && value > field.maximum) {
        throw new Error(`${path} must be <= ${field.maximum}.`);
      }
      if (field.enum?.length && !field.enum.includes(value)) {
        throw new Error(`${path} must be one of: ${field.enum.join(", ")}.`);
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new Error(`${path} must be a boolean.`);
      }
      return;
    }
  }
}

function validateInputField(
  field: AgentAppInputField,
  value: unknown,
  path: string,
): void {
  if (field.type !== "array") {
    validateScalarInputField(field, value, path);
    return;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  if (field.minItems !== undefined && value.length < field.minItems) {
    throw new Error(`${path} must contain at least ${field.minItems} item(s).`);
  }
  if (field.maxItems !== undefined && value.length > field.maxItems) {
    throw new Error(`${path} must contain at most ${field.maxItems} item(s).`);
  }

  for (const [index, item] of value.entries()) {
    validateScalarInputField(field.items, item, `${path}[${index}]`);
  }
}

function validateActionInputSchema(
  schema: AgentAppActionInputSchema,
  input: Record<string, unknown> | undefined,
  app: AgentAppDefinition,
  actionName: string,
): void {
  const payload = input ?? {};
  if (Array.isArray(payload) || typeof payload !== "object" || payload === null) {
    throw new Error(`App action ${actionName} in ${app.slug} requires an input object.`);
  }

  const propertyMap = schema.properties ?? {};
  const propertyNames = new Set(Object.keys(propertyMap));
  const requiredKeys = schema.required ?? [];

  for (const requiredKey of requiredKeys) {
    const value = payload[requiredKey];
    if (value === undefined || value === null) {
      throw new Error(`App action ${actionName} in ${app.slug} requires input.${requiredKey}.`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(payload)) {
      if (propertyNames.has(key)) {
        continue;
      }
      throw new Error(`App action ${actionName} in ${app.slug} does not allow input.${key}.`);
    }
  }

  for (const [key, field] of Object.entries(propertyMap)) {
    const value = payload[key];
    if (value === undefined || value === null) {
      continue;
    }
    validateInputField(field, value, `input.${key}`);
  }
}

function statementReturnsRows(statement: StatementSync): boolean {
  return statement.columns().length > 0;
}

function prepareStatement(db: DatabaseSync, sql: string): StatementSync {
  const statement = db.prepare(sql);
  statement.setAllowUnknownNamedParameters(true);
  return statement;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeAppName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error("App name must not be empty.");
  }

  return normalized;
}

function normalizeOptionalDescription(description: string | undefined): string | undefined {
  const normalized = description?.trim();
  return normalized ? normalized : undefined;
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function buildDefaultSchemaSql(appName: string): string {
  return [
    `-- Bootstrap schema for ${appName}.`,
    "-- Panda does not run this file automatically yet.",
    "-- Write SQL here, then apply it to data/app.sqlite when you are ready.",
    "",
  ].join("\n");
}

function buildBlankIndexHtml(input: {
  appName: string;
  description?: string;
}): string {
  const title = escapeHtml(input.appName);
  const description = input.description?.trim()
    ? `<p class="blank-app__lede">${escapeHtml(input.description)}</p>`
    : "";

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "  <head>",
    "    <meta charset=\"utf-8\">",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `    <title>${title}</title>`,
    "    <link rel=\"stylesheet\" href=\"./app.css\">",
    "  </head>",
    "  <body>",
    "    <main class=\"blank-app\">",
    `      <h1>${title}</h1>`,
    description ? `      ${description}` : "",
    "      <p class=\"blank-app__status\" id=\"app-status\">Loading app context...</p>",
    "      <section class=\"blank-app__card\">",
    "        <h2>Blank Scaffold</h2>",
    "        <p>This app is intentionally blank. Edit <code>views.json</code>, <code>actions.json</code>, <code>schema.sql</code>, and the files in <code>public/</code>.</p>",
    "      </section>",
    "      <section class=\"blank-app__card\">",
    "        <h2>Next Steps</h2>",
    "        <ol>",
    "          <li>Define your SQLite schema in <code>schema.sql</code>.</li>",
    "          <li>Apply that schema to <code>data/app.sqlite</code>.</li>",
    "          <li>Add readonly queries in <code>views.json</code>.</li>",
    "          <li>Add fixed writes in <code>actions.json</code>.</li>",
    "          <li>Replace this placeholder UI in <code>public/</code>.</li>",
    "        </ol>",
    "      </section>",
    "    </main>",
    "    <script src=\"/panda-app-sdk.js\"></script>",
    "    <script type=\"module\" src=\"./app.js\"></script>",
    "  </body>",
    "</html>",
    "",
  ].filter(Boolean).join("\n");
}

function buildBlankAppJs(): string {
  return [
    "const status = document.querySelector('#app-status');",
    "",
    "async function main() {",
    "  const bootstrap = await window.panda.bootstrap();",
    "  const {app, context} = bootstrap;",
    "  const bits = [",
    "    `${app.viewNames.length} view${app.viewNames.length === 1 ? '' : 's'}`,",
    "    `${app.actionNames.length} action${app.actionNames.length === 1 ? '' : 's'}`",
    "  ];",
    "  if (context.identityHandle) {",
    "    bits.push(`identity ${context.identityHandle}`);",
    "  }",
    "  status.textContent = `Loaded ${app.name}. ${bits.join(' | ')}`;",
    "}",
    "",
    "main().catch((error) => {",
    "  status.textContent = error instanceof Error ? error.message : String(error);",
    "});",
    "",
  ].join("\n");
}

function buildBlankAppCss(): string {
  return [
    ":root {",
    "  color-scheme: light;",
    "  font-family: Georgia, 'Iowan Old Style', serif;",
    "  background: #f5efe6;",
    "  color: #20160f;",
    "}",
    "",
    "* {",
    "  box-sizing: border-box;",
    "}",
    "",
    "body {",
    "  margin: 0;",
    "  min-height: 100vh;",
    "  background:",
    "    radial-gradient(circle at top left, rgba(181, 129, 59, 0.14), transparent 32%),",
    "    linear-gradient(180deg, #fbf7f2 0%, #f2e7d7 100%);",
    "}",
    "",
    ".blank-app {",
    "  max-width: 760px;",
    "  margin: 0 auto;",
    "  padding: 56px 20px 80px;",
    "}",
    "",
    ".blank-app h1 {",
    "  margin: 0 0 12px;",
    "  font-size: clamp(2.6rem, 6vw, 4.5rem);",
    "  line-height: 0.95;",
    "}",
    "",
    ".blank-app__lede,",
    ".blank-app__status {",
    "  font-size: 1.05rem;",
    "  line-height: 1.6;",
    "}",
    "",
    ".blank-app__status {",
    "  color: #6d4a29;",
    "}",
    "",
    ".blank-app__card {",
    "  margin-top: 24px;",
    "  padding: 20px;",
    "  border: 1px solid rgba(84, 53, 23, 0.14);",
    "  border-radius: 20px;",
    "  background: rgba(255, 250, 243, 0.88);",
    "  box-shadow: 0 16px 50px rgba(84, 53, 23, 0.08);",
    "}",
    "",
    ".blank-app__card h2 {",
    "  margin: 0 0 10px;",
    "  font-size: 1.25rem;",
    "}",
    "",
    ".blank-app code {",
    "  font-family: 'SFMono-Regular', 'Cascadia Code', monospace;",
    "  font-size: 0.92em;",
    "}",
    "",
    ".blank-app ol {",
    "  margin: 0;",
    "  padding-left: 1.2rem;",
    "}",
    "",
    ".blank-app li + li {",
    "  margin-top: 0.55rem;",
    "}",
    "",
  ].join("\n");
}

function buildBlankReadme(input: {
  appName: string;
  appSlug: string;
  description?: string;
  identityScoped: boolean;
  schemaApplied: boolean;
}): string {
  const descriptionLine = input.description?.trim()
    ? `${input.description.trim()}\n\n`
    : "";
  const identityLine = input.identityScoped
    ? "- This app is identity-scoped. Local/dev browser links can use `?identityHandle=<handle>`; public links should come from `app_link_create`, which uses the current input identity.\n"
    : "- This app is not identity-scoped.\n";
  const schemaLine = input.schemaApplied
    ? "- `schema.sql` was applied to `data/app.sqlite` during scaffold creation.\n"
    : "- `schema.sql` is just a placeholder right now. Panda does not apply it automatically yet.\n";

  return [
    `# ${input.appName}`,
    "",
    `${descriptionLine}This is a blank Panda app scaffold.`,
    "Read `/app/docs/agents/apps.md` in Docker or `docs/agents/apps.md` in a source checkout for the global contract and tool guidance.",
    "If you need a concrete reference, inspect `/app/examples/apps` in Docker or `examples/apps` in a source checkout.",
    "",
    "## Files",
    "",
    "- `manifest.json`: app metadata and basic runtime settings",
    "- `schema.sql`: optional bootstrap SQL for the app database",
    "- `views.json`: readonly SQL queries exposed through `app_view` and the app host",
    "- `actions.json`: fixed writes or reads exposed through `app_action` and the app host",
    "- `public/`: UI files served by Panda when the local apps server is running",
    "- `data/app.sqlite`: the app database file",
    "",
    "## Current State",
    "",
    "- This README is scaffold-time guidance. After you edit the app, trust the actual files over this checklist.",
    identityLine.trimEnd(),
    schemaLine.trimEnd(),
    "- `views.json` is empty.",
    "- `actions.json` is empty.",
    "- `public/` still contains the default placeholder UI.",
    "",
    "## Next Steps",
    "",
    `1. Define the schema you actually want in \`schema.sql\` for \`${input.appSlug}\`.`,
    "2. Apply that schema to `data/app.sqlite`.",
    "3. Add readonly queries to `views.json`.",
    "4. Add fixed actions to `actions.json`. Prefer `inputSchema` over loose payloads.",
    "5. Run `app_check` if Panda says the app is invalid or the UI/tool contract feels weird.",
    "6. Replace the placeholder UI in `public/`. Keep JavaScript in `public/app.js`; public app auth blocks inline scripts.",
    "7. Start Panda with `panda run`. The app server starts automatically with the daemon.",
    "",
    "## Apply Schema",
    "",
    "If you add SQL to `schema.sql`, one portable way to apply it is:",
    "",
    "```sh",
    "node --input-type=module -e \"import {readFileSync} from 'node:fs'; import {DatabaseSync} from 'node:sqlite'; const db = new DatabaseSync('data/app.sqlite'); db.exec(readFileSync('schema.sql', 'utf8')); db.close();\"",
    "```",
    "",
    "## Local URL",
    "",
    "- `app_create` and `app_list` return the current app URL when Panda knows it.",
    "- For human-facing public access, use `app_link_create` and send the returned `openUrl`.",
    "- Use `/panda-app-sdk.js` for API calls; public app auth requires the SDK's app-scoped CSRF header.",
    `- Path: \`/<agentKey>/apps/${input.appSlug}/\``,
    input.identityScoped
      ? "- Example: `/panda/apps/" + input.appSlug + "/?identityHandle=smoke`"
      : `- Example: \`/panda/apps/${input.appSlug}/\``,
    "",
  ].join("\n");
}

function openAppDatabase(app: AgentAppDefinition): DatabaseSync {
  return new DatabaseSync(app.dbPath);
}

export interface CreateBlankAgentAppOptions {
  slug: string;
  name: string;
  description?: string;
  identityScoped?: boolean;
  schemaSql?: string;
}

export interface CreateBlankAgentAppResult {
  actionPath: string;
  app: AgentAppDefinition;
  createdDatabase: boolean;
  manifestPath: string;
  readmePath: string;
  schemaApplied: boolean;
  schemaPath: string;
  viewPath: string;
}

export interface AgentAppViewExecutionOptions {
  identityId?: string;
  params?: Record<string, unknown>;
  pageSize?: number;
  offset?: number;
  sessionId?: string;
}

export interface AgentAppActionExecutionOptions {
  identityId?: string;
  input?: Record<string, unknown>;
  sessionId?: string;
  wake?: ((message: string) => Promise<void>) | undefined;
}

export interface AgentAppServiceOptions extends FileSystemAgentAppRegistryOptions {
  registry?: FileSystemAgentAppRegistry;
}

export class AgentAppService {
  readonly registry: FileSystemAgentAppRegistry;

  constructor(options: AgentAppServiceOptions = {}) {
    this.registry = options.registry ?? new FileSystemAgentAppRegistry(options);
  }

  async listApps(agentKey: string): Promise<readonly AgentAppDefinition[]> {
    return this.registry.listApps(agentKey);
  }

  async inspectApps(agentKey: string): Promise<AgentAppInspectionResult> {
    return this.registry.inspectApps(agentKey);
  }

  async checkApps(
    agentKey: string,
    options: {
      appSlug?: string;
    } = {},
  ): Promise<readonly AgentAppCheckResult[]> {
    const inspection = options.appSlug
      ? await this.inspectSingleApp(agentKey, options.appSlug)
      : await this.registry.inspectApps(agentKey);
    const checks = await Promise.all([
      ...inspection.apps.map((app) => this.checkLoadedApp(app)),
      ...inspection.brokenApps.map((brokenApp) => Promise.resolve(brokenApp)),
    ]);

    return checks.sort((left, right) => left.appSlug.localeCompare(right.appSlug));
  }

  async getApp(agentKey: string, appSlug: string): Promise<AgentAppDefinition> {
    return this.registry.getApp(agentKey, appSlug);
  }

  async createBlankApp(
    agentKey: string,
    options: CreateBlankAgentAppOptions,
  ): Promise<CreateBlankAgentAppResult> {
    const appSlug = normalizeAgentAppSlug(options.slug);
    const appName = normalizeAppName(options.name);
    const description = normalizeOptionalDescription(options.description);
    const identityScoped = options.identityScoped ?? false;
    const appsDir = this.registry.resolveAppsDir(agentKey);
    const appDir = path.join(appsDir, appSlug);
    const manifestPath = path.join(appDir, "manifest.json");
    const viewPath = path.join(appDir, "views.json");
    const actionPath = path.join(appDir, "actions.json");
    const schemaPath = path.join(appDir, "schema.sql");
    const readmePath = path.join(appDir, "README.md");
    const publicDir = path.join(appDir, "public");
    const dataDir = path.join(appDir, "data");
    const dbPath = path.join(dataDir, "app.sqlite");
    const schemaSql = options.schemaSql?.trim();
    const schemaApplied = Boolean(schemaSql);

    if (await pathExists(appDir)) {
      throw new Error(`App ${appSlug} already exists for ${agentKey}.`);
    }

    await mkdir(appDir, {recursive: true});
    try {
      await mkdir(publicDir, {recursive: true});
      await mkdir(dataDir, {recursive: true});

      await writeFile(manifestPath, stringifyJson({
        name: appName,
        ...(description ? {description} : {}),
        ...(identityScoped ? {identityScoped: true} : {}),
      }));
      await writeFile(viewPath, stringifyJson({}));
      await writeFile(actionPath, stringifyJson({}));
      await writeFile(
        schemaPath,
        ensureTrailingNewline(schemaSql ?? buildDefaultSchemaSql(appName)),
      );
      await writeFile(
        path.join(publicDir, "index.html"),
        buildBlankIndexHtml({appName, description}),
      );
      await writeFile(path.join(publicDir, "app.js"), buildBlankAppJs());
      await writeFile(path.join(publicDir, "app.css"), buildBlankAppCss());

      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        if (schemaSql) {
          db.exec(schemaSql);
        }
      } finally {
        db.close();
      }

      await writeFile(readmePath, buildBlankReadme({
        appName,
        appSlug,
        description,
        identityScoped,
        schemaApplied,
      }));
    } catch (error) {
      await rm(appDir, {recursive: true, force: true});
      throw error;
    }

    const app = await this.getApp(agentKey, appSlug);
    return {
      app,
      manifestPath,
      viewPath,
      actionPath,
      schemaPath,
      readmePath,
      createdDatabase: true,
      schemaApplied,
    };
  }

  async executeView(
    agentKey: string,
    appSlug: string,
    viewName: string,
    options: AgentAppViewExecutionOptions = {},
  ): Promise<AgentAppViewResult> {
    const app = await this.registry.getApp(agentKey, appSlug);
    const definition = app.views[viewName];
    if (!definition) {
      throw new Error(`Unknown app view ${viewName} in ${app.slug}.`);
    }
    if (app.identityScoped && !options.identityId) {
      throw new Error(`App ${app.slug} requires identityId for view ${viewName}.`);
    }

    await mkdir(path.dirname(app.dbPath), {recursive: true});
    const db = openAppDatabase(app);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      const boundParams = buildBoundParams({
        app,
        params: options.params,
        identityId: app.identityScoped ? options.identityId : undefined,
        sessionId: options.sessionId,
      });

      if (!definition.pagination || definition.pagination.mode !== "offset") {
        const rows = prepareStatement(db, definition.sql).all(boundParams) as Record<string, unknown>[];
        return {
          items: normalizeRows(rows),
        };
      }

      const defaultPageSize = definition.pagination.defaultPageSize ?? 20;
      const maxPageSize = definition.pagination.maxPageSize ?? 100;
      const limit = Math.max(1, Math.min(options.pageSize ?? defaultPageSize, maxPageSize));
      const offset = Math.max(0, Math.trunc(options.offset ?? 0));
      const rows = prepareStatement(db,
        `SELECT * FROM (${definition.sql}) AS app_view LIMIT :limit_plus_one OFFSET :offset`,
      ).all({
        ...boundParams,
        limit_plus_one: limit + 1,
        offset,
      }) as Record<string, unknown>[];
      const hasMore = rows.length > limit;

      return {
        items: normalizeRows(rows.slice(0, limit)),
        page: {
          mode: "offset",
          limit,
          offset,
          hasMore,
          ...(hasMore ? {nextOffset: offset + limit} : {}),
        },
      };
    } finally {
      db.close();
    }
  }

  async executeAction(
    agentKey: string,
    appSlug: string,
    actionName: string,
    options: AgentAppActionExecutionOptions = {},
  ): Promise<AgentAppActionResult> {
    const app = await this.registry.getApp(agentKey, appSlug);
    const definition = app.actions[actionName];
    if (!definition) {
      throw new Error(`Unknown app action ${actionName} in ${app.slug}.`);
    }
    if (app.identityScoped && !options.identityId) {
      throw new Error(`App ${app.slug} requires identityId for action ${actionName}.`);
    }
    validateRequiredInputKeys(definition, options.input, app, actionName);
    if (definition.inputSchema) {
      validateActionInputSchema(definition.inputSchema, options.input, app, actionName);
    }

    await mkdir(path.dirname(app.dbPath), {recursive: true});
    const db = openAppDatabase(app);
    const mode: AgentAppActionMode = definition.mode ?? "native";
    const boundParams = buildBoundParams({
      app,
      params: options.input,
      identityId: app.identityScoped ? options.identityId : undefined,
      sessionId: options.sessionId,
    });

    let changes = 0;
    let lastInsertRowid: number | string | undefined;
    let rows: Record<string, unknown>[] | undefined;

    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      db.exec("BEGIN IMMEDIATE");

      for (const sql of readActionStatements(definition)) {
        const statement = prepareStatement(db, sql);
        if (statementReturnsRows(statement)) {
          rows = normalizeRows(statement.all(boundParams) as Record<string, unknown>[]);
          continue;
        }

        const result = statement.run(boundParams);
        changes += Number(result.changes);
        if (result.lastInsertRowid !== undefined) {
          lastInsertRowid = normalizeSqlValue(result.lastInsertRowid) as number | string;
        }
      }

      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures. The original error is the useful one.
      }

      throw error;
    } finally {
      db.close();
    }

    const wakeRequested = mode !== "native";
    if (wakeRequested && options.wake) {
      await options.wake(this.buildWakeMessage(app, actionName, definition, options.input, {
        identityId: app.identityScoped ? options.identityId : undefined,
        changes,
        lastInsertRowid,
        rows,
      }));
    }

    return {
      mode,
      changes,
      ...(lastInsertRowid !== undefined ? {lastInsertRowid} : {}),
      ...(rows ? {rows} : {}),
      wakeRequested,
    };
  }

  private buildWakeMessage(
    app: AgentAppDefinition,
    actionName: string,
    definition: AgentAppActionDefinition,
    input: Record<string, unknown> | undefined,
    result: {
      identityId?: string;
      changes: number;
      lastInsertRowid?: number | string;
      rows?: Record<string, unknown>[];
    },
  ): string {
    const inputLines = formatWakeInputLines(input);
    const summary = definition.wakeMessage?.trim()
      ? renderWakeTemplate(definition.wakeMessage, {
        app: {
          name: app.name,
          slug: app.slug,
        },
        action: {
          name: actionName,
        },
        identity: {
          id: result.identityId,
        },
        input: input ?? {},
        result: {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
          rows: result.rows ?? [],
        },
      })
      : `A micro-app action completed and may need follow-up.`;

    const lines = [
      summary,
      "",
      `App: ${app.name} (${app.slug})`,
      `Action: ${actionName}`,
      ...(!definition.wakeMessage && inputLines.length > 0 ? ["Input:", ...inputLines] : []),
    ];

    return lines.filter((line): line is string => Boolean(line)).join("\n");
  }

  private async inspectSingleApp(
    agentKey: string,
    appSlug: string,
  ): Promise<AgentAppInspectionResult> {
    const normalizedSlug = normalizeAgentAppSlug(appSlug);
    const appDir = path.join(this.registry.resolveAppsDir(agentKey), normalizedSlug);
    try {
      const app = await this.registry.getApp(agentKey, normalizedSlug);
      return {
        apps: [app],
        brokenApps: [],
      };
    } catch (error) {
      return {
        apps: [],
        brokenApps: [{
          appSlug: normalizedSlug,
          appDir,
          ok: false,
          errors: error instanceof AgentAppDefinitionError
            ? error.issues
            : [{
              file: appDir,
              message: error instanceof Error ? error.message : String(error),
            }],
          warnings: [],
        }],
      };
    }
  }

  private async checkLoadedApp(app: AgentAppDefinition): Promise<AgentAppCheckResult> {
    const errors: AgentAppDiagnosticIssue[] = [];
    const warnings: AgentAppDiagnosticIssue[] = [];
    const schemaPath = path.join(app.appDir, "schema.sql");
    if (!await pathExists(schemaPath)) {
      warnings.push({
        file: schemaPath,
        message: "schema.sql is missing.",
      });
    }

    if (!await pathExists(app.dbPath)) {
      warnings.push({
        file: app.dbPath,
        message: "data/app.sqlite is missing, so SQL prepare checks were skipped.",
      });
      return {
        appSlug: app.slug,
        appDir: app.appDir,
        ok: errors.length === 0,
        errors,
        warnings,
      };
    }

    const db = openAppDatabase(app);
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      for (const [viewName, definition] of Object.entries(app.views)) {
        try {
          if (definition.pagination?.mode === "offset") {
            db.prepare(`SELECT * FROM (${definition.sql}) AS app_view LIMIT :limit_plus_one OFFSET :offset`);
          } else {
            db.prepare(definition.sql);
          }
        } catch (error) {
          errors.push({
            file: app.viewsPath,
            path: `${viewName}.sql`,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      for (const [actionName, definition] of Object.entries(app.actions)) {
        const statements = readActionStatements(definition);
        for (const [index, statement] of statements.entries()) {
          try {
            db.prepare(statement);
          } catch (error) {
            errors.push({
              file: app.actionsPath,
              path: statements.length === 1 ? `${actionName}.sql` : `${actionName}.sql[${index}]`,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } finally {
      db.close();
    }

    return {
      appSlug: app.slug,
      appDir: app.appDir,
      ok: errors.length === 0,
      errors,
      warnings,
    };
  }
}
