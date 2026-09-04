import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {buildChannelActionTableNames} from "../channels/actions/postgres-shared.js";
import {buildOutboundDeliveryTableNames} from "../channels/deliveries/postgres-shared.js";
import {buildConnectorAccountTableNames} from "../connectors/postgres-shared.js";
import {buildGatewayTableNames} from "../gateway/postgres-shared.js";
import {buildScheduledTaskTableNames} from "../scheduling/tasks/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import type {ControlPaginatedResponse, ControlTableInput} from "./operator-service.js";

const threadTables = buildThreadRuntimeTableNames();
const sessionTables = buildSessionTableNames();
const scheduledTables = buildScheduledTaskTableNames();
const deliveryTables = buildOutboundDeliveryTableNames();
const actionTables = buildChannelActionTableNames();
const gatewayTables = buildGatewayTableNames();
const connectorTables = buildConnectorAccountTableNames();

export type ControlWorkFailureKind =
  | "runtime_run"
  | "scheduled_task_run"
  | "outbound_delivery"
  | "channel_action"
  | "gateway_event"
  | "gateway_device_command"
  | "connector_account";

export interface ControlWorkFailureTableInput extends ControlTableInput {
  severity?: "warning" | "critical";
  kind?: ControlWorkFailureKind;
}

export interface ControlWorkFailureRow {
  id: string;
  kind: ControlWorkFailureKind;
  severity: "warning" | "critical";
  agentKey: string;
  sessionId?: string;
  sessionLabel?: string;
  source: string;
  summary: string;
  detail?: string;
  targetRoute: string;
  createdAt: string;
}

export interface ControlWorkFailureSnapshot extends ControlPaginatedResponse<ControlWorkFailureRow> {
  counts: {total: number; critical: number; warning: number};
}

const columns = ["id", "kind", "severity", "agentKey", "sessionId", "sessionLabel", "source", "summary", "detail", "targetRoute", "createdAt"] as const;

/** Count, search and page one authorized snapshot using only public failure metadata. */
export async function readControlWorkFailures(
  pool: PgPoolLike,
  agentKeys: readonly string[],
  input: ControlWorkFailureTableInput = {},
): Promise<ControlWorkFailureSnapshot> {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const perPage = Math.max(1, Math.min(100, Math.trunc(input.perPage ?? 25)));
  const empty = {data: [], meta: {current_page: page, last_page: 1, total: 0, per_page: perPage}, counts: {total: 0, critical: 0, warning: 0}};
  if (agentKeys.length === 0) return empty;
  const client = await pool.connect().catch((cause: unknown) => {
    throw new Error("Work failure snapshot could not be read.", {cause});
  });
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const kinds: ControlWorkFailureKind[] = input.kind ? [input.kind] : [
      "runtime_run", "scheduled_task_run", "outbound_delivery", "channel_action", "gateway_event", "gateway_device_command", "connector_account",
    ];
    const optionalTables: Partial<Record<ControlWorkFailureKind, string>> = {
      outbound_delivery: deliveryTables.outboundDeliveries,
      channel_action: actionTables.channelActions,
      gateway_event: gatewayTables.sources,
      gateway_device_command: gatewayTables.sources,
    };
    const requiredOptionalTables = [...new Set(kinds.flatMap((kind) => optionalTables[kind] ? [optionalTables[kind]!] : []))];
    const available = await existingTables(client, requiredOptionalTables);
    const sources = kinds.filter((kind) => !optionalTables[kind] || available.has(optionalTables[kind]!)).map(failureSource);
    if (sources.length === 0) {
      await client.query("COMMIT");
      return empty;
    }
    const sortBy = columns.find((column) => column === input.sortBy) ?? "createdAt";
    const order = `lower(COALESCE("${sortBy}", '')) COLLATE "C" ${input.sortDirection === "asc" ? "ASC" : "DESC"}, id COLLATE "C" ASC`;
    const search = columns.map((column) => `strpos(lower(COALESCE("${column}", '')), $2) > 0`).join(" OR ");
    const result = await client.query(`
      WITH failures AS (
        ${sources.join("\nUNION ALL\n")}
      ), public_failures AS (
        SELECT id, kind, severity, agent_key AS "agentKey", session_id AS "sessionId", session_label AS "sessionLabel",
          source, summary, detail,
          '/agents/' || ${uriComponent("agent_key")} ||
            CASE WHEN route_session AND session_id IS NOT NULL THEN '/sessions/' || ${uriComponent("session_id")} ELSE '' END || route_tab AS "targetRoute",
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
        FROM failures
      ), matching AS MATERIALIZED (
        SELECT * FROM public_failures WHERE $2 = '' OR (${search})
      ), counts AS (
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE severity = 'critical')::int AS critical,
          count(*) FILTER (WHERE severity = 'warning')::int AS warning,
          count(*) FILTER (WHERE $3::text IS NULL OR severity = $3)::int AS table_total
        FROM matching
      ), page AS (
        SELECT * FROM matching
        WHERE $3::text IS NULL OR severity = $3
        ORDER BY ${order} LIMIT $4 OFFSET $5
      )
      SELECT counts.*, COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(to_jsonb(page)) ORDER BY ${order}) FROM page), '[]'::jsonb) AS data
      FROM counts
    `, [agentKeys, input.search?.trim().toLowerCase() ?? "", input.severity ?? null, perPage, (page - 1) * perPage]);
    const row = result.rows[0] as {total: number; critical: number; warning: number; table_total: number; data: ControlWorkFailureRow[]};
    await client.query("COMMIT");
    return {
      data: row.data,
      meta: {current_page: page, last_page: Math.max(1, Math.ceil(row.table_total / perPage)), total: row.table_total, per_page: perPage},
      counts: {total: row.total, critical: row.critical, warning: row.warning},
    };
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error("Work failure snapshot could not be read.", {cause});
  } finally {
    client.release();
  }
}

