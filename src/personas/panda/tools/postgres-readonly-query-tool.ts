import type {PoolClient} from "pg";
import {z} from "zod";

import {Tool} from "../../../kernel/agent/tool.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {RunContext} from "../../../kernel/agent/run-context.js";
import type {JsonObject, JsonValue, ToolResultPayload} from "../../../kernel/agent/types.js";
import type {PandaSessionContext} from "../types.js";

const MAX_ROWS = 50;
const MAX_OUTPUT_BYTES = 32_000;
const MAX_CELL_BYTES = 4_000;
const MAX_STRING_CHARS = 4_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 500;
const IDLE_TX_TIMEOUT_MS = 5_000;

interface PgPoolLike {
  connect(): Promise<PoolClient>;
}

export interface PostgresReadonlyQueryToolOptions {
  pool: PgPoolLike;
  maxRows?: number;
  maxOutputBytes?: number;
  maxStringChars?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimSql(value: string): string {
  return value.trim().replace(/;+$/, "").trim();
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

  return normalized;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
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
      return {
        ...Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "data")
            .map(([key, nested]) => [key, sanitizeCell(nested, maxStringChars, state)]),
        ),
        data: `[omitted image data: ${omittedBytes} chars]`,
      } satisfies JsonObject;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sanitizeCell(nested, maxStringChars, state)]),
    ) as JsonObject;
  }

  markTruncation(state, "cell_cap");
  return truncateText(String(value), maxStringChars);
}

function sanitizeRow(row: Record<string, unknown>, maxStringChars: number, state: SanitizeState): JsonObject {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, sanitizeCell(value, maxStringChars, state)]),
  ) as JsonObject;
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

function readScope(context: unknown): { identityId: string; agentKey: string } {
  if (
    !isRecord(context)
    || typeof context.identityId !== "string"
    || !context.identityId.trim()
    || typeof context.agentKey !== "string"
    || !context.agentKey.trim()
  ) {
    throw new ToolError(
      "The readonly Postgres tool requires both identityId and agentKey in the persisted Panda thread context.",
    );
  }

  return {
    identityId: context.identityId,
    agentKey: context.agentKey,
  };
}

export class PostgresReadonlyQueryTool<TContext = PandaSessionContext>
  extends Tool<typeof PostgresReadonlyQueryTool.schema, TContext> {
  static schema = z.object({
    sql: z.string().trim().min(1).describe(
      "A single read-only SELECT or WITH query. Prefer panda_messages for user and assistant chat turns, panda_tool_results for tool output, panda_threads for thread metadata, panda_agent_skills for stored skill bodies, panda_scheduled_tasks for scheduled jobs, panda_scheduled_task_runs for execution history, and panda_messages_raw only when you truly need raw JSONB. Large skill bodies may need substring(...) or targeted column selection. If you need schema help, query information_schema.columns.",
    ),
  });

  name = "postgres_readonly_query";
  description =
    "Run a single read-only SQL query against Postgres. Use only SELECT or WITH. Prefer panda_messages for the human conversation, panda_tool_results for tool output, panda_threads for thread metadata, panda_agent_skills for stored skill bodies, panda_scheduled_tasks for scheduled jobs, panda_scheduled_task_runs for execution history, and panda_messages_raw only when you need raw JSONB. Large skill bodies may need substring(...) or targeted column selection. Query information_schema.columns if you need schema help. Always use LIMIT on exploratory queries.";
  schema = PostgresReadonlyQueryTool.schema;

  private readonly pool: PgPoolLike;
  private readonly maxRows: number;
  private readonly maxOutputBytes: number;
  private readonly maxStringChars: number;

  constructor(options: PostgresReadonlyQueryToolOptions) {
    super();
    this.pool = options.pool;
    this.maxRows = options.maxRows ?? MAX_ROWS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.maxStringChars = options.maxStringChars ?? MAX_STRING_CHARS;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.sql === "string" ? truncateText(args.sql, 160) : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof PostgresReadonlyQueryTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const { identityId, agentKey } = readScope(run.context);
    const sql = assertReadonlySql(args.sql);
    const limitedSql = `SELECT * FROM (${sql}) AS panda_readonly_query LIMIT ${this.maxRows + 1}`;
    const client = await this.pool.connect();
    const startedAt = Date.now();

    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_TX_TIMEOUT_MS}ms'`);
      await client.query("SELECT set_config('panda.identity_id', $1, true)", [identityId]);
      await client.query("SELECT set_config('panda.agent_key', $1, true)", [agentKey]);

      const result = await client.query(limitedSql);
      await client.query("COMMIT");

      const sanitizeState: SanitizeState = {
        reasons: new Set<TruncationReason>(),
      };
      const sanitizedRows = result.rows.map((row) => sanitizeRow(row as Record<string, unknown>, this.maxStringChars, sanitizeState));
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

      return {
        content: [{
          type: "text",
          text: JSON.stringify(payload, null, 2),
        }],
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
}
