import type {Pool} from "pg";

import {buildAgentTableNames} from "../../agents/postgres-shared.js";
import {buildIdentityTableNames} from "../../../domain/identity/postgres-shared.js";
import {buildScheduledTaskTableNames} from "../../../domain/scheduling/tasks/postgres-shared.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import {buildTelepathyTableNames} from "../../../domain/telepathy/postgres-shared.js";
import {buildWatchTableNames} from "../../../domain/watches/postgres-shared.js";
import {buildEmailTableNames} from "../../../domain/email/postgres-shared.js";
import {
    buildSessionRelationNames,
    buildThreadRuntimeTableNames,
    quoteIdentifier,
    RUNTIME_SCHEMA,
    SESSION_SCHEMA,
} from "./postgres-shared.js";

interface PgQueryable {
  query: Pool["query"];
}

export interface ReadonlySessionViewNames {
  agentSessions: string;
  threads: string;
  messages: string;
  messagesRaw: string;
  toolResults: string;
  inputs: string;
  runs: string;
  agentPrompts: string;
  agentPairings: string;
  agentSkills: string;
  agentTelepathyDevices: string;
  scheduledTasks: string;
  scheduledTaskRuns: string;
  watches: string;
  watchRuns: string;
  watchEvents: string;
  emailAccounts: string;
  emailAllowedRecipients: string;
  emailMessages: string;
  emailMessageRecipients: string;
  emailAttachments: string;
}