async function existingTables(client: PgQueryable, relations: readonly string[]): Promise<Set<string>> {
  if (relations.length === 0) return new Set();
  const names = relations.map((relation) => relation.replaceAll('"', '').split('.'));
  const result = await client.query(`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = ANY($2::text[])
  `, [names[0]![0], names.map((name) => name[1])]);
  const found = new Set((result.rows as Array<{table_schema: string; table_name: string}>).map((row) => `${row.table_schema}.${row.table_name}`));
  return new Set(relations.filter((relation) => found.has(relation.replaceAll('"', ''))));
}

// Match encodeURIComponent so searches use precisely the public route, including non-ASCII session ids.
function uriComponent(expression: string): string {
  return `(SELECT COALESCE(string_agg(CASE WHEN char ~ '^[A-Za-z0-9_.!~*''()-]$' THEN char
    ELSE upper(regexp_replace(encode(convert_to(char, 'UTF8'), 'hex'), '([a-f0-9]{2})', '%\\1', 'g')) END, '' ORDER BY ordinal), '')
    FROM regexp_split_to_table(${expression}, '') WITH ORDINALITY AS chars(char, ordinal))`;
}

function failureSource(kind: ControlWorkFailureKind): string {
  const session = 'target_session.agent_key, target_session.id AS session_id, COALESCE(target_session.display_name, target_session.alias, target_session.id) AS session_label';
  const scopedSession = 'target_session.agent_key = ANY($1::text[])';
  switch (kind) {
    case "runtime_run": return `
      SELECT 'runtime:' || run.id::text AS id, 'runtime_run'::text AS kind, 'critical'::text AS severity, ${session},
        'Runtime'::text AS source, COALESCE(run.error_summary, 'Agent run failed.') AS summary,
        CASE WHEN run.error_summary IS NOT NULL THEN 'Sanitized runtime error: ' || run.error_summary END AS detail,
        true AS route_session, '?tab=runtime'::text AS route_tab, COALESCE(run.finished_at, run.started_at) AS created_at
      FROM ${threadTables.runs} AS run
      INNER JOIN ${threadTables.threads} AS target_thread ON target_thread.id = run.thread_id
      INNER JOIN ${sessionTables.sessions} AS target_session ON target_session.id = target_thread.session_id
      WHERE run.status = 'failed' AND ${scopedSession}`;
    case "scheduled_task_run": return `
      SELECT 'scheduled:' || run.id::text AS id, 'scheduled_task_run'::text AS kind, 'warning'::text AS severity, ${session},
        'Scheduled task'::text AS source, 'Scheduled task failed' || CASE WHEN task.title IS NULL THEN '.' ELSE ': ' || task.title END AS summary,
        CASE WHEN run.error IS NOT NULL AND run.error <> '' THEN 'Scheduled task run failed; inspect the automations tab for sanitized run details.' END AS detail,
        true AS route_session, '?tab=automations'::text AS route_tab, run.created_at
      FROM ${scheduledTables.scheduledTaskRuns} AS run
      INNER JOIN ${sessionTables.sessions} AS target_session ON target_session.id = run.session_id
      LEFT JOIN ${scheduledTables.scheduledTasks} AS task ON task.id = run.task_id
      WHERE run.status = 'failed' AND ${scopedSession}`;
    case "outbound_delivery": return `
      SELECT 'outbound:' || delivery.id::text AS id, 'outbound_delivery'::text AS kind, 'warning'::text AS severity, ${session},
        delivery.channel || '/' || delivery.connector_key AS source,
        CASE WHEN delivery.status = 'unknown' THEN 'Outbound delivery outcome is unknown.' ELSE 'Outbound delivery failed.' END AS summary,
        CASE WHEN delivery.status = 'unknown' THEN 'The external send may have completed. Verify the destination before sending again.'
          WHEN delivery.last_error IS NOT NULL AND delivery.last_error <> '' THEN 'Outbound delivery failed; inspect the channel worker logs for details.' END AS detail,
        true AS route_session, '?tab=runtime'::text AS route_tab, delivery.created_at
      FROM ${deliveryTables.outboundDeliveries} AS delivery
      INNER JOIN ${sessionTables.sessions} AS target_session ON target_session.id = delivery.session_id
      WHERE delivery.status IN ('failed', 'unknown') AND ${scopedSession}`;
    case "channel_action": return `
      SELECT 'channel-action:' || action.id::text AS id, 'channel_action'::text AS kind, 'warning'::text AS severity, ${session},
        action.channel || '/' || action.connector_key AS source, 'Channel action outcome is unknown.'::text AS summary,
        'The external action may have completed. Verify the destination before trying again.'::text AS detail,
        true AS route_session, '?tab=runtime'::text AS route_tab, action.created_at
      FROM ${actionTables.channelActions} AS action
      INNER JOIN ${sessionTables.sessions} AS target_session ON target_session.id = action.session_id
      WHERE action.status = 'unknown' AND ${scopedSession}`;
    case "gateway_event": return `
      SELECT 'gateway-event:' || event.id::text AS id, 'gateway_event'::text AS kind, 'warning'::text AS severity,
        source.agent_key, source.session_id, CASE WHEN source.session_id IS NOT NULL THEN COALESCE(target_session.display_name, target_session.alias, source.session_id) END AS session_label,
        'Gateway ' || event.source_id AS source, 'Gateway event quarantined: ' || event.event_type || '.' AS summary,
        left(event.reason, 120) AS detail, true AS route_session, '?tab=gateway'::text AS route_tab, event.created_at
      FROM ${gatewayTables.events} AS event
      INNER JOIN ${gatewayTables.sources} AS source ON source.source_id = event.source_id
      LEFT JOIN ${sessionTables.sessions} AS target_session ON target_session.id = source.session_id
      WHERE event.status = 'quarantined' AND source.agent_key = ANY($1::text[])`;
    case "gateway_device_command": return `
      SELECT 'gateway-command:' || command.id::text AS id, 'gateway_device_command'::text AS kind, 'warning'::text AS severity,
        source.agent_key, source.session_id, CASE WHEN source.session_id IS NOT NULL THEN COALESCE(target_session.display_name, target_session.alias, source.session_id) END AS session_label,
        'Gateway ' || command.source_id || '/' || command.device_id AS source, 'Gateway device command failed: ' || command.kind || '.' AS summary,
        CASE WHEN command.error IS NOT NULL AND command.error <> '' THEN 'Gateway command failed; inspect gateway device logs for details.' END AS detail,
        false AS route_session, '?tab=gateway'::text AS route_tab, command.created_at
      FROM ${gatewayTables.commands} AS command
      INNER JOIN ${gatewayTables.sources} AS source ON source.source_id = command.source_id
      LEFT JOIN ${sessionTables.sessions} AS target_session ON target_session.id = source.session_id
      WHERE command.status IN ('failed', 'timed_out', 'rejected') AND source.agent_key = ANY($1::text[])`;
    case "connector_account": return `
      SELECT 'connector:' || account.id::text AS id, 'connector_account'::text AS kind, 'warning'::text AS severity,
        account.owner_agent_key AS agent_key, NULL::text AS session_id, NULL::text AS session_label,
        account.source || '/' || account.connector_key AS source, 'Connector account is in error: ' || COALESCE(account.display_name, account.account_key) || '.' AS summary,
        NULL::text AS detail, false AS route_session, '?tab=connectors'::text AS route_tab, account.updated_at AS created_at
      FROM ${connectorTables.connectorAccounts} AS account
      WHERE account.status = 'error' AND account.owner_kind = 'agent' AND account.owner_agent_key = ANY($1::text[])`;
  }
}
