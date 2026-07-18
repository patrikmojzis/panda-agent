import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject, JsonValue} from "../../lib/json.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import type {
  CommandDescriptor,
  CommandRequest,
  CommandSuccess,
  RegisteredCommand,
} from "../../domain/commands/types.js";
import type {ExecutionSkillPolicy} from "../../domain/execution-environments/types.js";
import {READONLY_SESSION_VIEW_BASENAMES} from "../../domain/threads/runtime/postgres-readonly.js";
import {isRecord} from "../../lib/records.js";
import {truncateText} from "../../lib/strings.js";

const MAX_ROWS = 50;
const MAX_OUTPUT_BYTES = 32_000;
const MAX_CELL_BYTES = 4_000;
const MAX_STRING_CHARS = 4_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 500;
const IDLE_TX_TIMEOUT_MS = 5_000;
type PgPoolResolver = () => Promise<PgPoolLike> | PgPoolLike;

const READONLY_VIEW_GUIDANCE = [
  "A single read-only SELECT or WITH query.",
  "Prefer session.agent_sessions for the current session row.",
  "session.agent_sessions exposes current_thread_id, not thread_id.",
  "The readonly command already scopes session.threads, session.messages, session.tool_results, session.inputs, session.runs, session.todos, session.subagent_history, session.scheduled_tasks, session.scheduled_task_runs, session.watches, session.watch_runs, and session.watch_events to the current session.",
  "The readonly command also scopes session.prompts to the current session, and session.agent_pairings and session.agent_skills to the current agent.",
  "Do not invent is_active flags or extra session_id subqueries unless you are joining raw tables outside the session.* views.",
  "Use session.prompts for session prompt docs, session.agent_pairings for known identities, and session.agent_skills for stored skills.",
  "For exploratory reads, prefer left(...), substring(...), regex filters, full-text search, or other narrow projections instead of pulling giant content blobs blindly.",
  "For durable session todo context, query session.todos. For older subagent archaeology omitted from the default prompt, query session.subagent_history. For session automation, query session.scheduled_tasks or session.watches directly with ORDER BY/LIMIT.",
  "Prefer session.agent_skills for stored skill bodies and session.messages_raw only when you truly need raw JSONB.",
  "Large skill bodies may need substring(...) or targeted column selection.",
  "If you need schema help, query information_schema.columns.",
].join(" ");

export interface PostgresReadonlyQueryCommandOptions {
  pool?: PgPoolLike;
  getPool?: PgPoolResolver;
  maxRows?: number;
  maxOutputBytes?: number;
  maxStringChars?: number;
}

interface PostgresReadonlyQueryExecutionOptions {
  getPool: PgPoolResolver;
  maxRows: number;
  maxOutputBytes: number;
  maxStringChars: number;
}

interface PostgresReadonlyQueryExecutionInput {
  sql: string;
  sessionId: string;
  agentKey: string;
  skillPolicy: ExecutionSkillPolicy;
  maxRows?: number;
}

export const POSTGRES_READONLY_QUERY_COMMAND_NAME = "postgres.readonly.query";

const POSTGRES_SQL_ARGUMENT = {
  name: "sql",
  description: "Single read-only SELECT or WITH query. Required unless --schema-help is used. Use @file or @- for multiline SQL.",
  valueType: "string" as const,
  valueName: "text|@file|@-",
  valueSources: ["literal", "file", "stdin"] as const,
};

const POSTGRES_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object containing sql and optional maxRows, or schemaHelp:true.",
  valueType: "json" as const,
};

export const POSTGRES_READONLY_QUERY_EXAMPLES = [
  {
    description: "Inspect columns for a session-scoped view",
    sql: "select column_name, data_type from information_schema.columns where table_schema = 'session' and table_name = 'messages' order by ordinal_position",
  },
  {
    description: "Read recent messages without pulling large blobs",
    sql: "select id, role, left(text, 500) as excerpt, created_at from session.messages order by created_at desc limit 10",
  },
  {
    description: "Find recent watch runs",
    sql: "select watch_id, status, scheduled_for, error from session.watch_runs order by created_at desc limit 10",
  },
] as const;

