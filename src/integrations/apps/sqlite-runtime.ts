import {lstatSync, realpathSync} from "node:fs";
import path from "node:path";
import {DatabaseSync, type StatementSync} from "node:sqlite";

import type {
    AgentAppActionDefinition,
    AgentAppDefinition,
} from "../../domain/apps/types.js";

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

/** Normalizes SQLite values into JSON-safe values for app tool callers. */
export function normalizeSqlValue(value: unknown): unknown {
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

export function normalizeRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => normalizeSqlValue(row) as Record<string, unknown>);
}

/** Normalizes SQLite driver change counts before exposing app action results. */
export function normalizeSqlChangeCount(value: unknown): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("App action SQLite change count must be a non-negative safe integer.");
    }

    return Number(value);
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  throw new Error("App action SQLite change count must be a non-negative safe integer.");
}

/** Builds named SQLite parameters while reserving Panda-owned app context keys. */
export function buildBoundParams(input: {
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

export function readActionStatements(definition: AgentAppActionDefinition): readonly string[] {
  const {sql} = definition;
  return typeof sql === "string" ? [sql] : Array.from(sql);
}

export function statementReturnsRows(statement: StatementSync): boolean {
  return statement.columns().length > 0;
}

function stripSqlTextLiteralsAndComments(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "-" && next === "-") {
      output += "  ";
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < sql.length) {
        if (sql[index] === "*" && sql[index + 1] === "/") {
          output += "  ";
          index += 2;
          break;
        }
        output += " ";
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      const quote = char;
      output += " ";
      index += 1;
      while (index < sql.length) {
        output += " ";
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            output += " ";
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

/** Blocks SQLite statements that can escape the app-owned database file. */
export function assertSqlStaysInAppDatabase(sql: string): void {
  const normalized = stripSqlTextLiteralsAndComments(sql).toLowerCase();
  if (/\battach\b|\bdetach\b|\bvacuum\s+into\b|\bload_extension\s*\(/.test(normalized)) {
    throw new Error("App SQL must not use ATTACH, DETACH, VACUUM INTO, or load_extension().");
  }
}

export function prepareStatement(db: DatabaseSync, sql: string): StatementSync {
  assertSqlStaysInAppDatabase(sql);
  const statement = db.prepare(sql);
  statement.setAllowUnknownNamedParameters(true);
  return statement;
}

function isContainedPath(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertAppDatabasePath(app: AgentAppDefinition): void {
  const realAppDir = realpathSync(app.appDir);
  const realDbParent = realpathSync(path.dirname(app.dbPath));
  if (!isContainedPath(realAppDir, realDbParent)) {
    throw new Error(`App database path for ${app.slug} must stay inside the app directory.`);
  }

  const dbPathStat = lstatSync(app.dbPath, {throwIfNoEntry: false});
  if (!dbPathStat) {
    return;
  }
  if (dbPathStat.isSymbolicLink()) {
    throw new Error(`App database path for ${app.slug} must not be a symlink.`);
  }

  const realDbPath = realpathSync(app.dbPath);
  if (!isContainedPath(realAppDir, realDbPath)) {
    throw new Error(`App database path for ${app.slug} must stay inside the app directory.`);
  }
}

/** Opens an app SQLite DB only after the configured path is proven app-local. */
export function openAppDatabase(app: AgentAppDefinition, options: {readOnly?: boolean} = {}): DatabaseSync {
  assertAppDatabasePath(app);
  return options.readOnly
    ? new DatabaseSync(app.dbPath, {readOnly: true})
    : new DatabaseSync(app.dbPath);
}
