import {z} from "zod";

import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import type {JsonObject, JsonValue} from "../../lib/json.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {readExecutionSkillPolicy} from "../../domain/execution-environments/policy.js";
import {isRecord} from "../../lib/records.js";
import {truncateText} from "../../lib/strings.js";
import {buildJsonToolPayload, readRequiredAgentSessionToolScope} from "./shared.js";

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
  "The readonly tool already scopes session.threads, session.messages, session.tool_results, session.inputs, session.runs, session.todos, session.scheduled_tasks, session.scheduled_task_runs, session.watches, session.watch_runs, and session.watch_events to the current session.",
  "The readonly tool also scopes session.agent_prompts, session.agent_pairings, and session.agent_skills to the current agent.",
  "Do not invent is_active flags or extra session_id subqueries unless you are joining raw tables outside the session.* views.",
  "Use session.agent_prompts for agent docs, session.agent_pairings for known identities, and session.agent_skills for stored skills.",
  "For exploratory reads, prefer left(...), substring(...), regex filters, full-text search, or other narrow projections instead of pulling giant content blobs blindly.",
  "For durable session todo context, query session.todos. For session automation, query session.scheduled_tasks or session.watches directly with ORDER BY/LIMIT.",
  "Prefer session.agent_skills for stored skill bodies and session.messages_raw only when you truly need raw JSONB.",
  "Large skill bodies may need substring(...) or targeted column selection.",
  "If you need schema help, query information_schema.columns.",
].join(" ");

export interface PostgresReadonlyQueryToolOptions {
  pool?: PgPoolLike;
  getPool?: PgPoolResolver;
  usesReadonlyRole?: boolean;
  maxRows?: number;
  maxOutputBytes?: number;
  maxStringChars?: number;
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

function readScope(context: unknown): { sessionId: string; agentKey: string } {
  return readRequiredAgentSessionToolScope(
    context,
    "The readonly Postgres tool requires both sessionId and agentKey in the runtime session context.",
  );
}

function assertReadonlyToolAllowed(context: unknown, usesReadonlyRole: boolean): void {
  if (!isRecord(context) || !isRecord(context.executionEnvironment)) {
    return;
  }

  const environment = context.executionEnvironment;
  const toolPolicy = isRecord(environment.toolPolicy) ? environment.toolPolicy : {};
  const postgresReadonly = isRecord(toolPolicy.postgresReadonly)
    ? toolPolicy.postgresReadonly
    : undefined;
  if (postgresReadonly?.allowed === false) {
    throw new ToolError("Readonly Postgres is not allowed in this execution environment.");
  }
  if (environment.kind === "disposable_container" && postgresReadonly?.allowed !== true) {
    throw new ToolError("Readonly Postgres requires an explicit allow policy in disposable execution environments.");
  }
  if (environment.kind === "disposable_container" && !usesReadonlyRole) {
    throw new ToolError("Disposable execution environments require READONLY_DATABASE_URL for readonly Postgres.");
  }
}

export class PostgresReadonlyQueryTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof PostgresReadonlyQueryTool.schema, TContext> {
  static schema = z.object({
    sql: z.string().trim().min(1).describe("Single read-only SELECT or WITH query."),
  });

  name = "postgres_readonly_query";
  description = `Run a single read-only SQL query against Postgres. Use only SELECT or WITH. ${READONLY_VIEW_GUIDANCE} Always use LIMIT on exploratory queries.`;
  schema = PostgresReadonlyQueryTool.schema;

  private readonly getPool: PgPoolResolver;
  private readonly maxRows: number;
  private readonly maxOutputBytes: number;
  private readonly maxStringChars: number;
  private readonly usesReadonlyRole: boolean;

  constructor(options: PostgresReadonlyQueryToolOptions) {
    super();
    if (options.getPool) {
      this.getPool = options.getPool;
    } else if (options.pool) {
      const pool = options.pool;
      this.getPool = () => pool;
    } else {
      throw new Error("PostgresReadonlyQueryTool requires either pool or getPool.");
    }
    this.maxRows = options.maxRows ?? MAX_ROWS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.maxStringChars = options.maxStringChars ?? MAX_STRING_CHARS;
    this.usesReadonlyRole = options.usesReadonlyRole ?? false;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.sql === "string" ? truncateText(args.sql, 160) : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof PostgresReadonlyQueryTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const { sessionId, agentKey } = readScope(run.context);
    assertReadonlyToolAllowed(run.context, this.usesReadonlyRole);
    const skillPolicy = readExecutionSkillPolicy(run.context);
    const sql = assertReadonlySql(args.sql);
    const limitedSql = `SELECT * FROM (${sql}) AS runtime_readonly_query LIMIT ${this.maxRows + 1}`;
    const pool = await this.getPool();
    const client = await pool.connect();
    const startedAt = Date.now();

    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_TX_TIMEOUT_MS}ms'`);
      await client.query("SELECT set_config('runtime.session_id', $1, true)", [sessionId]);
      await client.query("SELECT set_config('runtime.agent_key', $1, true)", [agentKey]);
      await client.query("SELECT set_config('runtime.skill_policy', $1, true)", [skillPolicy.mode]);
      await client.query("SELECT set_config('runtime.skill_allowlist', $1, true)", [
        skillPolicy.mode === "allowlist" ? skillPolicy.skillKeys.join(",") : "",
      ]);

      const result = await client.query(limitedSql);
      await client.query("COMMIT");

      const sanitizeState: SanitizeState = {
        reasons: new Set<TruncationReason>(),
      };
      const sanitizedRows = sanitizeRows(result.rows, this.maxStringChars, sanitizeState);
      const rowTruncated = sanitizedRows.length > this.maxRows;
      const cappedRows = sanitizedRows.slice(0, this.maxRows);
      const { rows, truncated: byteTruncated } = fitRowsToByteBudget(cappedRows, this.maxOutputBytes);
      if (rowTruncated) {
        markTruncation(sanitizeState, "row_cap");
      }
      if (byteTruncated) {
        markTruncation(sanitizeState, "output_cap");
      }
      const truncationReasons = [...sanitizeState.reasons];

      const payload: JsonObject = {
        rowCount: Math.min(result.rows.length, this.maxRows),
        truncated: truncationReasons.length > 0,
        truncationReasons,
        elapsedMs: Date.now() - startedAt,
        rows: [...rows],
      };

      return buildJsonToolPayload(payload);
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
}