async function buildReadonlySchemaHelp(getPool: PgPoolResolver): Promise<JsonObject> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    const result = await client.query(`
      SELECT table_name, column_name, data_type, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'session'
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position
    `, [READONLY_SESSION_VIEW_BASENAMES]);

    const columnsByView = new Map<string, Array<{name: string; type: string}>>(
      READONLY_SESSION_VIEW_BASENAMES.map((name) => [name, []]),
    );
    for (const rawRow of result.rows) {
      const row = rawRow as Record<string, unknown>;
      if (
        typeof row.table_name !== "string"
        || typeof row.column_name !== "string"
        || typeof row.data_type !== "string"
      ) {
        throw new Error("Readonly schema introspection returned an invalid column row.");
      }
      columnsByView.get(row.table_name)?.push({
        name: row.column_name,
        type: row.data_type,
      });
    }

    const missing = READONLY_SESSION_VIEW_BASENAMES.filter((name) => columnsByView.get(name)?.length === 0);
    if (missing.length > 0) {
      const expected = missing.map((name) => `session.${name}`).join(", ");
      throw new Error(`Readonly schema is incomplete: expected ${expected} but ${missing.length === 1 ? "it is" : "they are"} unavailable.`);
    }

    await client.query("COMMIT");
    return {
      operation: "schema_help",
      guidance: READONLY_VIEW_GUIDANCE,
      views: READONLY_SESSION_VIEW_BASENAMES.map((name) => ({
        name: `session.${name}`,
        columns: columnsByView.get(name) ?? [],
      })),
      examples: [...POSTGRES_READONLY_QUERY_EXAMPLES],
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the schema failure as the useful error.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(
      message.startsWith("Readonly schema is incomplete:")
        ? message
        : "Readonly schema introspection failed.",
    );
  } finally {
    client.release();
  }
}

function trimSql(value: string): string {
  return value.trim().replace(/;+$/, "").trim();
}

type SqlGuardToken =
  | {readonly kind: "identifier"; readonly value: string}
  | {readonly kind: "dot" | "openParen"};

const DANGEROUS_READONLY_FUNCTIONS = [
  "query_to_xml",
  "table_to_xml",
  "schema_to_xml",
  "database_to_xml",
  "cursor_to_xml",
  "query_to_xmlschema",
  "table_to_xmlschema",
  "schema_to_xmlschema",
  "database_to_xmlschema",
  "cursor_to_xmlschema",
  "query_to_xml_and_xmlschema",
  "table_to_xml_and_xmlschema",
  "schema_to_xml_and_xmlschema",
  "database_to_xml_and_xmlschema",
  "cursor_to_xml_and_xmlschema",
  "dblink",
  "dblink_exec",
  "dblink_connect",
  "dblink_connect_u",
  "dblink_disconnect",
  "dblink_open",
  "dblink_fetch",
  "dblink_close",
  "dblink_send_query",
  "dblink_get_result",
  "lo_export",
  "lo_import",
  "lo_from_bytea",
  "lo_put",
  "lo_unlink",
] as const;
const DANGEROUS_READONLY_FUNCTION_NAMES: ReadonlySet<string> = new Set(DANGEROUS_READONLY_FUNCTIONS);

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z_]$/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9_$]$/.test(char);
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function isDollarQuoteTagPart(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9_]$/.test(char);
}

function skipLineComment(sql: string, start: number): number {
  let cursor = start + 2;
  while (cursor < sql.length && sql[cursor] !== "\n" && sql[cursor] !== "\r") {
    cursor += 1;
  }
  return cursor;
}

