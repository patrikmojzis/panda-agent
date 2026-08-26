import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_REFRESH_ARCHIVED_SESSION_VIEW} from "../../../integrations/postgres/schema-versions/0010-refresh-archived-session-view.js";

/** Refreshes the readonly session view after the archive column and legacy reconciliation both exist. */
export const REFRESH_ARCHIVED_SESSION_VIEW_MIGRATION: PostgresMigration = {
  ...PANDA_REFRESH_ARCHIVED_SESSION_VIEW,
  apply: async ({queryable}) => {
    await queryable.query(`
      CREATE OR REPLACE VIEW "session"."agent_sessions"
      WITH (security_barrier = true) AS
      SELECT
        session.id,
        session.agent_key,
        session.kind,
        session.current_thread_id,
        session.created_by_identity_id,
        creator.handle AS created_by_identity_handle,
        session.alias,
        session.display_name,
        session.metadata,
        session.created_at,
        session.updated_at,
        session.archived_at
      FROM "runtime"."agent_sessions" AS session
      LEFT JOIN "runtime"."identities" AS creator
        ON creator.id = session.created_by_identity_id
      WHERE session.id = current_setting('runtime.session_id', true)
      LIMIT 1
    `);
  },
};