export interface EnsureReadonlySessionQuerySchemaOptions {
  queryable: PgQueryable;
  readonlyRole?: string | null;
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

export async function ensureReadonlySessionQuerySchema(
  options: EnsureReadonlySessionQuerySchemaOptions,
): Promise<ReadonlySessionViewNames> {
  const tables = buildThreadRuntimeTableNames();
  const agentTables = buildAgentTableNames();
  const identityTables = buildIdentityTableNames();
  const sessionTables = buildSessionTableNames();
  const telepathyTables = buildTelepathyTableNames();
  const scheduledTaskTables = buildScheduledTaskTableNames();
  const watchTables = buildWatchTableNames();
  const emailTables = buildEmailTableNames();
  const { agentSessions, threads, messages, messagesRaw, toolResults, inputs, runs, agentPrompts, agentPairings, agentSkills, agentTelepathyDevices, scheduledTasks, scheduledTaskRuns, watches, watchRuns, watchEvents, emailAccounts, emailAllowedRecipients, emailMessages, emailMessageRecipients, emailAttachments } = buildSessionRelationNames({
    agentSessions: "agent_sessions",
    threads: "threads",
    messages: "messages",
    messagesRaw: "messages_raw",
    toolResults: "tool_results",
    inputs: "inputs",
    runs: "runs",
    agentPrompts: "agent_prompts",
    agentPairings: "agent_pairings",
    agentSkills: "agent_skills",
    agentTelepathyDevices: "agent_telepathy_devices",
    scheduledTasks: "scheduled_tasks",
    scheduledTaskRuns: "scheduled_task_runs",
    watches: "watches",
    watchRuns: "watch_runs",
    watchEvents: "watch_events",
    emailAccounts: "email_accounts",
    emailAllowedRecipients: "email_allowed_recipients",
    emailMessages: "email_messages",
    emailMessageRecipients: "email_message_recipients",
    emailAttachments: "email_attachments",
  });
  const views: ReadonlySessionViewNames = {
    agentSessions,
    threads,
    messages,
    messagesRaw,
    toolResults,
    inputs,
    runs,
    agentPrompts,
    agentPairings,
    agentSkills,
    agentTelepathyDevices,
    scheduledTasks,
    scheduledTaskRuns,
    watches,
    watchRuns,
    watchEvents,
    emailAccounts,
    emailAllowedRecipients,
    emailMessages,
    emailMessageRecipients,
    emailAttachments,
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
  const sessionScopeSql = `t.session_id = current_setting('runtime.session_id', true)`;
  const activeSessionSql = `
    SELECT *
    FROM ${sessionTables.sessions}
    WHERE id = current_setting('runtime.session_id', true)
    LIMIT 1
  `;

  await options.queryable.query(`
    CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(RUNTIME_SCHEMA)};
    CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SESSION_SCHEMA)};

    DROP VIEW IF EXISTS ${views.watchEvents};
    DROP VIEW IF EXISTS ${views.watchRuns};
    DROP VIEW IF EXISTS ${views.watches};
    DROP VIEW IF EXISTS ${views.emailAttachments};
    DROP VIEW IF EXISTS ${views.emailMessageRecipients};
    DROP VIEW IF EXISTS ${views.emailMessages};
    DROP VIEW IF EXISTS ${views.emailAllowedRecipients};
    DROP VIEW IF EXISTS ${views.emailAccounts};
    DROP VIEW IF EXISTS ${views.agentTelepathyDevices};
    DROP VIEW IF EXISTS ${views.agentPairings};
    DROP VIEW IF EXISTS ${views.agentPrompts};
    DROP VIEW IF EXISTS ${views.agentSkills};
    DROP VIEW IF EXISTS ${views.scheduledTaskRuns};
    DROP VIEW IF EXISTS ${views.scheduledTasks};
    DROP VIEW IF EXISTS ${views.toolResults};
    DROP VIEW IF EXISTS ${views.messages};
    DROP VIEW IF EXISTS ${views.messagesRaw};
    DROP VIEW IF EXISTS ${views.inputs};
    DROP VIEW IF EXISTS ${views.runs};
    DROP VIEW IF EXISTS ${views.threads};
    DROP VIEW IF EXISTS ${views.agentSessions};

    CREATE VIEW ${views.agentSessions}
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

    CREATE VIEW ${views.agentPrompts}
    WITH (security_barrier = true) AS
    SELECT
      prompt.agent_key,
      prompt.slug,
      prompt.content,
      octet_length(convert_to(prompt.content, 'utf8'))::INTEGER AS content_bytes,
      prompt.created_at,
      prompt.updated_at
    FROM ${agentTables.agentPrompts} AS prompt
    WHERE prompt.agent_key = current_setting('runtime.agent_key', true)
      AND prompt.slug IN ('agent', 'heartbeat');

    CREATE VIEW ${views.agentPairings}
    WITH (security_barrier = true) AS
    SELECT
      pairing.agent_key,
      pairing.identity_id,
      identity_row.handle AS identity_handle,
      pairing.metadata,
      pairing.created_at,
      pairing.updated_at
    FROM ${agentTables.agentPairings} AS pairing
    INNER JOIN ${identityTables.identities} AS identity_row ON identity_row.id = pairing.identity_id
    WHERE pairing.agent_key = current_setting('runtime.agent_key', true);

    CREATE VIEW ${views.agentSkills}
    WITH (security_barrier = true) AS
    SELECT
      skill.agent_key,
      skill.skill_key,
      skill.description,
      skill.content,
      skill.last_loaded_at,
      COALESCE(skill.load_count, 0) AS load_count,
      octet_length(convert_to(skill.content, 'utf8'))::INTEGER AS content_bytes,
      skill.created_at,
      skill.updated_at
    FROM ${agentTables.agentSkills} AS skill
    WHERE skill.agent_key = current_setting('runtime.agent_key', true)
      AND (
        COALESCE(current_setting('runtime.skill_policy', true), 'all_agent') = 'all_agent'
        OR (
          current_setting('runtime.skill_policy', true) = 'allowlist'
          AND STRPOS(',' || COALESCE(current_setting('runtime.skill_allowlist', true), '') || ',', ',' || skill.skill_key || ',') > 0
        )
      );

    CREATE VIEW ${views.agentTelepathyDevices}
    WITH (security_barrier = true) AS
    SELECT
      device.agent_key,
      device.device_id,
      device.label,
      device.connected,
      (device.disabled_at IS NULL) AS enabled,
      device.connected_at,
      device.last_seen_at,
      device.last_disconnected_at,
      device.created_at,
      device.updated_at
    FROM ${telepathyTables.devices} AS device
    WHERE device.agent_key = current_setting('runtime.agent_key', true);

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
      run.scheduled_for,
      run.status,
      run.thread_run_id,
      run.error,
      run.created_at,
      run.started_at,
      run.finished_at
    FROM ${scheduledTaskTables.scheduledTaskRuns} AS run
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = run.created_by_identity_id
    WHERE run.session_id = current_setting('runtime.session_id', true);

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
    WHERE run.session_id = current_setting('runtime.session_id', true);

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
    WHERE event.session_id = current_setting('runtime.session_id', true);

    CREATE VIEW ${views.emailAccounts}
    WITH (security_barrier = true) AS
    SELECT
      account.agent_key,
      account.account_key,
      account.from_address,
      account.from_name,
      account.mailboxes,
      account.enabled,
      account.created_at,
      account.updated_at
    FROM ${emailTables.emailAccounts} AS account
    WHERE account.agent_key = current_setting('runtime.agent_key', true);

    CREATE VIEW ${views.emailAllowedRecipients}
    WITH (security_barrier = true) AS
    SELECT
      recipient.agent_key,
      recipient.account_key,
      recipient.address,
      recipient.created_at
    FROM ${emailTables.emailAllowedRecipients} AS recipient
    WHERE recipient.agent_key = current_setting('runtime.agent_key', true);

    CREATE VIEW ${views.emailMessages}
    WITH (security_barrier = true) AS
    SELECT
      message.id,
      message.agent_key,
      message.account_key,
      message.direction,
      message.mailbox,
      message.uid,
      message.message_id_header,
      message.in_reply_to,
      message.references_header,
      message.thread_key,
      message.subject,
      message.from_name,
      message.from_address,
      message.reply_to_address,
      message.sent_at,
      message.received_at,
      message.body_text,
      message.body_excerpt,
      message.authentication_results,
      message.auth_spf,
      message.auth_dkim,
      message.auth_dmarc,
      message.auth_summary,
      message.has_attachments,
      message.source_delivery_id,
      message.created_at
    FROM ${emailTables.emailMessages} AS message
    WHERE message.agent_key = current_setting('runtime.agent_key', true);

    CREATE VIEW ${views.emailMessageRecipients}
    WITH (security_barrier = true) AS
    SELECT
      recipient.id,
      recipient.message_id,
      message.agent_key,
      message.account_key,
      recipient.role,
      recipient.address,
      recipient.name,
      recipient.created_at
    FROM ${emailTables.emailMessageRecipients} AS recipient
    INNER JOIN ${emailTables.emailMessages} AS message ON message.id = recipient.message_id
    WHERE message.agent_key = current_setting('runtime.agent_key', true);

    CREATE VIEW ${views.emailAttachments}
    WITH (security_barrier = true) AS
    SELECT
      attachment.id,
      attachment.message_id,
      message.agent_key,
      message.account_key,
      attachment.filename,
      attachment.mime_type,
      attachment.size_bytes,
      attachment.local_path,
      attachment.content_id,
      attachment.created_at
    FROM ${emailTables.emailAttachments} AS attachment
    INNER JOIN ${emailTables.emailMessages} AS message ON message.id = attachment.message_id
    WHERE message.agent_key = current_setting('runtime.agent_key', true);
  `);

  if (options.readonlyRole) {
    const readonlyRole = quoteIdentifier(options.readonlyRole);
    await options.queryable.query(`
      GRANT USAGE ON SCHEMA ${quoteIdentifier(SESSION_SCHEMA)} TO ${readonlyRole};
      GRANT SELECT ON ${views.agentSessions}, ${views.threads}, ${views.messages}, ${views.messagesRaw}, ${views.toolResults}, ${views.inputs}, ${views.runs}, ${views.agentPrompts}, ${views.agentPairings}, ${views.agentSkills}, ${views.agentTelepathyDevices}, ${views.scheduledTasks}, ${views.scheduledTaskRuns}, ${views.watches}, ${views.watchRuns}, ${views.watchEvents}, ${views.emailAccounts}, ${views.emailAllowedRecipients}, ${views.emailMessages}, ${views.emailMessageRecipients}, ${views.emailAttachments} TO ${readonlyRole};
    `);
  }

  return views;
}