function skipBlockComment(sql: string, start: number): number {
  let cursor = start + 2;
  let depth = 1;

  while (cursor < sql.length && depth > 0) {
    if (sql[cursor] === "/" && sql[cursor + 1] === "*") {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (sql[cursor] === "*" && sql[cursor + 1] === "/") {
      depth -= 1;
      cursor += 2;
      continue;
    }
    cursor += 1;
  }

  return cursor;
}

function skipWhitespaceAndComments(sql: string, start: number): number {
  let cursor = start;

  while (cursor < sql.length) {
    if (isWhitespace(sql[cursor])) {
      cursor += 1;
      continue;
    }
    if (sql[cursor] === "-" && sql[cursor + 1] === "-") {
      cursor = skipLineComment(sql, cursor);
      continue;
    }
    if (sql[cursor] === "/" && sql[cursor + 1] === "*") {
      cursor = skipBlockComment(sql, cursor);
      continue;
    }
    break;
  }

  return cursor;
}

function skipSingleQuotedString(sql: string, start: number, supportsBackslashEscapes = false): number {
  let cursor = start + 1;

  while (cursor < sql.length) {
    if (supportsBackslashEscapes && sql[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (sql[cursor] === "'") {
      if (sql[cursor + 1] === "'") {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }

  return sql.length;
}

function readSingleQuotedLiteral(sql: string, start: number): {readonly value: string; readonly end: number} | null {
  if (sql[start] !== "'") {
    return null;
  }

  let value = "";
  let cursor = start + 1;
  while (cursor < sql.length) {
    const char = sql[cursor];
    if (char === undefined) {
      return null;
    }
    if (char === "'") {
      if (sql[cursor + 1] === "'") {
        value += "'";
        cursor += 2;
        continue;
      }
      return {value, end: cursor + 1};
    }
    value += char;
    cursor += 1;
  }

  return null;
}

function readDollarQuoteTag(sql: string, start: number): string | null {
  if (sql[start] !== "$") {
    return null;
  }

  let cursor = start + 1;
  if (sql[cursor] === "$") {
    return "$$";
  }
  if (!isIdentifierStart(sql[cursor])) {
    return null;
  }

  cursor += 1;
  while (isDollarQuoteTagPart(sql[cursor])) {
    cursor += 1;
  }

  return sql[cursor] === "$" ? sql.slice(start, cursor + 1) : null;
}

function skipDollarQuotedString(sql: string, start: number, tag: string): number {
  const close = sql.indexOf(tag, start + tag.length);
  return close === -1 ? sql.length : close + tag.length;
}

function readQuotedIdentifier(sql: string, start: number): {readonly value: string; readonly end: number} {
  let value = "";
  let cursor = start + 1;

  while (cursor < sql.length) {
    const char = sql[cursor];
    if (char === undefined) {
      break;
    }
    if (char === "\"") {
      if (sql[cursor + 1] === "\"") {
        value += "\"";
        cursor += 2;
        continue;
      }
      return {value, end: cursor + 1};
    }
    value += char;
    cursor += 1;
  }

  return {value, end: sql.length};
}

function keywordAt(sql: string, start: number, keyword: string): boolean {
  return sql.slice(start, start + keyword.length).toLowerCase() === keyword && !isIdentifierPart(sql[start + keyword.length]);
}

function readUnicodeEscapeClause(sql: string, start: number): {readonly escapeChar: string; readonly end: number} | null {
  let cursor = skipWhitespaceAndComments(sql, start);
  if (!keywordAt(sql, cursor, "uescape")) {
    return null;
  }

  cursor = skipWhitespaceAndComments(sql, cursor + "uescape".length);
  const literal = readSingleQuotedLiteral(sql, cursor);
  const chars = literal ? Array.from(literal.value) : [];
  if (!literal || chars.length !== 1) {
    return null;
  }

  return {escapeChar: chars[0] ?? "\\", end: literal.end};
}

function codePointFromHex(hex: string): string | null {
  const codePoint = Number.parseInt(hex, 16);
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : null;
}

function decodeUnicodeEscapedIdentifier(value: string, escapeChar: string): string {
  let decoded = "";
  let cursor = 0;

  while (cursor < value.length) {
    const char = value[cursor];
    if (char !== escapeChar) {
      decoded += char ?? "";
      cursor += 1;
      continue;
    }

    if (value[cursor + 1] === escapeChar) {
      decoded += escapeChar;
      cursor += 2;
      continue;
    }

    if (value[cursor + 1] === "+") {
      const hex = value.slice(cursor + 2, cursor + 8);
      const codePoint = /^[0-9A-Fa-f]{6}$/.test(hex) ? codePointFromHex(hex) : null;
      if (codePoint !== null) {
        decoded += codePoint;
        cursor += 8;
        continue;
      }
    }

    const hex = value.slice(cursor + 1, cursor + 5);
    const codePoint = /^[0-9A-Fa-f]{4}$/.test(hex) ? codePointFromHex(hex) : null;
    if (codePoint !== null) {
      decoded += codePoint;
      cursor += 5;
      continue;
    }

    decoded += char ?? "";
    cursor += 1;
  }

  return decoded;
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase();
}

function tokenizeSqlForGuard(sql: string): SqlGuardToken[] {
  const tokens: SqlGuardToken[] = [];
  let cursor = 0;

  while (cursor < sql.length) {
    cursor = skipWhitespaceAndComments(sql, cursor);
    if (cursor >= sql.length) {
      break;
    }

    const char = sql[cursor];
    if (char === undefined) {
      break;
    }

    if ((char === "E" || char === "e") && sql[cursor + 1] === "'") {
      cursor = skipSingleQuotedString(sql, cursor + 1, true);
      continue;
    }

    if ((char === "U" || char === "u") && sql[cursor + 1] === "&" && sql[cursor + 2] === "'") {
      cursor = skipSingleQuotedString(sql, cursor + 2);
      const escapeClause = readUnicodeEscapeClause(sql, cursor);
      cursor = escapeClause?.end ?? cursor;
      continue;
    }

    if ((char === "U" || char === "u") && sql[cursor + 1] === "&" && sql[cursor + 2] === "\"") {
      const quoted = readQuotedIdentifier(sql, cursor + 2);
      const escapeClause = readUnicodeEscapeClause(sql, quoted.end);
      tokens.push({
        kind: "identifier",
        value: normalizeIdentifier(decodeUnicodeEscapedIdentifier(quoted.value, escapeClause?.escapeChar ?? "\\")),
      });
      cursor = escapeClause?.end ?? quoted.end;
      continue;
    }

    const dollarTag = readDollarQuoteTag(sql, cursor);
    if (dollarTag !== null) {
      cursor = skipDollarQuotedString(sql, cursor, dollarTag);
      continue;
    }

    if (char === "'") {
      cursor = skipSingleQuotedString(sql, cursor);
      continue;
    }

    if (char === "\"") {
      const quoted = readQuotedIdentifier(sql, cursor);
      tokens.push({kind: "identifier", value: normalizeIdentifier(quoted.value)});
      cursor = quoted.end;
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = cursor;
      cursor += 1;
      while (isIdentifierPart(sql[cursor])) {
        cursor += 1;
      }
      tokens.push({kind: "identifier", value: normalizeIdentifier(sql.slice(start, cursor))});
      continue;
    }

    if (char === ".") {
      tokens.push({kind: "dot"});
      cursor += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({kind: "openParen"});
      cursor += 1;
      continue;
    }

    cursor += 1;
  }

  return tokens;
}

function tokenStartsFunctionCall(tokens: readonly SqlGuardToken[], index: number): boolean {
  return tokens[index + 1]?.kind === "openParen";
}

function assertNoRuntimeScopeMutation(tokens: readonly SqlGuardToken[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === "identifier" && token.value === "set_config" && tokenStartsFunctionCall(tokens, index)) {
      throw new ToolError("Readonly SQL cannot mutate runtime scope.");
    }
  }
}

function assertNoModelCallTraceTableAccess(tokens: readonly SqlGuardToken[]): void {
  for (const token of tokens) {
    if (token.kind === "identifier" && token.value === "model_call_traces") {
      throw new ToolError("Model call traces are not exposed through readonly SQL. Use the admin-only Control model-call trace viewer instead.");
    }
  }
}

function assertNoDangerousReadonlyFunctions(tokens: readonly SqlGuardToken[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === "identifier" && DANGEROUS_READONLY_FUNCTION_NAMES.has(token.value) && tokenStartsFunctionCall(tokens, index)) {
      throw new ToolError("Readonly SQL cannot use Postgres dynamic SQL, dump, dblink, or file export functions.");
    }
  }
}

function assertReadonlySql(sql: string): string {
  const normalized = trimSql(sql);
  if (!normalized) {
    throw new ToolError("SQL must not be empty.");
  }

  if (normalized.includes(";")) {
    throw new ToolError("Only a single SQL statement is allowed.");
  }

  if (!/^(select|with)\b/i.test(normalized)) {
    throw new ToolError("Only SELECT or WITH queries are allowed.");
  }
  const guardTokens = tokenizeSqlForGuard(normalized);
  assertNoRuntimeScopeMutation(guardTokens);
  assertNoDangerousReadonlyFunctions(guardTokens);
  assertNoModelCallTraceTableAccess(guardTokens);

  return normalized;
}

type TruncationReason = "row_cap" | "output_cap" | "cell_cap";

interface SanitizeState {
  readonly reasons: Set<TruncationReason>;
}

function markTruncation(state: SanitizeState, reason: TruncationReason): void {
  state.reasons.add(reason);
}

function byteLengthOf(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}

function summarizeLargeValue(bytes: number): string {
  return `<jsonb ${bytes}B omitted; query specific fields>`;
}

function sanitizeCell(value: unknown, maxStringChars: number, state: SanitizeState): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    if (value.length > maxStringChars) {
      markTruncation(state, "cell_cap");
    }
    return truncateText(value, maxStringChars);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    const bytes = byteLengthOf(value);
    if (bytes !== null && bytes > MAX_CELL_BYTES) {
      markTruncation(state, "cell_cap");
      return summarizeLargeValue(bytes);
    }

    return value.map((item) => sanitizeCell(item, maxStringChars, state));
  }

  if (isRecord(value)) {
    const looksLikeImageBlock = value.type === "image" && typeof value.data === "string";
    const bytes = byteLengthOf(value);
    if (bytes !== null && bytes > MAX_CELL_BYTES && !looksLikeImageBlock) {
      markTruncation(state, "cell_cap");
      return summarizeLargeValue(bytes);
    }

    if (looksLikeImageBlock) {
      const omittedBytes = (value.data as string).length;
      markTruncation(state, "cell_cap");
      const sanitized: JsonObject = {};
      for (const [key, nested] of Object.entries(value)) {
        if (key === "data") {
          continue;
        }
        sanitized[key] = sanitizeCell(nested, maxStringChars, state);
      }
      sanitized.data = `[omitted image data: ${omittedBytes} chars]`;
      return sanitized;
    }

    return sanitizeRow(value, maxStringChars, state);
  }

  markTruncation(state, "cell_cap");
  return truncateText(String(value), maxStringChars);
}

function sanitizeRow(row: Record<string, unknown>, maxStringChars: number, state: SanitizeState): JsonObject {
  const sanitized: JsonObject = {};
  for (const [key, value] of Object.entries(row)) {
    sanitized[key] = sanitizeCell(value, maxStringChars, state);
  }
  return sanitized;
}

function sanitizeRows(rows: readonly unknown[], maxStringChars: number, state: SanitizeState): JsonObject[] {
  return rows.map((row) => {
    if (!isRecord(row)) {
      throw new ToolError("Postgres returned a non-object row.");
    }

    return sanitizeRow(row, maxStringChars, state);
  });
}

function fitRowsToByteBudget(
  rows: readonly JsonObject[],
  maxBytes: number,
): { rows: readonly JsonObject[]; truncated: boolean } {
  const accepted: JsonObject[] = [];

  for (const row of rows) {
    const candidate = [...accepted, row];
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (bytes > maxBytes) {
      return {
        rows: accepted,
        truncated: true,
      };
    }

    accepted.push(row);
  }

  return {
    rows: accepted,
    truncated: false,
  };
}

function resolvePoolResolver(options: Pick<PostgresReadonlyQueryCommandOptions, "getPool" | "pool">): PgPoolResolver {
  if (options.getPool) {
    return options.getPool;
  }
  if (options.pool) {
    const pool = options.pool;
    return () => pool;
  }

  throw new Error("Postgres readonly query command requires either pool or getPool.");
}

function buildExecutionOptions(options: PostgresReadonlyQueryCommandOptions): PostgresReadonlyQueryExecutionOptions {
  return {
    getPool: resolvePoolResolver(options),
    maxRows: Math.min(options.maxRows ?? MAX_ROWS, MAX_ROWS),
    maxOutputBytes: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    maxStringChars: options.maxStringChars ?? MAX_STRING_CHARS,
  };
}

async function executePostgresReadonlyQuery(
  options: PostgresReadonlyQueryExecutionOptions,
  input: PostgresReadonlyQueryExecutionInput,
): Promise<JsonObject> {
  const sql = assertReadonlySql(input.sql);
  const requestedMaxRows = input.maxRows ?? options.maxRows;
  const maxRows = Math.min(requestedMaxRows, options.maxRows);
  const maxRowsCapped = requestedMaxRows !== maxRows;
  const limitedSql = `SELECT * FROM (${sql}) AS runtime_readonly_query LIMIT ${maxRows + 1}`;
  const pool = await options.getPool();
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_TX_TIMEOUT_MS}ms'`);
    await client.query("SELECT set_config('runtime.session_id', $1, true)", [input.sessionId]);
    await client.query("SELECT set_config('runtime.agent_key', $1, true)", [input.agentKey]);
    await client.query("SELECT set_config('runtime.skill_policy', $1, true)", [input.skillPolicy.mode]);
    await client.query("SELECT set_config('runtime.skill_allowlist', $1, true)", [
      input.skillPolicy.mode === "allowlist" ? input.skillPolicy.skillKeys.join(",") : "",
    ]);

    const result = await client.query(limitedSql);
    await client.query("COMMIT");

    const sanitizeState: SanitizeState = {
      reasons: new Set<TruncationReason>(),
    };
    const sanitizedRows = sanitizeRows(result.rows, options.maxStringChars, sanitizeState);
    const rowTruncated = sanitizedRows.length > maxRows;
    const cappedRows = sanitizedRows.slice(0, maxRows);
    const { rows, truncated: byteTruncated } = fitRowsToByteBudget(cappedRows, options.maxOutputBytes);
    if (rowTruncated) {
      markTruncation(sanitizeState, "row_cap");
    }
    if (byteTruncated) {
      markTruncation(sanitizeState, "output_cap");
    }
    const truncationReasons = [...sanitizeState.reasons];

    return {
      operation: "query",
      requestedMaxRows,
      maxRows,
      maxRowsCapped,
      rowCount: Math.min(result.rows.length, maxRows),
      truncated: truncationReasons.length > 0,
      truncationReasons,
      elapsedMs: Date.now() - startedAt,
      rows: [...rows],
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures after the original query error.
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Postgres query failed: ${message}`);
  } finally {
    client.release();
  }
}

type ParsedReadonlyQueryCommandInput =
  | {schemaHelp: true}
  | {sql: string; maxRows?: number};

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
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

function parseReadonlyQueryCommandInput(input: unknown): ParsedReadonlyQueryCommandInput {
  if (!isRecord(input)) {
    throw new Error("postgres.readonly.query input must be a JSON object.");
  }
  for (const key of Object.keys(input)) {
    if (key !== "sql" && key !== "maxRows" && key !== "schemaHelp") {
      throw new Error(`postgres.readonly.query does not accept ${key}.`);
    }
  }
  const schemaHelp = readOptionalBoolean(input.schemaHelp, "postgres.readonly.query schemaHelp") ?? false;
  const maxRows = readOptionalPositiveInteger(input.maxRows, "postgres.readonly.query maxRows");
  if (schemaHelp) {
    if (input.sql !== undefined || maxRows !== undefined) {
      throw new Error("postgres.readonly.query schemaHelp cannot be combined with sql or maxRows.");
    }

    return {schemaHelp: true};
  }
  if (typeof input.sql !== "string" || input.sql.trim().length === 0) {
    throw new Error("postgres.readonly.query sql must not be empty.");
  }

  return {
    sql: input.sql,
    ...(maxRows === undefined ? {} : {maxRows}),
  };
}

export const postgresReadonlyQueryCommandDescriptor: CommandDescriptor = {
  name: POSTGRES_READONLY_QUERY_COMMAND_NAME,
  summary: "Run a scoped read-only Postgres query.",
  description: `Runs one SELECT or WITH query through the scoped readonly session views. ${READONLY_VIEW_GUIDANCE}`,
  usage: "panda postgres readonly query (--sql <text|@file|@-> [--max-rows <n>]|--schema-help)",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    POSTGRES_SQL_ARGUMENT,
    {
      name: "max-rows",
      description: `Maximum rows to return, 1-${MAX_ROWS}. Larger values are safely capped to ${MAX_ROWS}.`,
      valueType: "number",
      valueName: "n",
      minimum: 1,
      maximum: MAX_ROWS,
    },
    {
      name: "schema-help",
      description: "Introspect the live scoped readonly views, columns, PostgreSQL types, and executable query examples.",
      valueType: "boolean",
    },
    POSTGRES_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Read recent session messages",
      command: "panda postgres readonly query --sql 'select id, role from session.messages order by created_at desc limit 5'",
    },
    {
      description: "Read SQL from stdin",
      command: "cat query.sql | panda postgres readonly query --sql @-",
    },
    {
      description: "Inspect available readonly views",
      command: "panda postgres readonly query --schema-help",
    },
    {
      description: "Use JSON input",
      command: "panda postgres readonly query --json '{\"sql\":\"select count(*) from session.messages\"}'",
    },
  ],
  requiredCapabilities: [POSTGRES_READONLY_QUERY_COMMAND_NAME],
  resultShape: {
    operation: "query|schema_help",
    requestedMaxRows: "number|absent for schema_help",
    maxRows: "number|absent for schema_help",
    maxRowsCapped: "boolean|absent for schema_help",
    rowCount: "number",
    truncated: "boolean",
    truncationReasons: ["string"],
    elapsedMs: "number",
    rows: ["object"],
    views: [{name: "string", columns: [{name: "string", type: "string"}]}],
    examples: [{description: "string", sql: "string"}],
  },
};

export function createPostgresReadonlyQueryCommand(
  options: PostgresReadonlyQueryCommandOptions,
): RegisteredCommand {
  const execution = buildExecutionOptions(options);
  return {
    descriptor: postgresReadonlyQueryCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseReadonlyQueryCommandInput(request.input);
      if ("schemaHelp" in input) {
        return {
          ok: true,
          command: POSTGRES_READONLY_QUERY_COMMAND_NAME,
          output: await buildReadonlySchemaHelp(execution.getPool),
          summary: "Returned readonly Postgres schema help.",
        };
      }
      const output = await executePostgresReadonlyQuery(execution, {
        sql: input.sql,
        sessionId: request.scope.sessionId,
        agentKey: request.scope.agentKey,
        skillPolicy: request.scope.skillPolicy ?? {mode: "all_agent"},
        maxRows: input.maxRows,
      });

      return {
        ok: true,
        command: POSTGRES_READONLY_QUERY_COMMAND_NAME,
        output,
        summary: `Returned ${output.rowCount} readonly Postgres row${output.rowCount === 1 ? "" : "s"}.`,
      };
    },
  };
}
