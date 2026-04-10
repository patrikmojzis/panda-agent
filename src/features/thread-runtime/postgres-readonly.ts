import type { Pool } from "pg";

import { buildIdentityTableNames } from "../identity/postgres-shared.js";
import {
  buildPrefixedRelationNames,
  buildThreadRuntimeTableNames,
  quoteIdentifier,
} from "./postgres-shared.js";

interface PgQueryable {
  query: Pool["query"];
}

export interface ReadonlyChatViewNames {
  threads: string;
  messages: string;
  messagesRaw: string;
  toolResults: string;
  inputs: string;
  runs: string;
}

export interface EnsureReadonlyChatQuerySchemaOptions {
  queryable: PgQueryable;
  tablePrefix?: string;
  readonlyRole?: string | null;
  viewPrefix?: string;
}

export function readDatabaseUsername(databaseUrl: string): string | null {
  try {
    const parsed = new URL(databaseUrl);
    return parsed.username ? decodeURIComponent(parsed.username) : null;
  } catch {
    return null;
  }
}

export async function ensureReadonlyChatQuerySchema(
  options: EnsureReadonlyChatQuerySchemaOptions,
): Promise<ReadonlyChatViewNames> {
  const tables = buildThreadRuntimeTableNames(options.tablePrefix ?? "thread_runtime");
  const identityTables = buildIdentityTableNames(options.tablePrefix ?? "thread_runtime");
  const { threads, messages, messagesRaw, toolResults, inputs, runs } = buildPrefixedRelationNames(
    options.viewPrefix ?? "panda",
    {
      threads: "threads",
      messages: "messages",
      messagesRaw: "messages_raw",
      toolResults: "tool_results",
      inputs: "inputs",
      runs: "runs",
    },
  );
  const views: ReadonlyChatViewNames = {
    threads,
    messages,
    messagesRaw,
    toolResults,
    inputs,
    runs,
  };
  const messageTextSql = `
    CASE
      WHEN jsonb_typeof(m.message->'content') = 'string' THEN m.message->>'content'
      WHEN jsonb_typeof(m.message->'content') = 'array' THEN (
        SELECT string_agg(block->>'text', E'\\n')
        FROM jsonb_array_elements(m.message->'content') AS block
        WHERE block->>'type' = 'text'
      )
      ELSE NULL
    END
  `;
  const inputTextSql = `
    CASE
      WHEN jsonb_typeof(i.message->'content') = 'string' THEN i.message->>'content'
      WHEN jsonb_typeof(i.message->'content') = 'array' THEN (
        SELECT string_agg(block->>'text', E'\\n')
        FROM jsonb_array_elements(i.message->'content') AS block
        WHERE block->>'type' = 'text'
      )
      ELSE NULL
    END
  `;
  const threadScopeSql = `
    t.identity_id = current_setting('panda.identity_id', true)
    AND t.agent_key = current_setting('panda.agent_key', true)
  `;

  await options.queryable.query(`
    DROP VIEW IF EXISTS ${views.toolResults};
    DROP VIEW IF EXISTS ${views.messages};
    DROP VIEW IF EXISTS ${views.messagesRaw};
    DROP VIEW IF EXISTS ${views.inputs};
    DROP VIEW IF EXISTS ${views.runs};
    DROP VIEW IF EXISTS ${views.threads};

    CREATE VIEW ${views.threads}
    WITH (security_barrier = true) AS
    SELECT
      t.id,
      t.identity_id,
      identity.handle AS identity_handle,
      t.agent_key,
      t.system_prompt,
      t.max_turns,
      t.context,
      t.max_input_tokens,
      t.prompt_cache_key,
      t.provider,
      t.model,
      t.temperature,
      t.thinking,
      t.created_at,
      t.updated_at,
      COALESCE((
        SELECT COUNT(*)::INTEGER
        FROM ${tables.messages} AS m
        WHERE m.thread_id = t.id
      ), 0) AS message_count,
      COALESCE((
        SELECT COUNT(*)::INTEGER
        FROM ${tables.inputs} AS i
        WHERE i.thread_id = t.id AND i.applied_at IS NULL
      ), 0) AS pending_input_count,
      (
        SELECT MAX(m.created_at)
        FROM ${tables.messages} AS m
        WHERE m.thread_id = t.id
      ) AS last_message_at
    FROM ${tables.threads} AS t
    INNER JOIN ${identityTables.identities} AS identity ON identity.id = t.identity_id
    WHERE ${threadScopeSql};

    CREATE VIEW ${views.messagesRaw}
    WITH (security_barrier = true) AS
    SELECT
      m.id,
      m.thread_id,
      m.sequence,
      m.origin,
      m.source,
      m.channel_id,
      m.external_message_id,
      m.actor_id,
      m.run_id,
      m.created_at,
      m.message,
      m.message->>'role' AS role,
      COALESCE(m.message->>'toolName', NULL) AS tool_name,
      ${messageTextSql} AS text,
      CASE
        WHEN jsonb_typeof(m.message->'content') = 'array' THEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements(m.message->'content') AS block
          WHERE block->>'type' = 'image'
        )
        ELSE FALSE
      END AS has_images
    FROM ${tables.messages} AS m
    INNER JOIN ${tables.threads} AS t ON t.id = m.thread_id
    WHERE ${threadScopeSql};

    CREATE VIEW ${views.messages}
    WITH (security_barrier = true) AS
    SELECT
      raw.id,
      raw.thread_id,
      raw.sequence,
      raw.origin,
      raw.source,
      raw.channel_id,
      raw.external_message_id,
      raw.actor_id,
      raw.run_id,
      raw.created_at,
      raw.role,
      CASE
        WHEN raw.text IS NOT NULL THEN raw.text
        WHEN raw.role = 'assistant' AND jsonb_typeof(raw.message->'content') = 'array' THEN (
          SELECT string_agg('[tool call: ' || COALESCE(block->>'name', 'unknown') || ']', E'\\n')
          FROM jsonb_array_elements(raw.message->'content') AS block
          WHERE block->>'type' = 'toolCall'
        )
        ELSE NULL
      END AS text,
      raw.has_images
    FROM ${views.messagesRaw} AS raw
    WHERE raw.role IN ('user', 'assistant');

    CREATE VIEW ${views.toolResults}
    WITH (security_barrier = true) AS
    SELECT
      raw.id,
      raw.thread_id,
      raw.sequence,
      raw.source,
      raw.run_id,
      raw.created_at,
      COALESCE(raw.tool_name, 'unknown') AS tool_name,
      COALESCE((raw.message->>'isError')::BOOLEAN, false) AS is_error,
      CASE
        WHEN raw.text IS NULL OR btrim(raw.text) = '' THEN '[tool result: ' || COALESCE(raw.tool_name, 'unknown') || ']'
        ELSE left(raw.text, 500)
      END AS result_preview,
      octet_length(convert_to(COALESCE(raw.text, ''), 'utf8'))::INTEGER AS result_bytes,
      raw.has_images
    FROM ${views.messagesRaw} AS raw
    WHERE raw.role = 'toolResult';

    CREATE VIEW ${views.inputs}
    WITH (security_barrier = true) AS
    SELECT
      i.id,
      i.thread_id,
      i.input_order,
      i.delivery_mode,
      i.source,
      i.channel_id,
      i.external_message_id,
      i.actor_id,
      i.created_at,
      i.applied_at,
      i.message,
      i.message->>'role' AS role,
      ${inputTextSql} AS text,
      CASE
        WHEN jsonb_typeof(i.message->'content') = 'array' THEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements(i.message->'content') AS block
          WHERE block->>'type' = 'image'
        )
        ELSE FALSE
      END AS has_images
    FROM ${tables.inputs} AS i
    INNER JOIN ${tables.threads} AS t ON t.id = i.thread_id
    WHERE ${threadScopeSql};

    CREATE VIEW ${views.runs}
    WITH (security_barrier = true) AS
    SELECT
      r.id,
      r.thread_id,
      r.status,
      r.started_at,
      r.finished_at,
      r.abort_requested_at,
      r.abort_reason,
      r.error
    FROM ${tables.runs} AS r
    INNER JOIN ${tables.threads} AS t ON t.id = r.thread_id
    WHERE ${threadScopeSql};
  `);

  if (options.readonlyRole) {
    const readonlyRole = quoteIdentifier(options.readonlyRole);
    await options.queryable.query(`
      GRANT USAGE ON SCHEMA public TO ${readonlyRole};
      GRANT SELECT ON ${views.threads}, ${views.messages}, ${views.messagesRaw}, ${views.toolResults}, ${views.inputs}, ${views.runs} TO ${readonlyRole};
    `);
  }

  return views;
}
