import type {Pool} from "pg";

import {buildAgentTableNames} from "../../agents/postgres-shared.js";
import {buildIdentityTableNames} from "../../../domain/identity/postgres-shared.js";
import {buildScheduledTaskTableNames} from "../../../domain/scheduling/tasks/postgres-shared.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import {buildWatchTableNames} from "../../../domain/watches/postgres-shared.js";
import {buildPrefixedRelationNames, buildThreadRuntimeTableNames, quoteIdentifier,} from "./postgres-shared.js";

interface PgQueryable {
  query: Pool["query"];
}

export interface ReadonlyChatViewNames {
  sessions: string;
  threads: string;
  messages: string;
  messagesRaw: string;
  toolResults: string;
  inputs: string;
  runs: string;
  agentSkills: string;
  scheduledTasks: string;
  scheduledTaskRuns: string;
  watches: string;
  watchRuns: string;
  watchEvents: string;
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
    if (parsed.username) {
      return decodeURIComponent(parsed.username);
    }

    const queryUser = parsed.searchParams.get("user") ?? parsed.searchParams.get("username");
    return queryUser ? decodeURIComponent(queryUser) : null;
  } catch {
    return null;
  }
}

export async function ensureReadonlyChatQuerySchema(
  options: EnsureReadonlyChatQuerySchemaOptions,
): Promise<ReadonlyChatViewNames> {
  const tables = buildThreadRuntimeTableNames(options.tablePrefix ?? "thread_runtime");
  const agentTables = buildAgentTableNames(options.tablePrefix ?? "thread_runtime");
  const identityTables = buildIdentityTableNames(options.tablePrefix ?? "thread_runtime");
  const sessionTables = buildSessionTableNames(options.tablePrefix ?? "thread_runtime");
  const scheduledTaskTables = buildScheduledTaskTableNames(options.tablePrefix ?? "thread_runtime");
  const watchTables = buildWatchTableNames(options.tablePrefix ?? "thread_runtime");
  const { sessions, threads, messages, messagesRaw, toolResults, inputs, runs, agentSkills, scheduledTasks, scheduledTaskRuns, watches, watchRuns, watchEvents } = buildPrefixedRelationNames(
    options.viewPrefix ?? "panda",
    {
      sessions: "sessions",
      threads: "threads",
      messages: "messages",
      messagesRaw: "messages_raw",
      toolResults: "tool_results",
      inputs: "inputs",
      runs: "runs",
      agentSkills: "agent_skills",
      scheduledTasks: "scheduled_tasks",
      scheduledTaskRuns: "scheduled_task_runs",
      watches: "watches",
      watchRuns: "watch_runs",
      watchEvents: "watch_events",
    },
  );
  const views: ReadonlyChatViewNames = {
    sessions,
    threads,
    messages,
    messagesRaw,
    toolResults,
    inputs,
    runs,
    agentSkills,
    scheduledTasks,
    scheduledTaskRuns,
    watches,
    watchRuns,
    watchEvents,
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
  const sessionScopeSql = `t.session_id = current_setting('panda.session_id', true)`;
  const activeSessionSql = `
    SELECT *
    FROM ${sessionTables.sessions}
    WHERE id = current_setting('panda.session_id', true)
    LIMIT 1
  `;

  await options.queryable.query(`
    DROP VIEW IF EXISTS ${views.watchEvents};
    DROP VIEW IF EXISTS ${views.watchRuns};
    DROP VIEW IF EXISTS ${views.watches};
    DROP VIEW IF EXISTS ${views.agentSkills};
    DROP VIEW IF EXISTS ${views.scheduledTaskRuns};
    DROP VIEW IF EXISTS ${views.scheduledTasks};
    DROP VIEW IF EXISTS ${views.toolResults};
    DROP VIEW IF EXISTS ${views.messages};
    DROP VIEW IF EXISTS ${views.messagesRaw};
    DROP VIEW IF EXISTS ${views.inputs};
    DROP VIEW IF EXISTS ${views.runs};
    DROP VIEW IF EXISTS ${views.threads};
    DROP VIEW IF EXISTS ${views.sessions};

    CREATE VIEW ${views.sessions}
    WITH (security_barrier = true) AS
    SELECT
      s.id,
      s.agent_key,
      s.kind,
      s.current_thread_id,
      s.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      s.metadata,
      s.created_at,
      s.updated_at
    FROM (${activeSessionSql}) AS s
    LEFT JOIN ${identityTables.identities} AS creator
      ON creator.id = s.created_by_identity_id;

    CREATE VIEW ${views.threads}
    WITH (security_barrier = true) AS
    SELECT
      t.id,
      t.session_id,
      session.agent_key,
      session.kind AS session_kind,
      t.system_prompt,
      t.max_turns,
      t.context,
      t.inference_projection,
      t.max_input_tokens,
      t.prompt_cache_key,
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
    INNER JOIN ${sessionTables.sessions} AS session ON session.id = t.session_id
    WHERE ${sessionScopeSql};

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
      m.identity_id,
      speaker.handle AS identity_handle,
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
    LEFT JOIN ${identityTables.identities} AS speaker ON speaker.id = m.identity_id
    WHERE ${sessionScopeSql};

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
      raw.identity_id,
      raw.identity_handle,
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
      i.identity_id,
      speaker.handle AS identity_handle,
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
    LEFT JOIN ${identityTables.identities} AS speaker ON speaker.id = i.identity_id
    WHERE ${sessionScopeSql};

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
    WHERE ${sessionScopeSql};

    CREATE VIEW ${views.agentSkills}
    WITH (security_barrier = true) AS
    SELECT
      skill.agent_key,
      skill.skill_key,
      skill.description,
      skill.content,
      octet_length(convert_to(skill.content, 'utf8'))::INTEGER AS content_bytes,
      skill.created_at,
      skill.updated_at
    FROM ${agentTables.agentSkills} AS skill
    WHERE skill.agent_key = current_setting('panda.agent_key', true);

    CREATE VIEW ${views.scheduledTasks}
    WITH (security_barrier = true) AS
    SELECT
      st.id,
      st.session_id,
      st.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      st.title,
      st.instruction,
      st.schedule_kind,
      st.run_at,
      st.deliver_at,
      st.cron_expr,
      st.timezone,
      active_session.current_thread_id AS resolved_thread_id,
      st.enabled,
      CASE
        WHEN st.cancelled_at IS NOT NULL THEN 'cancelled'
        WHEN st.claimed_at IS NOT NULL AND (st.claim_expires_at IS NULL OR st.claim_expires_at > NOW()) THEN 'running'
        WHEN st.completed_at IS NOT NULL AND (
          SELECT task_run.status
          FROM ${scheduledTaskTables.scheduledTaskRuns} AS task_run
          WHERE task_run.task_id = st.id
          ORDER BY task_run.created_at DESC
          LIMIT 1
        ) = 'failed' THEN 'failed'
        WHEN st.completed_at IS NOT NULL THEN 'completed'
        ELSE 'scheduled'
      END AS status,
      st.next_fire_at,
      st.next_fire_kind,
      st.claimed_at,
      st.claimed_by,
      st.claim_expires_at,
      st.completed_at,
      st.cancelled_at,
      st.created_at,
      st.updated_at
    FROM ${scheduledTaskTables.scheduledTasks} AS st
    INNER JOIN (${activeSessionSql}) AS active_session ON active_session.id = st.session_id
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = st.created_by_identity_id;

    CREATE VIEW ${views.scheduledTaskRuns}
    WITH (security_barrier = true) AS
    SELECT
      run.id,
      run.task_id,
      run.session_id,
      run.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      run.resolved_thread_id,
      run.fire_kind,
      run.scheduled_for,
      run.status,
      run.thread_run_id,
      run.delivery_status,
      run.error,
      run.created_at,
      run.started_at,
      run.finished_at
    FROM ${scheduledTaskTables.scheduledTaskRuns} AS run
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = run.created_by_identity_id
    WHERE run.session_id = current_setting('panda.session_id', true);

    CREATE VIEW ${views.watches}
    WITH (security_barrier = true) AS
    SELECT
      watch.id,
      watch.session_id,
      watch.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      watch.title,
      watch.interval_minutes,
      active_session.current_thread_id AS resolved_thread_id,
      watch.source_config,
      watch.detector_config,
      watch.enabled,
      watch.next_poll_at,
      watch.claimed_at,
      watch.claimed_by,
      watch.claim_expires_at,
      watch.cooldown_until,
      watch.last_error,
      watch.state,
      watch.disabled_at,
      watch.created_at,
      watch.updated_at
    FROM ${watchTables.watches} AS watch
    INNER JOIN (${activeSessionSql}) AS active_session ON active_session.id = watch.session_id
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = watch.created_by_identity_id;

    CREATE VIEW ${views.watchRuns}
    WITH (security_barrier = true) AS
    SELECT
      run.id,
      run.watch_id,
      run.session_id,
      run.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      run.scheduled_for,
      run.status,
      run.resolved_thread_id,
      run.emitted_event_id,
      run.error,
      run.created_at,
      run.started_at,
      run.finished_at
    FROM ${watchTables.watchRuns} AS run
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = run.created_by_identity_id
    WHERE run.session_id = current_setting('panda.session_id', true);

    CREATE VIEW ${views.watchEvents}
    WITH (security_barrier = true) AS
    SELECT
      event.id,
      event.watch_id,
      event.session_id,
      event.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      event.resolved_thread_id,
      event.event_kind,
      event.summary,
      event.dedupe_key,
      event.payload,
      event.created_at
    FROM ${watchTables.watchEvents} AS event
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = event.created_by_identity_id
    WHERE event.session_id = current_setting('panda.session_id', true);
  `);

  if (options.readonlyRole) {
    const readonlyRole = quoteIdentifier(options.readonlyRole);
    await options.queryable.query(`
      GRANT USAGE ON SCHEMA public TO ${readonlyRole};
      GRANT SELECT ON ${views.sessions}, ${views.threads}, ${views.messages}, ${views.messagesRaw}, ${views.toolResults}, ${views.inputs}, ${views.runs}, ${views.agentSkills}, ${views.scheduledTasks}, ${views.scheduledTaskRuns}, ${views.watches}, ${views.watchRuns}, ${views.watchEvents} TO ${readonlyRole};
    `);
  }

  return views;
}
