import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { Tool } from "../../agent-core/tool.js";
import { ToolError } from "../../agent-core/exceptions.js";
import type { RunContext } from "../../agent-core/run-context.js";
import type { JsonObject, JsonValue, ToolResultPayload } from "../../agent-core/types.js";
import type { ReadonlyChatViewNames } from "../../thread-runtime/postgres-readonly.js";
import type { PandaSessionContext } from "../types.js";

const MAX_ROWS = 100;
const MAX_OUTPUT_BYTES = 64_000;
const MAX_STRING_CHARS = 4_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 500;
const IDLE_TX_TIMEOUT_MS = 5_000;

interface PgPoolLike {
  connect(): Promise<PoolClient>;
}

export interface PostgresReadonlyQueryToolOptions {
  pool: PgPoolLike;
  viewNames?: Partial<ReadonlyChatViewNames>;
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

function sanitizeValue(value: unknown, maxStringChars: number): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return truncateText(value, maxStringChars);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, maxStringChars));
  }

  if (isRecord(value)) {
    const looksLikeImageBlock = value.type === "image" && typeof value.data === "string";
    if (looksLikeImageBlock) {
      const omittedBytes = (value.data as string).length;
      return {
        ...Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "data")
            .map(([key, nested]) => [key, sanitizeValue(nested, maxStringChars)]),
        ),
        data: `[omitted image data: ${omittedBytes} chars]`,
      } satisfies JsonObject;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sanitizeValue(nested, maxStringChars)]),
    ) as JsonObject;
  }

  return truncateText(String(value), maxStringChars);
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

function readScope(context: unknown): { agentKey: string } {
  if (!isRecord(context) || typeof context.agentKey !== "string" || !context.agentKey.trim()) {
    throw new ToolError("The readonly Postgres tool is only available inside a persisted Panda thread.");
  }

  return {
    agentKey: context.agentKey,
  };
}

export class PostgresReadonlyQueryTool<TContext = PandaSessionContext>
  extends Tool<typeof PostgresReadonlyQueryTool.schema, TContext> {
  static schema = z.object({
    sql: z.string().trim().min(1).describe(
      "A single read-only SELECT or WITH query. Prefer the filtered views panda_threads, panda_messages, panda_inputs, and panda_runs. If you need to inspect available columns first, query information_schema.columns.",
    ),
  });

  name = "postgres_readonly_query";
  description =
    "Run a single read-only SQL query against Postgres. Use only SELECT or WITH. Prefer querying the filtered views panda_threads, panda_messages, panda_inputs, and panda_runs; those views are already limited to the current agent key. If you need schema help, query information_schema.columns. Always prefer small queries with ORDER BY and LIMIT.";
  schema = PostgresReadonlyQueryTool.schema;

  private readonly pool: PgPoolLike;
  private readonly viewNames: ReadonlyChatViewNames;
  private readonly maxRows: number;
  private readonly maxOutputBytes: number;
  private readonly maxStringChars: number;

  constructor(options: PostgresReadonlyQueryToolOptions) {
    super();
    this.pool = options.pool;
    this.viewNames = {
      threads: options.viewNames?.threads ?? "panda_threads",
      messages: options.viewNames?.messages ?? "panda_messages",
      inputs: options.viewNames?.inputs ?? "panda_inputs",
      runs: options.viewNames?.runs ?? "panda_runs",
    };
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
    const { agentKey } = readScope(run.context);
    const sql = assertReadonlySql(args.sql);
    const client = await this.pool.connect();
    const startedAt = Date.now();

    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_TX_TIMEOUT_MS}ms'`);
      await client.query("SELECT set_config('panda.agent_key', $1, true)", [agentKey]);

      const result = await client.query(sql);
      await client.query("COMMIT");

      const sanitizedRows = result.rows.map((row) => sanitizeValue(row, this.maxStringChars) as JsonObject);
      const rowTruncated = sanitizedRows.length > this.maxRows;
      const cappedRows = sanitizedRows.slice(0, this.maxRows);
      const { rows, truncated: byteTruncated } = fitRowsToByteBudget(cappedRows, this.maxOutputBytes);

      const payload: JsonObject = {
        sql,
        rowCount: rows.length,
        truncated: rowTruncated || byteTruncated,
        truncationReasons: [
          ...(rowTruncated ? ["row_cap"] : []),
          ...(byteTruncated ? ["output_cap"] : []),
        ],
        elapsedMs: Date.now() - startedAt,
        views: {
          threads: this.viewNames.threads,
          messages: this.viewNames.messages,
          inputs: this.viewNames.inputs,
          runs: this.viewNames.runs,
        },
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
