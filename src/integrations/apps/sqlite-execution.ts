import path from "node:path";
import {mkdir} from "node:fs/promises";

import type {
  AgentAppActionDefinition,
  AgentAppDefinition,
  AgentAppActionInputSchema,
  AgentAppActionMode,
  AgentAppActionResult,
  AgentAppActionExecutionOptions,
  AgentAppInputField,
  AgentAppScalarInputField,
  AgentAppViewExecutionOptions,
  AgentAppViewResult,
} from "../../domain/apps/types.js";
import {readAgentAppRequiredInputKeys} from "../../domain/apps/types.js";
import type {FileSystemAgentAppRegistry} from "./fs-registry.js";
import {
  buildBoundParams,
  normalizeRows,
  normalizeSqlChangeCount,
  normalizeSqlValue,
  openAppDatabase,
  prepareStatement,
  readActionStatements,
  statementReturnsRows,
} from "./sqlite-runtime.js";

function validateRequiredAgentAppInputKeys(
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

function validateAgentAppActionInputSchema(
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

function buildAgentAppWakeMessage(
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
    : "A micro-app action completed and may need follow-up.";

  const lines = [
    summary,
    "",
    `App: ${app.name} (${app.slug})`,
    `Action: ${actionName}`,
    ...(!definition.wakeMessage && inputLines.length > 0 ? ["Input:", ...inputLines] : []),
  ];

  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export async function executeAgentAppView(input: {
  agentKey: string;
  appSlug: string;
  options?: AgentAppViewExecutionOptions;
  registry: Pick<FileSystemAgentAppRegistry, "getApp">;
  viewName: string;
}): Promise<AgentAppViewResult> {
  const options = input.options ?? {};
  const app = await input.registry.getApp(input.agentKey, input.appSlug);
  const definition = app.views[input.viewName];
  if (!definition) {
    throw new Error(`Unknown app view ${input.viewName} in ${app.slug}.`);
  }
  if (app.identityScoped && !options.identityId) {
    throw new Error(`App ${app.slug} requires identityId for view ${input.viewName}.`);
  }

  await mkdir(path.dirname(app.dbPath), {recursive: true});
  const db = openAppDatabase(app, {readOnly: true});
  try {
    db.exec("PRAGMA foreign_keys = ON;");
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

export async function executeAgentAppAction(input: {
  actionName: string;
  agentKey: string;
  appSlug: string;
  options?: AgentAppActionExecutionOptions;
  registry: Pick<FileSystemAgentAppRegistry, "getApp">;
}): Promise<AgentAppActionResult> {
  const options = input.options ?? {};
  const app = await input.registry.getApp(input.agentKey, input.appSlug);
  const definition = app.actions[input.actionName];
  if (!definition) {
    throw new Error(`Unknown app action ${input.actionName} in ${app.slug}.`);
  }
  if (app.identityScoped && !options.identityId) {
    throw new Error(`App ${app.slug} requires identityId for action ${input.actionName}.`);
  }
  validateRequiredAgentAppInputKeys(definition, options.input, app, input.actionName);
  if (definition.inputSchema) {
    validateAgentAppActionInputSchema(definition.inputSchema, options.input, app, input.actionName);
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
      const statementChanges = normalizeSqlChangeCount(result.changes);
      const nextChanges = changes + statementChanges;
      if (!Number.isSafeInteger(nextChanges)) {
        throw new Error("App action SQLite change count total must be a safe integer.");
      }
      changes = nextChanges;
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
    await options.wake(buildAgentAppWakeMessage(app, input.actionName, definition, options.input, {
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
